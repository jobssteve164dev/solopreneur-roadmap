import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CsvStore } from './db/csvStore';
import { readTodayReview } from './dailyReview';
import { IntelligenceConversationStore } from './intelligenceChat';
import { createIntelligenceMcpSession } from './intelligenceMcp';
import { runtimeProjectMcpSource, RuntimeDataOperations } from './runtimeDataOperations';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { readProjectRegistry, refreshProjectRegistry } from './projectRegistry';
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

export function startTelegramBackgroundRuntime(globalDataPath: string, operation?: RuntimeDataOperations): { close(): Promise<void> } {
  const call = (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
  const statePath = telegramRuntimePath(globalDataPath, 'telegram-state.json');
  let state: TelegramRuntimeState = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { tokenHash: '', offset: 0, bindingGeneration: 0, conversationIds: {} };
  let signature = '';
  let synchronizing = false;
  let serviceGeneration = 0;
  let closed = false;
  const engines = new Set<EmbeddedPiAgentEngine>();
  let sending: Promise<void> | undefined;
  async function sendOutbox(): Promise<void> {
    if (sending) return sending;
    if (closed) return;
    sending = (async () => {
      let cursor: { createdAt: number; id: string } | null = null;
      do {
        const page = await call('list_notification_deliveries', { channel: 'telegram', ...(cursor ? { cursor } : {}) }) as { items: Array<{ id: string; revision: number; payload: { replyGeneration: number; chatId: string; text: string; parseMode?: 'HTML' } }>; nextCursor: { createdAt: number; id: string } | null };
        for (const delivery of page.items) {
          if (closed) return;
          const message = delivery.payload;
          const config = readTelegramRuntimeConfig(globalDataPath);
          const settle = (state: string, extra: Record<string, unknown> = {}) => call('settle_notification_delivery', { id: delivery.id, expectedRevision: delivery.revision, state, ...extra, idempotencyKey: `notification:${delivery.id}:${delivery.revision}:${state}` });
          if (message.replyGeneration !== config.replyGeneration || message.chatId !== config.chatId) {
            await settle('cancelled');
            continue;
          }
          if (!config.enabled || !config.botToken) return;
          let response: unknown;
          try {
            response = await observeLocalDiagnosticStage('telegram.delivery', () => callTelegramApi(config.botToken, 'sendMessage', {
              chat_id: message.chatId, text: message.text, ...(message.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {})
            }));
          } catch (error) {
            recordLocalDiagnosticError(globalDataPath, 'telegram.delivery', classifyDiagnosticFailure(error));
            if (!(error instanceof Error) || !/HTTP 400:/.test(error.message)) return;
            if (message.parseMode === 'HTML') {
              const plain = { replyGeneration: message.replyGeneration, chatId: message.chatId, text: message.text.replace(/<[^>]*>/g, '')
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') };
              await settle('queued', { payload: plain, error: error.message });
            } else await settle('failed', { error: error.message });
            continue;
          }
          await settle('delivered', { response });
        }
        cursor = page.nextCursor;
      } while (cursor && !closed);
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
    await refreshProjectRegistry(globalDataPath, undefined, call);
    const config = readCognitiveRuntimeConfig(globalDataPath);
    if (config.mode !== 'agent_cli') throw new Error('请在 SoloMap 设置中选择用于聊天的 Agent。');
    const engine = new EmbeddedPiAgentEngine({ agentCli: config.agentCli, model: config.model,
      configRevision: config.revision, workingDirectory: path.join(globalDataPath, 'runtime', 'cognitive-work') });
    engines.add(engine);
    const projectForChat = selectedProject();
    const dataSource = await runtimeProjectMcpSource(globalDataPath, projectForChat?.path || '');
    const mcp = await observeLocalDiagnosticStage('mcp.connect', () => createIntelligenceMcpSession({
      getProjects: async () => { await refreshProjectRegistry(globalDataPath, undefined, call); return projects(); },
      getSelectedProjectPath: () => projectForChat?.path || '',
      getCurrentSteps: () => projectForChat ? new CsvStore(path.join(projectForChat.path, '.solopreneur', 'roadmap.csv')).readNodes().map(node => ({ title: node.title, status: node.status })) : null,
      getSettings: () => {
        const cognitive = readCognitiveRuntimeConfig(globalDataPath);
        return { language: readTelegramRuntimeConfig(globalDataPath).language, cognitiveAgent: cognitive.agentCli, cognitiveModel: cognitive.model };
      },
      getTodayReview: async () => {
        await refreshProjectRegistry(globalDataPath, undefined, call);
        const review = readTodayReview(globalDataPath, projects());
        return review ? { summary: review.summary, items: review.todos.map(todo => todo.title) } : null;
      }
    }, dataSource));
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
      // Accepted work belongs to this service generation until its result is delivered.
      serviceGeneration++;
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
      const acceptedGeneration = serviceGeneration;
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
            await refreshProjectRegistry(globalDataPath, undefined, call);
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
          if (closed || acceptedGeneration !== serviceGeneration) return;
          const filePath = path.join(inboxDirectory, `${update.update_id}.json`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        },
        getBindingGeneration: () => readTelegramRuntimeConfig(globalDataPath).replyGeneration,
        async sendReply(chatId: string, text: string) {
          const current = readTelegramRuntimeConfig(globalDataPath);
          if (!current.enabled || current.botToken !== config.botToken || current.chatId !== chatId) return;
          await queueTelegramBackgroundNotification(globalDataPath, text, undefined, undefined, operation);
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
  return { async close() {
    closed = true;
    clearInterval(timer);
    stopTelegramRemoteService();
    engines.forEach(engine => engine.cancel());
    await sending;
  } };
}
