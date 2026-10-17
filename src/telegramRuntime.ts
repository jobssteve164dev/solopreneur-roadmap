import * as crypto from 'crypto';
import * as path from 'path';
import { CsvStore } from './db/csvStore';
import { readTodayReviewFromDatabase } from './dailyReview';
import { IntelligenceConversationStore } from './intelligenceChat';
import { createIntelligenceMcpSession } from './intelligenceMcp';
import { buildIntelligenceProjectContext, IntelligenceReadToolSource, readIntelligenceCurrentSteps } from './intelligenceReadTools';
import { runtimeProjectMcpSource, RuntimeDataOperations } from './runtimeDataOperations';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { readProjectRegistry, refreshProjectRegistry } from './projectRegistry';
import { createTelegramIntelligenceReply } from './telegramIntelligenceChat';
import { executeTelegramExtensionCommand } from './telegramExtensionBridge';
import { persistTelegramRuntimeConfig, queueTelegramBackgroundNotification, readTelegramRuntimeConfig, refreshTelegramRuntimeConfig } from './telegramRuntimeConfig';
import { callTelegramApi, drainTelegramReplies, handleTelegramUpdate, startTelegramRemoteService, suspendTelegramRemotePolling, TelegramHost, TelegramUpdate, stopTelegramRemoteService } from './telegramService';
import { classifyDiagnosticFailure, observeLocalDiagnosticStage, recordLocalDiagnosticError } from './localDiagnostics';
import { readProcessBirthMarker } from './processIdentity.js';
import { claimTelegramChannelLease, requestTelegramChannelTakeover, TelegramChannelLease } from './telegramChannelLease';
import { countTelegramHostPresence, withTelegramHostPresenceLock } from './telegramHostPresence';
import { setIntelligenceTimeScheduleInDatabase } from './intelligenceTimeSchedule';

interface TelegramRuntimeState {
  offset: number;
  bindingGeneration: number;
  conversationIds: Record<string, string>;
}

