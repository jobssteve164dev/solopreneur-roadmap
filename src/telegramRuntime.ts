import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CsvStore } from './db/csvStore';
import { readTodayReview } from './dailyReview';
import { IntelligenceConversationStore } from './intelligenceChat';
import { createIntelligenceMcpSession } from './intelligenceMcp';
import { readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { readProjectRegistry } from './projectRegistry';
import { createTelegramIntelligenceReply } from './telegramIntelligenceChat';
import { executeTelegramExtensionCommand } from './telegramExtensionBridge';
import { queueTelegramBackgroundNotification, readTelegramRuntimeConfig, telegramRuntimePath, writeTelegramRuntimeConfig, writeTelegramRuntimeJson } from './telegramRuntimeConfig';
import { callTelegramApi, drainTelegramReplies, handleTelegramUpdate, startTelegramRemoteService, TelegramHost, TelegramUpdate, stopTelegramRemoteService } from './telegramService';
import { classifyDiagnosticFailure, observeLocalDiagnosticStage, recordLocalDiagnosticError } from './localDiagnostics';

interface TelegramRuntimeState {
  tokenHash: string;
  offset: number;
  bindingGeneration: number;
  conversationIds: Record<string, string>;
}

export function startTelegramBackgroundRuntime(globalDataPath: string): { close(): void } {
  const statePath = telegramRuntimePath(globalDataPath, 'telegram-state.json');
  let state: TelegramRuntimeState = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { tokenHash: '', offset: 0, bindingGeneration: 0, conversationIds: {} };
  let signature = '';
  let synchronizing = false;
  let closed = false;
  const engines = new Set<EmbeddedPiAgentEngine>();
  let sending: Promise<void> | undefined;
  async function sendOutbox(): Promise<void> {
    if (sending) return sending;
    const directory = telegramRuntimePath(globalDataPath, 'telegram-outbox');
    if (closed || !fs.existsSync(directory)) return;
    sending = (async () => {
      for (const name of fs.readdirSync(directory).filter(name => /^\d+-[0-9a-f-]{36}\.json$/.test(name)).sort()) {
        if (closed) return;
        const filePath = path.join(directory, name);
        const message = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const config = readTelegramRuntimeConfig(globalDataPath);
        if (message.replyGeneration !== config.replyGeneration || message.chatId !== config.chatId) {
          fs.unlinkSync(filePath);
          continue;
        }
        if (!config.enabled || !config.botToken) return;
        try {
          await observeLocalDiagnosticStage('telegram.delivery', () => callTelegramApi(config.botToken, 'sendMessage', {
            chat_id: message.chatId, text: message.text, ...(message.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {})
          }));
          fs.unlinkSync(filePath);
        } catch (error) {
          recordLocalDiagnosticError(globalDataPath, 'telegram.delivery', classifyDiagnosticFailure(error));
          if (!(error instanceof Error) || !/HTTP 400:/.test(error.message)) return;
          // Preserve the content when Telegram rejects notification formatting.
          if (message.parseMode === 'HTML') {
            delete message.parseMode;
            message.text = String(message.text).replace(/<[^>]*>/g, '')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
            writeTelegramRuntimeJson(filePath, message);
          } else {
            const failedPath = telegramRuntimePath(globalDataPath, `telegram-failed/${name}`);
            fs.mkdirSync(path.dirname(failedPath), { recursive: true, mode: 0o700 });
            fs.renameSync(filePath, failedPath);
          }
          // A permanent content failure must not block unrelated replies.
        }
      }
    })().finally(() => { sending = undefined; });
    return sending;
  }
  const saveState = () => writeTelegramRuntimeJson(statePath, state);
  const projects = () => {
    const registry = readProjectRegistry(globalDataPath, 'projects.json');
    return (registry?.projects || []).filter(project => !registry?.hiddenProjects.includes(project.path));
  };
  const selectedProject = () => projects().find(project => project.path === readTelegramRuntimeConfig(globalDataPath).selectedProjectPath);
  const nodes = () => {
    const project = selectedProject();
    return project ? new CsvStore(path.join(project.path, '.solopreneur', 'roadmap.csv')).readNodes() : [];
  };
  const store = new IntelligenceConversationStore(globalDataPath, async messages => {
    const config = readCognitiveRuntimeConfig(globalDataPath);
    if (config.mode !== 'agent_cli') throw new Error('请在 SoloMap 设置中选择用于聊天的 Agent。');
    const engine = new EmbeddedPiAgentEngine({ agentCli: config.agentCli, model: config.model,
      configRevision: config.revision, workingDirectory: path.join(globalDataPath, 'runtime', 'cognitive-work') });
    engines.add(engine);
    const mcp = await observeLocalDiagnosticStage('mcp.connect', () => createIntelligenceMcpSession({
      getProjects: projects,
      getSelectedProjectPath: () => selectedProject()?.path || '',
      getCurrentSteps: () => selectedProject() ? nodes().map(node => ({ title: node.title, status: node.status })) : null,
      getSettings: () => {
        const cognitive = readCognitiveRuntimeConfig(globalDataPath);
        return { language: readTelegramRuntimeConfig(globalDataPath).language, cognitiveAgent: cognitive.agentCli, cognitiveModel: cognitive.model };
      },
      getTodayReview: () => {
        const review = readTodayReview(globalDataPath, projects());
        return review ? { summary: review.summary, items: review.todos.map(todo => todo.title) } : null;
      }
    }));
    try { return await observeLocalDiagnosticStage('pi.chat', () => engine.chat(messages, { selectedProject: '', projects: [] }, mcp.client)); }
    finally { engines.delete(engine); await observeLocalDiagnosticStage('mcp.close', () => mcp.close()); }
  });
  const reply = createTelegramIntelligenceReply(() => store, () => {
    const current = readTelegramRuntimeConfig(globalDataPath);
    if (state.bindingGeneration !== current.bindingGeneration) {
      state.bindingGeneration = current.bindingGeneration;
      state.conversationIds = { ...current.conversationIds };
      saveState();
    }
    return state.conversationIds;
  },
    async ids => { state.conversationIds = ids; saveState(); }, () => readTelegramRuntimeConfig(globalDataPath).replyGeneration);
  async function synchronize(): Promise<void> {
    if (closed || synchronizing) return;
    synchronizing = true;
    try {
      let config = readTelegramRuntimeConfig(globalDataPath);
      let nextSignature = JSON.stringify([config.enabled, config.botToken, config.chatId, config.bindingGeneration]);
      if (signature === nextSignature) return;
      const drained = drainTelegramReplies();
      stopTelegramRemoteService();
      engines.forEach(engine => engine.cancel());
      await drained;
      if (closed) return;
      config = readTelegramRuntimeConfig(globalDataPath);
      nextSignature = JSON.stringify([config.enabled, config.botToken, config.chatId, config.bindingGeneration]);
      if (!config.enabled || !config.botToken) { signature = nextSignature; return; }
      const tokenHash = crypto.createHash('sha256').update(config.botToken).digest('hex');
      if (state.tokenHash !== tokenHash) {
        state = { tokenHash, offset: 0, bindingGeneration: config.bindingGeneration, conversationIds: { ...config.conversationIds } };
      } else if (state.bindingGeneration !== config.bindingGeneration) {
        // A changed authorization must not reconnect an old conversation.
        state.bindingGeneration = config.bindingGeneration;
        state.conversationIds = { ...config.conversationIds };
      }
      const inboxDirectory = telegramRuntimePath(globalDataPath, 'telegram-inbox');
      const pendingUpdates: TelegramUpdate[] = [];
      if (fs.existsSync(inboxDirectory)) {
        for (const name of fs.readdirSync(inboxDirectory).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]))) {
          const filePath = path.join(inboxDirectory, name);
          const pending = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (pending.tokenHash === tokenHash) state.offset = Math.max(state.offset, pending.update.update_id + 1);
          if (pending.tokenHash === tokenHash && pending.replyGeneration === config.replyGeneration) pendingUpdates.push(pending.update);
          else fs.unlinkSync(filePath);
        }
      }
      saveState();
      const host: TelegramHost = {
        getSettings() {
          const current = readTelegramRuntimeConfig(globalDataPath);
          return { telegramEnabled: current.enabled, telegramBotToken: current.botToken, telegramChatId: current.chatId };
        },
        async authorizeChat(username: string, chatId: string) {
          return await executeTelegramExtensionCommand(globalDataPath, 'authorizeChat', [username, chatId, String(config.bindingGeneration)]) === true;
        },
        async bindChat(chatId: string) {
          if (readTelegramRuntimeConfig(globalDataPath).bindingGeneration !== config.bindingGeneration) throw new Error('Telegram 绑定请求已失效。');
          await executeTelegramExtensionCommand(globalDataPath, 'bindChat', [chatId, String(config.bindingGeneration)]);
          writeTelegramRuntimeConfig(globalDataPath, { chatId });
        },
        async executeCommand(command: string, ...args: string[]) {
          if (command !== 'solopreneur.internalGetStatus') return executeTelegramExtensionCommand(globalDataPath, command, args);
          try { return await executeTelegramExtensionCommand(globalDataPath, command, args); }
          catch {
            const project = selectedProject();
            if (!project) return { activeProject: false };
            const steps = nodes();
            const active = steps.find(node => ['Running', 'In Progress'].includes(node.status)) || steps.find(node => node.status === 'Failed');
            return { activeProject: true, name: project.name, path: project.path,
              progressPercent: steps.length ? Math.round(steps.filter(node => node.status === 'Completed').length / steps.length * 100) : 0,
              currentStep: active?.title || '无', currentStepStatus: active?.status || 'Pending', activeNodeId: active?.id || null, recentExecutions: [] };
          }
        },
        offset: state.offset,
        saveOffset(offset: number) {
          if (state.tokenHash === tokenHash) { state.offset = Math.max(state.offset, offset); saveState(); }
        },
        acceptChatUpdate(update: TelegramUpdate) {
          writeTelegramRuntimeJson(path.join(inboxDirectory, `${update.update_id}.json`), {
            tokenHash, replyGeneration: readTelegramRuntimeConfig(globalDataPath).replyGeneration, update
          });
        },
        finishChatUpdate(update: TelegramUpdate) {
          // A service stop retains accepted work for the next owner of the same lease.
          if (closed) return;
          const filePath = path.join(inboxDirectory, `${update.update_id}.json`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        },
        getBindingGeneration: () => readTelegramRuntimeConfig(globalDataPath).replyGeneration,
        async sendReply(chatId: string, text: string) {
          const current = readTelegramRuntimeConfig(globalDataPath);
          if (!current.enabled || current.botToken !== config.botToken || current.chatId !== chatId) return;
          queueTelegramBackgroundNotification(globalDataPath, text);
          await sendOutbox();
        }
      };
      startTelegramRemoteService(host, reply, globalDataPath);
      for (const update of pendingUpdates) void handleTelegramUpdate(host, update)
        .catch(error => recordLocalDiagnosticError(globalDataPath, 'telegram.replay', classifyDiagnosticFailure(error)));
      signature = nextSignature;
    } catch (error) { recordLocalDiagnosticError(globalDataPath, 'telegram.runtime', classifyDiagnosticFailure(error)); }
    finally { synchronizing = false; }
  }
  void synchronize();
  const timer = setInterval(() => {
    void synchronize();
    void sendOutbox().catch(error => recordLocalDiagnosticError(globalDataPath, 'telegram.delivery', classifyDiagnosticFailure(error)));
  }, 1000);
  return { close() {
    closed = true;
    clearInterval(timer);
    stopTelegramRemoteService();
    engines.forEach(engine => engine.cancel());
  } };
}
