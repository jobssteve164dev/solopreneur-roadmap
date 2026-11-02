import * as crypto from 'crypto';

import { readTodayReviewFromDatabase } from './dailyReview';
import type { PiConversationAcceptance, PiConversationIngress, PiConversationOperation, PiExecutionOwner } from './db/unifiedDataStore';
import type { IntelligencePersistence } from './intelligencePersistence';
import { createIntelligenceMcpSession } from './intelligenceMcp';
import { buildIntelligenceProjectContext, IntelligenceReadToolSource, readIntelligenceCurrentSteps } from './intelligenceReadTools';
import { EmbeddedPiAgentEngine, prepareNativeIntelligenceExecution } from './piAgentEngine';
import { readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { readProjectRegistry, refreshProjectRegistry } from './projectRegistry';
import { runtimeProjectMcpSource } from './runtimeDataOperations';
import type { RuntimeDataOperations } from './runtimeDataOperations';
import type { UnifiedMcpSource } from './unifiedMcp';
import { readTelegramRuntimeConfig } from './telegramRuntimeConfig';
import type { IntelligenceAcceptanceReceipt, IntelligenceCommitGuard, IntelligenceConversation, IntelligenceMessage } from './intelligenceChat';
import type { CognitiveCliRunner } from './localAgentCliEngine';
import { createLocalDiagnosticTrace, withLocalDiagnosticTrace } from './localDiagnostics';

export interface IntelligenceCognitiveRunner {
  runner: CognitiveCliRunner;
  cancel(): void;
}

interface PreparedRuntimeContext {
  projectPath: string;
  projectContext: Awaited<ReturnType<typeof buildIntelligenceProjectContext>>;
  mcp: Awaited<ReturnType<typeof createIntelligenceMcpSession>>;
}

export class IntelligenceRuntime {
  private readonly owner: PiExecutionOwner;
  private readonly executionMode: 'legacy' | 'harness';
  private readonly active = new Map<string, { engine: EmbeddedPiAgentEngine; promise: Promise<IntelligenceConversation> }>();
  private readonly submissions = new Map<string, { identity: string; promise: Promise<IntelligenceConversation> }>();
  private readonly conversationLanes = new Map<string, Promise<void>>();
  private readonly backgroundMaintenance = new Set<Promise<void>>();
  private readonly executionWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private readonly retryWaiters = new Set<{ operationId: string; wake(): void }>();
  private activeExecutionSlots = 0;
  private recoveryRequested = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryTimerAt = 0;
  private recoveryPromise: Promise<{ recovered: number; failed: number }> | undefined;
  private closePromise: Promise<void> | undefined;
  private drainPromise: Promise<void> | undefined;
  private draining = false;
  private closed = false;

  private constructor(
    private readonly globalDataPath: string,
    private readonly persistence: IntelligencePersistence,
    private readonly operations: RuntimeDataOperations,
    private readonly cognitiveRunnerFactory: (() => IntelligenceCognitiveRunner) | undefined,
    owner: PiExecutionOwner,
    mode: 'legacy' | 'harness'
  ) {
    this.owner = owner;
    this.executionMode = mode;
  }

  static async create(globalDataPath: string, persistence: IntelligencePersistence, operations: RuntimeDataOperations,
    runtimeId: string, releaseVersion: string, buildId: string,
    cognitiveRunnerFactory?: () => IntelligenceCognitiveRunner): Promise<IntelligenceRuntime> {
    const initialized = await persistence.initialize(runtimeId, releaseVersion, buildId);
    return new IntelligenceRuntime(globalDataPath, persistence, operations, cognitiveRunnerFactory, initialized.owner, initialized.mode);
  }

  public mode(): { mode: 'legacy' | 'harness' } { return { mode: this.executionMode }; }

  private async withExecutionSlot<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (this.activeExecutionSlots < 2 && this.executionWaiters.length === 0) this.activeExecutionSlots++;
    else await new Promise<void>((resolve, reject) => this.executionWaiters.push({ resolve, reject }));
    try { return await action(); }
    finally {
      const waiter = this.executionWaiters.shift();
      if (waiter) waiter.resolve();
      else this.activeExecutionSlots = Math.max(0, this.activeExecutionSlots - 1);
    }
  }

  private scheduleRecovery(delayMs = 0): void {
    if (this.closed || this.draining) return;
    if (delayMs <= 0) {
      this.recoveryRequested = true;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
      this.recoveryTimerAt = 0;
      void this.recover().catch(() => undefined);
      return;
    }
    const target = Date.now() + delayMs;
    if (this.recoveryTimer && this.recoveryTimerAt <= target) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimerAt = target;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryTimerAt = 0;
      this.recoveryRequested = true;
      if (!this.closed) void this.recover().catch(() => undefined);
    }, Math.max(1, target - Date.now()));
    this.recoveryTimer.unref();
  }

  private async waitForRetry(retryAt: number, operationId: string): Promise<void> {
    if (this.draining) throw new Error('intelligence_runtime_draining');
    const delay = retryAt - Date.now();
    if (delay <= 0) return;
    await new Promise<void>(resolve => {
      let settled = false;
      const waiter = { operationId, wake: () => {} };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.retryWaiters.delete(waiter);
        resolve();
      };
      waiter.wake = finish;
      const timer = setTimeout(finish, delay);
      timer.unref();
      this.retryWaiters.add(waiter);
    });
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (this.draining) throw new Error('intelligence_runtime_draining');
  }

  private scheduleRetention(conversationId: string): void {
    const action = this.persistence.maintainRetention(conversationId, this.owner).catch(() => undefined);
    this.backgroundMaintenance.add(action);
    void action.finally(() => this.backgroundMaintenance.delete(action));
  }

  private async waitUntilRunnable(operation: PiConversationOperation): Promise<PiConversationOperation> {
    let current = operation;
    while (current.status === 'queued') {
      if (this.closed) throw new Error('intelligence_runtime_closed');
      await new Promise(resolve => setTimeout(resolve, 50));
      current = await this.persistence.readOperation(operation.operationId) || current;
    }
    if (current.status === 'settled') return current;
    if (!['accepted', 'running', 'completed'].includes(current.status)) throw new Error(`intelligence_operation_${current.status}`);
    return current;
  }

  private async prepare(projectPath?: string): Promise<PreparedRuntimeContext> {
    await refreshProjectRegistry(this.globalDataPath, undefined, (operation, input) => this.operations({ operation, input }));
    const registry = readProjectRegistry(this.globalDataPath, 'projects.json');
    const projects = (registry?.projects || []).filter(project => !registry?.hiddenProjects.includes(project.path));
    const selectedPath = projectPath === undefined ? String(registry?.selectedProjectPath || '') : projectPath;
    const selected = projects.find(project => project.path === selectedPath);
    const source: IntelligenceReadToolSource = {
      getProjects: async () => projects,
      getSelectedProjectPath: () => selected?.path || '',
      getCurrentSteps: async () => selected ? readIntelligenceCurrentSteps(selected.path, (operation, input) => this.operations({ operation, input })) : null,
      getSettings: () => {
        const config = readCognitiveRuntimeConfig(this.globalDataPath);
        return { language: readTelegramRuntimeConfig(this.globalDataPath).language, cognitiveAgent: config.agentCli, cognitiveModel: config.model };
      },
      getTodayReview: async () => {
        const review = await readTodayReviewFromDatabase(this.globalDataPath, projects, this.operations);
        return review ? { summary: review.summary, items: review.todos.map(todo => todo.title) } : null;
      }
    };
    const projectContext = await buildIntelligenceProjectContext(source);
    const rawDataSource = await runtimeProjectMcpSource(this.globalDataPath, selected?.path || '', undefined, request => this.operations(request));
    let activeToolFence: { operationId: string; invocationId: string; ownerId: string; ownerGeneration: number } | undefined;
    const dataSource: UnifiedMcpSource | undefined = rawDataSource ? {
      scope: rawDataSource.scope,
      globalReads: rawDataSource.globalReads,
      projectSignalsOnly: rawDataSource.projectSignalsOnly,
      close: () => rawDataSource.close?.() || Promise.resolve(),
      sessionInfo: rawDataSource.sessionInfo ? () => rawDataSource.sessionInfo!() : undefined,
      setPiToolFence(fence) { activeToolFence = fence; rawDataSource.setPiToolFence?.(fence); },
      call: (operation, input) => rawDataSource.call(operation, input)
    } : undefined;
    const mcp = await createIntelligenceMcpSession(source, dataSource, {
      setTimeSchedule: input => {
        if (!selected) throw new Error('请先在 SoloMap 中选择要安排任务的项目。');
        if (!activeToolFence) throw new Error('pi_tool_invocation_fenced');
        return this.operations({ operation: 'set_intelligence_time_schedule', input: {
          projectPath: selected.path, projectName: selected.name, ...input
        }, piToolFence: activeToolFence }) as Promise<Record<string, unknown>>;
      }
    });
    return { projectPath: selected?.path || '', projectContext, mcp };
  }

  private async execute(operation: PiConversationOperation, prepared?: PreparedRuntimeContext): Promise<IntelligenceConversation> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (operation.status === 'settled') {
      await prepared?.mcp.close();
      const durable = await this.persistence.readConversation(operation.conversationId);
      if (!durable) throw new Error('intelligence_settlement_missing');
      return durable.conversation;
    }
    if (this.draining) { await prepared?.mcp.close(); throw new Error('intelligence_runtime_draining'); }
    if (operation.status === 'completed' && operation.terminal?.status === 'completed') {
      try {
        try {
          await this.persistence.settleOperation(operation.operationId, this.owner, {
            status: 'completed', tipId: operation.terminal.tipId || null, finalAssistant: operation.terminal.finalAssistant
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'intelligence_reply_revoked') {
            await this.persistence.discardCompleted(operation.operationId, this.owner, error.message);
          }
          throw error;
        }
        return (await this.persistence.readConversation(operation.conversationId))!.conversation;
      } finally {
        await prepared?.mcp.close();
        if (!await this.persistence.promoteNext(operation.conversationId, this.owner)) {
          this.scheduleRetention(operation.conversationId);
        }
      }
    }
    let context: PreparedRuntimeContext;
    try { context = prepared || await this.prepare(operation.acceptance.projectScope); }
    catch (error) {
      if (!this.closed) await this.persistence.markOperation(operation.operationId, this.owner, { status: 'failed' }).catch(() => undefined);
      if (!await this.persistence.promoteNext(operation.conversationId, this.owner).catch(() => null)) this.scheduleRetention(operation.conversationId);
      throw error;
    }
    const agentCli = String(operation.acceptance.options.agentCli || '');
    if (!agentCli || operation.acceptance.executionProfile !== 'pi-core-0.87.1-v1') {
      await context.mcp.close();
      if (!this.closed) await this.persistence.markOperation(operation.operationId, this.owner, { status: 'failed' }).catch(() => undefined);
      if (!await this.persistence.promoteNext(operation.conversationId, this.owner).catch(() => null)) this.scheduleRetention(operation.conversationId);
      throw new Error('pi_execution_profile_unsupported');
    }
    const cognitiveRunner = this.cognitiveRunnerFactory?.();
    const engine = new EmbeddedPiAgentEngine({
      agentCli,
      model: operation.acceptance.model.modelId,
      configRevision: String(operation.acceptance.options.configRevision || 'unversioned'),
      workingDirectory: this.globalDataPath,
      ...(cognitiveRunner ? { runner: cognitiveRunner.runner, runnerCancel: cognitiveRunner.cancel } : {})
    });
    const current = await this.persistence.readConversation(operation.conversationId);
    const messages: IntelligenceMessage[] = [...(current?.conversation.messages || []), { role: 'user', content: operation.acceptance.prompt }];
    const promise = (async () => {
      try {
        await this.persistence.markOperation(operation.operationId, this.owner, { status: 'running' });
        const currentOperation = await this.persistence.readOperation(operation.operationId);
        let terminal: Awaited<ReturnType<EmbeddedPiAgentEngine['chatNative']>>;
        try { terminal = await engine.chatNative({
          sessionId: operation.sessionId, lane: operation.lane, operationId: operation.operationId,
          messages, projectContext: operation.acceptance.projectContext as PreparedRuntimeContext['projectContext'],
          systemPrompt: operation.acceptance.systemPrompt, toolSnapshot: operation.acceptance.tools,
          authorizeTool: input => this.persistence.admitToolInvocation(operation.operationId, this.owner, input),
          cancelRequested: Boolean(currentOperation?.cancelRequested),
          withToolFence: async (invocationId, action) => {
            context.mcp.setPiToolFence({ operationId: operation.operationId, invocationId, ownerId: this.owner.ownerId, ownerGeneration: this.owner.generation });
            try {
              const result = await action();
              await this.persistence.completeToolInvocation(operation.operationId, invocationId, this.owner, result);
              return result;
            }
            finally { context.mcp.setPiToolFence(undefined); }
          }
        }, await this.persistence.sessionStorage(operation.sessionId, this.owner, operation.operationId), context.mcp.client); }
        catch (error) {
          const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
          if (cause instanceof Error) {
            const wrapped = new Error(`${error instanceof Error ? error.message : 'intelligence_harness_failed'}: ${cause.message}`) as Error & { cause?: unknown };
            wrapped.cause = error;
            throw wrapped;
          }
          throw error;
        }
        if (terminal.status !== 'completed') {
          await this.persistence.markOperation(operation.operationId, this.owner, terminal);
          throw new Error(`intelligence_operation_${terminal.status}`);
        }
        const answer = String(terminal.finalAssistant || '').trim();
        if (!answer) {
          await this.persistence.markOperation(operation.operationId, this.owner, { status: 'missing_final_assistant', tipId: terminal.tipId });
          throw new Error('missing_final_assistant');
        }
        await this.persistence.markOperation(operation.operationId, this.owner, { status: 'completed', tipId: terminal.tipId, finalAssistant: answer });
        try {
          await this.persistence.settleOperation(operation.operationId, this.owner, { status: 'completed', tipId: terminal.tipId, finalAssistant: answer });
        } catch (error) {
          if (error instanceof Error && error.message === 'intelligence_reply_revoked') {
            await this.persistence.discardCompleted(operation.operationId, this.owner, error.message);
          }
          throw error;
        }
        return (await this.persistence.readConversation(operation.conversationId))!.conversation;
      } catch (error) {
        if (!this.closed) await this.persistence.markOperation(operation.operationId, this.owner, { status: 'failed' }).catch(() => undefined);
        throw error;
      } finally {
        await context.mcp.close();
        if (!await this.persistence.promoteNext(operation.conversationId, this.owner)) {
          this.scheduleRetention(operation.conversationId);
        }
      }
    })();
    this.active.set(operation.operationId, { engine, promise });
    try { return await promise; }
    finally { this.active.delete(operation.operationId); }
  }

  public async send(input: Record<string, unknown>): Promise<IntelligenceConversation> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (this.executionMode !== 'harness') throw new Error('pi_harness_cutover_pending');
    const text = String(input.text || '').trim();
    if (!text) throw new Error('Please enter a message.');
    const conversationId = String(input.conversationId || crypto.randomUUID());
    if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error('Invalid intelligence conversation ID.');
    const operationId = String(input.operationId || crypto.randomUUID());
    const requestKey = String(input.requestId || operationId);
    const commitGuard = input.commitGuard as IntelligenceCommitGuard | undefined;
    const identity = JSON.stringify([conversationId, operationId, requestKey, text, String(input.source || 'sidebar'),
      input.requireExisting === true, commitGuard?.type || null, commitGuard?.generation ?? null]);
    const existing = this.submissions.get(operationId);
    if (existing) {
      if (existing.identity !== identity) throw new Error('idempotency_conflict');
      return existing.promise;
    }
    const submission = this.sendOnce(input, text, conversationId, operationId, requestKey);
    let tracked: Promise<IntelligenceConversation>;
    tracked = submission.finally(() => {
      if (this.submissions.get(operationId)?.promise === tracked) this.submissions.delete(operationId);
    });
    this.submissions.set(operationId, { identity, promise: tracked });
    return tracked;
  }

  public async admit(input: Record<string, unknown>): Promise<IntelligenceAcceptanceReceipt> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (this.draining) throw new Error('intelligence_runtime_draining');
    if (this.executionMode !== 'harness') throw new Error('pi_harness_cutover_pending');
    const text = String(input.text || '').trim();
    if (!text) throw new Error('Please enter a message.');
    const conversationId = String(input.conversationId || crypto.randomUUID());
    if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error('Invalid intelligence conversation ID.');
    const operationId = String(input.operationId || input.requestId || crypto.randomUUID());
    const requestKey = String(input.requestId || operationId);
    const commitGuard = input.commitGuard as IntelligenceCommitGuard | undefined;
    const ingress = await this.persistence.admitIngress({
      conversationId, operationId, requestKey, text, source: String(input.source || 'sidebar'),
      sourceGeneration: Number(commitGuard?.generation || 0), requireExisting: input.requireExisting === true,
      ...(commitGuard ? { commitGuard } : {})
    }, this.owner);
    if (ingress.status !== 'cancelled') {
      this.scheduleRecovery();
    }
    return { operationId: ingress.operationId, requestId: ingress.requestKey, conversationId: ingress.conversationId,
      status: ingress.status === 'cancelled' ? 'cancelled' : 'accepted', acceptedAt: ingress.createdAt };
  }

  private async sendOnce(input: Record<string, unknown>, text: string, conversationId: string,
    operationId: string, requestKey: string): Promise<IntelligenceConversation> {
    const ingress = await this.persistence.admitIngress({
      conversationId, operationId, requestKey, text, source: String(input.source || 'sidebar'),
      sourceGeneration: Number((input.commitGuard as IntelligenceCommitGuard | undefined)?.generation || 0),
      requireExisting: input.requireExisting === true,
      ...(input.commitGuard ? { commitGuard: input.commitGuard as IntelligenceCommitGuard } : {})
    }, this.owner);
    return this.runIngress(ingress);
  }

  public async run(operationId: string): Promise<IntelligenceConversation> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (this.executionMode !== 'harness') throw new Error('pi_harness_cutover_pending');
    const ingress = await this.persistence.readIngress(operationId);
    if (!ingress) throw new Error('pi_ingress_not_found');
    if (ingress.status === 'cancelled') throw new Error('intelligence_operation_aborted');
    return this.submitIngress(ingress);
  }

  private submitIngress(ingress: PiConversationIngress): Promise<IntelligenceConversation> {
    const existing = this.submissions.get(ingress.operationId);
    if (existing) return existing.promise;
    const identity = JSON.stringify([ingress.conversationId, ingress.operationId, ingress.requestKey, ingress.text, ingress.source,
      ingress.requireExisting, ingress.commitGuard || null]);
    const submission = this.runIngress(ingress);
    let tracked: Promise<IntelligenceConversation>;
    tracked = submission.finally(() => {
      if (this.submissions.get(ingress.operationId)?.promise === tracked) this.submissions.delete(ingress.operationId);
    });
    this.submissions.set(ingress.operationId, { identity, promise: tracked });
    return tracked;
  }

  private runIngress(target: PiConversationIngress): Promise<IntelligenceConversation> {
    return this.withConversationLane(target.conversationId, async () => {
      for (;;) {
        if (this.closed) throw new Error('intelligence_runtime_closed');
        if (this.draining) throw new Error('intelligence_runtime_draining');
        const materialized = await this.persistence.listRecoverable(target.conversationId);
        if (materialized.length) {
          const operation = materialized[0];
          try {
            const result = await this.withExecutionSlot(() => this.execute(operation));
            if (operation.operationId === target.operationId) return result;
          } catch (error) {
            if (operation.operationId === target.operationId) throw error;
          }
          continue;
        }
        const pending = await this.persistence.listRecoverableIngresses(target.conversationId);
        let ingress = pending[0];
        if (!ingress) {
          const operation = await this.persistence.readOperation(target.operationId);
          if (operation) {
            if (operation.status === 'settled') {
              const durable = await this.persistence.readConversation(target.conversationId);
              if (!durable) throw new Error('intelligence_settlement_missing');
              return durable.conversation;
            }
            const runnable = await this.waitUntilRunnable(operation);
            return this.withExecutionSlot(() => this.execute(runnable));
          }
          const refreshed = await this.persistence.readIngress(target.operationId);
          if (refreshed?.status === 'cancelled') throw new Error('intelligence_operation_aborted');
          throw new Error('pi_ingress_not_found');
        }
        await this.waitForRetry(ingress.retryAt, ingress.operationId);
        const refreshedBeforeExecution = await this.persistence.readIngress(ingress.operationId);
        if (!refreshedBeforeExecution || refreshedBeforeExecution.status === 'cancelled') {
          if (ingress.operationId === target.operationId) throw new Error('intelligence_operation_aborted');
          continue;
        }
        ingress = refreshedBeforeExecution;
        await this.waitForRetry(ingress.retryAt, ingress.operationId);
        try {
          const result = await this.withExecutionSlot(() => this.executeIngress(ingress));
          if (ingress.operationId === target.operationId) return result;
        } catch (error) {
          const refreshed = await this.persistence.readIngress(ingress.operationId);
          if (refreshed?.status === 'admitted') {
            await this.waitForRetry(refreshed.retryAt, refreshed.operationId);
            continue;
          }
          if (ingress.operationId === target.operationId) throw error;
        }
      }
    });
  }

  private withConversationLane<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.conversationLanes.get(conversationId) || Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(() => undefined, () => undefined);
    this.conversationLanes.set(conversationId, tail);
    void tail.finally(() => { if (this.conversationLanes.get(conversationId) === tail) this.conversationLanes.delete(conversationId); });
    return result;
  }

  private async executeIngress(ingress: PiConversationIngress): Promise<IntelligenceConversation> {
    if (this.draining) throw new Error('intelligence_runtime_draining');
    const existingOperation = await this.persistence.readOperation(ingress.operationId);
    if (existingOperation) {
      if (existingOperation.status === 'settled') return (await this.persistence.readConversation(ingress.conversationId))!.conversation;
      return this.execute(await this.waitUntilRunnable(existingOperation));
    }
    let prepared: PreparedRuntimeContext | undefined;
    let materialized = false;
    try {
    await refreshCognitiveRuntimeConfig(this.globalDataPath, this.operations);
    const config = readCognitiveRuntimeConfig(this.globalDataPath);
    if (config.mode !== 'agent_cli') throw new Error('Choose an Agent in SoloMap settings to start a conversation.');
    prepared = await this.prepare();
    if (this.draining) { await prepared.mcp.close(); throw new Error('intelligence_runtime_draining'); }
    const native = await prepareNativeIntelligenceExecution(prepared.projectContext, prepared.mcp.client);
    const acceptance: PiConversationAcceptance = {
      schemaVersion: 1, conversationId: ingress.conversationId, operationId: ingress.operationId, requestKey: ingress.requestKey, prompt: ingress.text, attachments: [],
      baselineRevision: ingress.baselineRevision, source: ingress.source, sourceGeneration: ingress.sourceGeneration,
      projectScope: prepared.projectPath,
      systemPrompt: native.systemPrompt,
      projectContext: prepared.projectContext,
      model: { provider: 'agent-cli', modelId: config.model },
      tools: native.toolSnapshot,
      executionProfile: 'pi-core-0.87.1-v1',
      options: { agentCli: config.agentCli, configRevision: config.revision, retry: 'native', compaction: 'native', steeringMode: 'all', followUpMode: 'all', toolExecution: 'sequential' },
      ...(ingress.commitGuard ? { commitGuard: ingress.commitGuard } : {})
    };
    let operation: PiConversationOperation;
    try {
      operation = await this.persistence.materializeIngress(ingress.operationId, acceptance, this.owner);
      materialized = true;
    }
    catch (error) { await prepared.mcp.close(); prepared = undefined; throw error; }
    const running = this.active.get(operation.operationId);
    if (running) { await prepared.mcp.close(); return running.promise; }
    if (operation.status === 'settled') { await prepared.mcp.close(); return (await this.persistence.readConversation(ingress.conversationId))!.conversation; }
    let runnable: PiConversationOperation;
    try { runnable = await this.waitUntilRunnable(operation); }
    catch (error) { await prepared.mcp.close(); throw error; }
    return this.execute(runnable, prepared);
    } catch (error) {
      if (!materialized && !this.closed) {
        const retry = await this.persistence.recordIngressFailure(ingress.operationId, this.owner, error).catch(() => ({ retryAt: Date.now() + 1_000 }));
        this.scheduleRecovery(Math.max(1, retry.retryAt - Date.now()));
      }
      throw error;
    }
  }

  private async runBounded<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(2, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await action(item);
      }
    });
    await Promise.all(workers);
  }

  private async recoverPending(): Promise<{ recovered: number; failed: number }> {
    let recovered = 0, failed = 0;
    await this.persistence.promoteRecoverable(this.owner);
    const attempted = new Set<string>();
    for (;;) {
      if (this.closed || this.draining) break;
      const candidates = (await this.persistence.listRecoverable()).filter(candidate => !attempted.has(candidate.operationId));
      if (!candidates.length) break;
      await this.runBounded(candidates, async operation => {
        attempted.add(operation.operationId);
        try {
          const submitted = this.submissions.get(operation.operationId);
          if (submitted) await submitted.promise;
          else await this.withConversationLane(operation.conversationId, () => this.withExecutionSlot(() => this.execute(operation)));
          recovered++;
        }
        catch { failed++; }
      });
    }
    const attemptedIngresses = new Set<string>();
    for (;;) {
      if (this.closed || this.draining) break;
      const ingresses = (await this.persistence.listRecoverableIngresses()).filter(ingress => !attemptedIngresses.has(ingress.operationId));
      if (!ingresses.length) break;
      await this.runBounded(ingresses, async ingress => {
        attemptedIngresses.add(ingress.operationId);
        try { await this.submitIngress(ingress); recovered++; }
        catch { failed++; this.scheduleRecovery(1_000); }
      });
    }
    const nextRetryAt = await this.persistence.nextIngressRetryAt();
    if (nextRetryAt >= 0) this.scheduleRecovery(Math.max(0, nextRetryAt - Date.now()));
    return { recovered, failed };
  }

  public recover(): Promise<{ recovered: number; failed: number }> {
    if (this.closed) return Promise.reject(new Error('intelligence_runtime_closed'));
    this.recoveryRequested = true;
    if (!this.recoveryPromise) {
      const recovery = (async () => {
        let recovered = 0, failed = 0;
        do {
          this.recoveryRequested = false;
          const result = await this.recoverPending();
          recovered += result.recovered; failed += result.failed;
        } while (this.recoveryRequested && !this.closed);
        return { recovered, failed };
      })();
      const tracked = recovery.finally(() => {
        if (this.recoveryPromise === tracked) this.recoveryPromise = undefined;
        if (this.recoveryRequested && !this.closed) this.scheduleRecovery();
      });
      this.recoveryPromise = tracked;
    }
    return this.recoveryPromise;
  }

  public async cancel(input: Record<string, unknown>): Promise<{ cancelled: boolean }> {
    const operationId = String(input.operationId || '');
    const cancelled = await this.persistence.requestCancellation({
      ...(operationId ? { operationId } : {}),
      ...(input.source ? { source: String(input.source) } : {}),
      ...(input.sourceGeneration === undefined ? {} : { sourceGeneration: Number(input.sourceGeneration) })
    }, this.owner);
    for (const waiter of this.retryWaiters) if (cancelled.includes(waiter.operationId)) waiter.wake();
    for (const id of cancelled) this.active.get(id)?.engine.cancel();
    if (cancelled.length) this.scheduleRecovery(0);
    await Promise.allSettled(cancelled.map(id => this.submissions.get(id)?.promise || this.active.get(id)?.promise)
      .filter((promise): promise is Promise<IntelligenceConversation> => Boolean(promise)));
    return { cancelled: cancelled.length > 0 };
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
      this.recoveryTimerAt = 0;
      for (const waiter of this.retryWaiters) waiter.wake();
      while (this.executionWaiters.length) this.executionWaiters.shift()?.reject(new Error('intelligence_runtime_closed'));
      for (const running of this.active.values()) running.engine.cancel();
      const pending = new Set<Promise<unknown>>([...this.active.values()].map(value => value.promise));
      for (const submission of this.submissions.values()) pending.add(submission.promise);
      if (this.recoveryPromise) pending.add(this.recoveryPromise);
      for (const maintenance of this.backgroundMaintenance) pending.add(maintenance);
      this.closePromise = Promise.allSettled([...pending]).then(() => undefined);
    }
    return this.closePromise;
  }

  public drain(): Promise<void> {
    if (!this.drainPromise) {
      this.draining = true;
      this.recoveryRequested = false;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
      this.recoveryTimerAt = 0;
      for (const waiter of this.retryWaiters) waiter.wake();
      this.drainPromise = (async () => {
        for (;;) {
          const pending = new Set<Promise<unknown>>([...this.active.values()].map(value => value.promise));
          for (const submission of this.submissions.values()) pending.add(submission.promise);
          if (this.recoveryPromise) pending.add(this.recoveryPromise);
          if (!pending.size) return;
          await Promise.allSettled([...pending]);
        }
      })();
    }
    return this.drainPromise;
  }

  public async resume(): Promise<void> {
    if (this.closed) throw new Error('intelligence_runtime_closed');
    if (!this.draining) return;
    await this.drainPromise;
    this.draining = false;
    this.drainPromise = undefined;
    this.scheduleRecovery(0);
  }
}