export function startTelegramBackgroundRuntime(globalDataPath: string, operation?: RuntimeDataOperations): { close(): Promise<void> } {
  const call = (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
  let state: TelegramRuntimeState = { offset: 0, bindingGeneration: 0, conversationIds: {} };
  let signature = '';
  let synchronizing = false;
  let serviceGeneration = 0;
  let closed = false;
  let channelLease: TelegramChannelLease | null = null;
  let handoffPending = false;
  const engines = new Set<EmbeddedPiAgentEngine>();
  const inboxClaims = new Map<string, { sourceId: number; token: string; generation: number }>();
  const inboxClaimKey = (generation: number, sourceId: number) => `${generation}:${sourceId}`;
  const inboxOwner = { id: `telegram:${process.pid}`, pid: process.pid, birth: readProcessBirthMarker(process.pid) || `pid:${process.pid}` };
  let activeHost: TelegramHost | undefined;
  let sending: Promise<void> | undefined;
  let scheduledAutomationWakePending = false;
  let nextScheduledAutomationWakeAt = 0;
  async function wakeScheduledAutomation(force = false): Promise<void> {
    if (!scheduledAutomationWakePending || (!force && Date.now() < nextScheduledAutomationWakeAt)) return;
    nextScheduledAutomationWakeAt = Date.now() + 30_000;
    try {
      const refreshed = await executeTelegramExtensionCommand(globalDataPath, 'solopreneur.internalRefreshTimedAutomation', []);
      if (refreshed === true) scheduledAutomationWakePending = false;
    } catch {
      // The durable ledger remains pending until an editor endpoint is available.
    }
  }
  async function sendOutbox(duringHandoff = false): Promise<void> {
    if (sending) return sending;
    if (closed || (handoffPending && !duringHandoff) || !channelLease) return;
    const sendingLease = channelLease;
    sending = (async () => {
      const initialConfig = await refreshTelegramRuntimeConfig(globalDataPath, operation);
      const initialSignature = JSON.stringify([initialConfig.enabled, initialConfig.botToken, initialConfig.chatId, initialConfig.bindingGeneration, initialConfig.replyGeneration]);
      if (signature !== initialSignature) return;
      let retryImmediately = false;
      do {
        retryImmediately = false;
        let cursor: { createdAt: number; id: string } | null = null;
        do {
        const page = await call('list_notification_deliveries', { channel: 'telegram', ...(cursor ? { cursor } : {}) }) as { items: Array<{ id: string; revision: number; payload: { replyGeneration: number; chatId: string; text: string; parseMode?: 'HTML'; audience?: 'requester' } }>; nextCursor: { createdAt: number; id: string } | null };
        for (const delivery of page.items) {
          if (closed || (handoffPending && !duringHandoff) || channelLease !== sendingLease) return;
          const message = delivery.payload;
          const config = await refreshTelegramRuntimeConfig(globalDataPath, operation);
          let attemptToken = '';
          const settle = (state: string, extra: Record<string, unknown> = {}) => call('settle_notification_delivery', { id: delivery.id, expectedRevision: delivery.revision, state, ...extra, ...(attemptToken ? { attemptToken } : {}), idempotencyKey: `notification:${delivery.id}:${delivery.revision}:${state}` });
          if (message.replyGeneration !== config.replyGeneration || (message.audience !== 'requester' && message.chatId !== config.chatId)) {
            await settle('cancelled');
            continue;
          }
          if (!config.enabled || !config.botToken) return;
          const attempt = await call('begin_notification_delivery', {
            id: delivery.id,
            expectedRevision: delivery.revision,
            idempotencyKey: `notification:${delivery.id}:${delivery.revision}:begin`
          }) as { token: string };
          attemptToken = attempt.token;
          let response: unknown;
          try {
            response = await observeLocalDiagnosticStage('telegram.delivery', () => callTelegramApi(config.botToken, 'sendMessage', {
              chat_id: message.chatId, text: message.text, ...(message.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {})
            }));
          } catch (error) {
            recordLocalDiagnosticError(globalDataPath, 'telegram.delivery', classifyDiagnosticFailure(error));
            const errorMessage = error instanceof Error ? error.message : String(error);
            const status = /HTTP (\d+)/.exec(errorMessage)?.[1];
            if (!status) return;
            if (status === '400' && message.parseMode === 'HTML') {
              const plain = { replyGeneration: message.replyGeneration, chatId: message.chatId, ...(message.audience ? { audience: message.audience } : {}), text: message.text.replace(/<[^>]*>/g, '')
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') };
              await settle('queued', { payload: plain, error: errorMessage });
              retryImmediately = true;
              break;
            } else if (Number(status) >= 500 || status === '429') await settle('queued', { error: errorMessage });
            else await settle('failed', { error: errorMessage });
            continue;
          }
          await settle('delivered', { response });
        }
        cursor = page.nextCursor;
        } while (cursor && !closed && !retryImmediately);
      } while (retryImmediately && !closed);
    })().finally(() => { sending = undefined; });
    return sending;
  }
  const saveOffset = () => persistTelegramRuntimeConfig(globalDataPath, { offset: state.offset }, operation);
  const saveConversationIds = () => persistTelegramRuntimeConfig(globalDataPath, { conversationIds: state.conversationIds }, operation);
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
    await refreshCognitiveRuntimeConfig(globalDataPath, operation);
    const config = readCognitiveRuntimeConfig(globalDataPath);
    if (config.mode !== 'agent_cli') throw new Error('请在 SoloMap 设置中选择用于聊天的 Agent。');
    const engine = new EmbeddedPiAgentEngine({ agentCli: config.agentCli, model: config.model,
      configRevision: config.revision, workingDirectory: globalDataPath });
    const projectForChat = selectedProject();
    const intelligenceSource: IntelligenceReadToolSource = {
      getProjects: async () => { await refreshProjectRegistry(globalDataPath, undefined, call); return projects(); },
      getSelectedProjectPath: () => projectForChat?.path || '',
      getCurrentSteps: async () => {
        if (!projectForChat) return null;
        return readIntelligenceCurrentSteps(projectForChat.path, call);
      },
      getSettings: () => {
        const cognitive = readCognitiveRuntimeConfig(globalDataPath);
        return { language: readTelegramRuntimeConfig(globalDataPath).language, cognitiveAgent: cognitive.agentCli, cognitiveModel: cognitive.model };
      },
      getTodayReview: async () => {
        await refreshProjectRegistry(globalDataPath, undefined, call);
        const review = await readTodayReviewFromDatabase(globalDataPath, projects(), operation);
        return review ? { summary: review.summary, items: review.todos.map(todo => todo.title) } : null;
      }
    };
    const projectContext = await buildIntelligenceProjectContext(intelligenceSource);
    const dataSource = await runtimeProjectMcpSource(globalDataPath, projectForChat?.path || '');
    const mcp = await observeLocalDiagnosticStage('mcp.connect', () => createIntelligenceMcpSession(intelligenceSource, dataSource, {
      setTimeSchedule: input => {
        if (!projectForChat) throw new Error('请先在 SoloMap 中选择要安排任务的项目。');
        return setIntelligenceTimeScheduleInDatabase(globalDataPath, projectForChat, input, call).then(async result => {
          scheduledAutomationWakePending = true;
          await wakeScheduledAutomation(true);
          return result;
        });
      }
    }));
    engines.add(engine);
    try { return await observeLocalDiagnosticStage('pi.chat', () => engine.chat(messages, projectContext, mcp.client)); }
    finally { engines.delete(engine); await observeLocalDiagnosticStage('mcp.close', () => mcp.close()); }
  });
  const reply = createTelegramIntelligenceReply(() => store, () => {
    const current = readTelegramRuntimeConfig(globalDataPath);
    if (state.bindingGeneration !== current.bindingGeneration) {
      state.bindingGeneration = current.bindingGeneration;
      state.conversationIds = { ...current.conversationIds };
    }
    return state.conversationIds;
  },
    async ids => { state.conversationIds = ids; await saveConversationIds(); }, () => readTelegramRuntimeConfig(globalDataPath).replyGeneration);
  async function reconcileUnknownActions(config: Awaited<ReturnType<typeof refreshTelegramRuntimeConfig>>): Promise<void> {
    const result = await call('reconcile_unknown_inbox_actions', { channel: 'telegram', recoveryGeneration: config.replyGeneration }) as { items: Array<{ sourceId: string; action: string; state: string }> };
    if (result.items.length) await sendOutbox();
  }
  async function synchronize(): Promise<void> {
    if (closed || synchronizing) return;
    synchronizing = true;
    try {
      let config = await refreshTelegramRuntimeConfig(globalDataPath, operation);
      await reconcileUnknownActions(config);
      let nextSignature = JSON.stringify([config.enabled, config.botToken, config.chatId, config.bindingGeneration, config.replyGeneration]);
      const currentLease = channelLease;
      const takeover = currentLease?.takeTakeoverRequest();
      if (currentLease && takeover && path.resolve(takeover.globalDataPath) !== path.resolve(globalDataPath)) {
        const released = await withTelegramHostPresenceLock(globalDataPath, async () => {
          if (countTelegramHostPresence(globalDataPath) > 0) return false;
          handoffPending = true;
          try {
            suspendTelegramRemotePolling();
            const drained = drainTelegramReplies();
            await drained;
            await sendOutbox(true);
            await sending;
            const remaining = await call('list_notification_deliveries', { channel: 'telegram' }) as { items: unknown[] };
            if (remaining.items.length) {
              handoffPending = false;
              signature = '';
              startTelegramRemoteService(activeHost!, reply, globalDataPath);
              return false;
            }
            stopTelegramRemoteService(); activeHost = undefined;
            await persistTelegramRuntimeConfig(globalDataPath, { enabled: false }, operation);
            if (!currentLease.release()) {
              handoffPending = false;
              signature = '';
              return false;
            }
            channelLease = null; signature = '';
            return true;
          } catch (error) {
            handoffPending = false;
            signature = '';
            if (activeHost) startTelegramRemoteService(activeHost, reply, globalDataPath);
            throw error;
          }
        });
        if (released) return;
      }
      const tokenHash = config.botToken ? crypto.createHash('sha256').update(config.botToken).digest('hex') : '';
      if (channelLease && (!config.enabled || channelLease.tokenHash !== tokenHash)) {
        handoffPending = true;
        await sending;
        stopTelegramRemoteService(); activeHost = undefined;
        if (channelLease.release()) channelLease = null;
        signature = '';
        handoffPending = false;
        if (channelLease) return;
      }
      if (config.enabled && config.botToken && !channelLease) {
        channelLease = claimTelegramChannelLease(config.botToken, globalDataPath);
        if (!channelLease) {
          requestTelegramChannelTakeover(config.botToken, globalDataPath);
          if (activeHost) { stopTelegramRemoteService(); activeHost = undefined; }
          signature = '';
          return;
        }
      }
      if (signature === nextSignature) {
        if (activeHost && config.enabled && config.botToken) {
          const pending = await call('claim_inbox_messages', { channel: 'telegram', generation: config.replyGeneration, owner: inboxOwner, limit: 100 }) as { items: Array<{ sourceId: string; payload: TelegramUpdate; token: string }> };
          for (const item of pending.items) {
            const sourceId = Number(item.sourceId);
            const claimKey = inboxClaimKey(config.replyGeneration, sourceId);
            if (inboxClaims.has(claimKey)) continue;
            inboxClaims.set(claimKey, { sourceId, token: item.token, generation: config.replyGeneration }); state.offset = Math.max(state.offset, item.payload.update_id + 1);
            void handleTelegramUpdate(activeHost, item.payload).catch(error => recordLocalDiagnosticError(globalDataPath, 'telegram.replay', classifyDiagnosticFailure(error)));
          }
          if (pending.items.length) await saveOffset();
        }
        return;
      }
      // Accepted work belongs to this service generation until its result is delivered.
      serviceGeneration++;
      const drained = drainTelegramReplies();
      stopTelegramRemoteService();
      activeHost = undefined;
      engines.forEach(engine => engine.cancel());
      await drained;
      const replacementConfig = await refreshTelegramRuntimeConfig(globalDataPath, operation);
      for (const [claimKey, claim] of inboxClaims) {
        await call('release_inbox_message', { channel: 'telegram', sourceId: String(claim.sourceId), generation: claim.generation, recoveryGeneration: replacementConfig.replyGeneration, token: claim.token, idempotencyKey: `telegram-inbox-revoke:${claim.generation}:${serviceGeneration}:${claim.sourceId}` });
        inboxClaims.delete(claimKey);
      }
      if (closed) return;
      config = replacementConfig;
      nextSignature = JSON.stringify([config.enabled, config.botToken, config.chatId, config.bindingGeneration, config.replyGeneration]);
      if (!config.enabled || !config.botToken) { signature = nextSignature; return; }
      if (state.bindingGeneration !== config.bindingGeneration) {
        // A changed authorization must not reconnect an old conversation.
        state = { offset: config.offset, bindingGeneration: config.bindingGeneration, conversationIds: { ...config.conversationIds } };
      } else {
        state.offset = Math.max(state.offset, config.offset);
        state.conversationIds = { ...config.conversationIds };
      }
      const pending = await call('claim_inbox_messages', { channel: 'telegram', generation: config.replyGeneration, owner: inboxOwner, limit: 100 }) as { items: Array<{ sourceId: string; payload: TelegramUpdate; token: string }> };
      const pendingUpdates = pending.items.map(item => {
        const sourceId = Number(item.sourceId);
        inboxClaims.set(inboxClaimKey(config.replyGeneration, sourceId), { sourceId, token: item.token, generation: config.replyGeneration });
        state.offset = Math.max(state.offset, item.payload.update_id + 1);
        return item.payload;
      });
      await saveOffset();
      const acceptedGeneration = serviceGeneration;
      const acceptedReplyGeneration = config.replyGeneration;
      const host: TelegramHost = {
        getSettings() {
          const current = readTelegramRuntimeConfig(globalDataPath);
          return { telegramEnabled: current.enabled, telegramBotToken: current.botToken, telegramChatId: current.chatId };
        },
        async authorizeChat(username: string, chatId: string) {
          return await executeTelegramExtensionCommand(globalDataPath, 'authorizeChat', [username, chatId, String(config.bindingGeneration)]) === true;
        },
        async bindChat(chatId: string, acceptedOffset = 0) {
          if (readTelegramRuntimeConfig(globalDataPath).bindingGeneration !== config.bindingGeneration) throw new Error('Telegram 绑定请求已失效。');
          // Commit acceptance before changing the binding generation so a synchronizer
          // cannot restart at the old offset and execute this update again.
          state.offset = Math.max(state.offset, acceptedOffset);
          await saveOffset();
          await executeTelegramExtensionCommand(globalDataPath, 'bindChat', [chatId, String(config.bindingGeneration)]);
          await persistTelegramRuntimeConfig(globalDataPath, { chatId }, operation);
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
        async saveOffset(offset: number) {
          state.offset = Math.max(state.offset, offset); await saveOffset();
        },
        async acceptChatUpdate(update: TelegramUpdate) {
          const generation = (await refreshTelegramRuntimeConfig(globalDataPath, operation)).replyGeneration;
          const accepted = await call('accept_inbox_message', { channel: 'telegram', sourceId: String(update.update_id), generation, payload: update, idempotencyKey: `telegram-inbox:${generation}:${update.update_id}` }) as { state: string };
          if (accepted.state === 'acknowledged') return false;
          // A superseded poller may observe the first update of the new generation.
          // Persist it for the new owner, but do not execute it under the old authorization.
          if (generation !== acceptedReplyGeneration) return false;
          const claimKey = inboxClaimKey(acceptedReplyGeneration, update.update_id);
          if (inboxClaims.has(claimKey)) return true;
          const claimed = await call('claim_inbox_messages', { channel: 'telegram', generation, sourceId: String(update.update_id), owner: inboxOwner, limit: 1 }) as { items: Array<{ token: string }> };
          if (claimed.items[0]) inboxClaims.set(claimKey, { sourceId: update.update_id, token: claimed.items[0].token, generation: acceptedReplyGeneration });
          return Boolean(claimed.items[0]);
        },
        async finishChatUpdate(update: TelegramUpdate) {
          // A service stop retains accepted work for the next owner of the same lease.
          if (closed || acceptedGeneration !== serviceGeneration) return;
          const claimKey = inboxClaimKey(acceptedReplyGeneration, update.update_id);
          const claim = inboxClaims.get(claimKey);
          if (!claim) return;
          await call('acknowledge_inbox_message', { channel: 'telegram', sourceId: String(update.update_id), generation: claim.generation, token: claim.token, idempotencyKey: `telegram-inbox-ack:${claim.generation}:${update.update_id}` });
          inboxClaims.delete(claimKey);
        },
        async releaseChatUpdate(update: TelegramUpdate) {
          const claimKey = inboxClaimKey(acceptedReplyGeneration, update.update_id);
          const claim = inboxClaims.get(claimKey);
          if (!claim) return;
          await call('release_inbox_message', { channel: 'telegram', sourceId: String(update.update_id), generation: claim.generation, recoveryGeneration: readTelegramRuntimeConfig(globalDataPath).replyGeneration, token: claim.token, idempotencyKey: `telegram-inbox-action-release:${claim.generation}:${update.update_id}` });
          inboxClaims.delete(claimKey);
        },
        async beginChatAction(update: TelegramUpdate, action: string) {
          const claim = inboxClaims.get(inboxClaimKey(acceptedReplyGeneration, update.update_id));
          if (!claim) throw new Error('telegram_inbox_claim_missing');
          await call('begin_inbox_action', { channel: 'telegram', sourceId: String(update.update_id), generation: claim.generation, token: claim.token, action, idempotencyKey: `telegram-inbox-action:${claim.generation}:${update.update_id}:${action}` });
        },
        async confirmChatAction(update: TelegramUpdate, action: string) {
          const claim = inboxClaims.get(inboxClaimKey(acceptedReplyGeneration, update.update_id));
          if (!claim) throw new Error('telegram_inbox_claim_missing');
          await call('settle_inbox_action', { channel: 'telegram', sourceId: String(update.update_id), generation: claim.generation, token: claim.token, action, state: 'confirmed', idempotencyKey: `telegram-inbox-action-confirm:${claim.generation}:${update.update_id}:${action}` });
        },
        getBindingGeneration: () => readTelegramRuntimeConfig(globalDataPath).replyGeneration,
        async sendReply(chatId: string, text: string, options) {
          const current = await refreshTelegramRuntimeConfig(globalDataPath, operation);
          if (!current.enabled || current.botToken !== config.botToken || (options?.audience !== 'requester' && current.chatId !== chatId)) return;
          const intentId = options?.intentId ? `telegram-generation:${current.replyGeneration}:${options.intentId}` : undefined;
          await queueTelegramBackgroundNotification(globalDataPath, text, options?.parseMode, intentId, operation, { chatId, audience: options?.audience, reuseExisting: Boolean(options?.intentId) });
          await sendOutbox();
        }
      };
      activeHost = host;
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
    void wakeScheduledAutomation();
  }, 1000);
  return { async close() {
    closed = true;
    handoffPending = true;
    clearInterval(timer);
    stopTelegramRemoteService();
    activeHost = undefined;
    engines.forEach(engine => engine.cancel());
    await sending;
    if (channelLease) {
      for (let attempt = 0; attempt < 3 && channelLease; attempt++) {
        if (channelLease.release()) channelLease = null;
        else await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (channelLease) throw new Error('telegram_channel_lease_release_failed');
    }
    for (const [claimKey, claim] of inboxClaims) {
      await call('release_inbox_message', { channel: 'telegram', sourceId: String(claim.sourceId), generation: claim.generation, token: claim.token, idempotencyKey: `telegram-inbox-release:${claim.generation}:${process.pid}:${claim.sourceId}` });
      inboxClaims.delete(claimKey);
    }
  } };
}
