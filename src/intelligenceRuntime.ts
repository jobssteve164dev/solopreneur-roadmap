import * as crypto from 'crypto';

import { readTodayReviewFromDatabase } from './dailyReview';
import { PiConversationAcceptance, PiConversationOperation, PiExecutionOwner, UnifiedDataStore } from './db/unifiedDataStore';
import { createIntelligenceMcpSession } from './intelligenceMcp';
import { buildIntelligenceProjectContext, IntelligenceReadToolSource, readIntelligenceCurrentSteps } from './intelligenceReadTools';
import { EmbeddedPiAgentEngine, prepareNativeIntelligenceExecution } from './piAgentEngine';
import { readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { readProjectRegistry, refreshProjectRegistry } from './projectRegistry';
import { runtimeProjectMcpSource } from './runtimeDataOperations';
import type { RuntimeDataOperations } from './runtimeDataOperations';
import type { UnifiedMcpSource } from './unifiedMcp';
import { readTelegramRuntimeConfig } from './telegramRuntimeConfig';
import type { IntelligenceCommitGuard, IntelligenceConversation, IntelligenceMessage } from './intelligenceChat';

interface PreparedRuntimeContext {
  projectPath: string;
  projectContext: Awaited<ReturnType<typeof buildIntelligenceProjectContext>>;
  mcp: Awaited<ReturnType<typeof createIntelligenceMcpSession>>;
}

export class IntelligenceRuntime {
  private readonly owner: PiExecutionOwner;
  private readonly executionMode: 'legacy' | 'harness';
  private readonly active = new Map<string, { engine: EmbeddedPiAgentEngine; promise: Promise<IntelligenceConversation> }>();
  private recoveryPromise: Promise<{ recovered: number; failed: number }> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly globalDataPath: string,
    private readonly store: UnifiedDataStore,
    private readonly operations: RuntimeDataOperations,
    runtimeId: string,
    releaseVersion: string,
    buildId: string
  ) {
    this.owner = store.claimPiExecutionOwner(runtimeId);
    this.executionMode = store.registerPiCompatibilityRelease(releaseVersion, buildId, runtimeId).mode;
  }

  public mode(): { mode: 'legacy' | 'harness' } { return { mode: this.executionMode }; }

  private async waitUntilRunnable(operation: PiConversationOperation): Promise<PiConversationOperation> {
    let current = operation;
    while (current.status === 'queued') {
      if (this.closed) throw new Error('intelligence_runtime_closed');
      await new Promise(resolve => setTimeout(resolve, 50));
      current = this.store.readPiConversationOperation(operation.operationId) || current;
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
    const rawDataSource = await runtimeProjectMcpSource(this.globalDataPath, selected?.path || '');
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
    if (operation.status === 'completed' && operation.terminal?.status === 'completed') {
      try {
        try {
          this.store.settlePiConversationOperation(operation.operationId, this.owner, {
            status: 'completed', tipId: operation.terminal.tipId || null, finalAssistant: operation.terminal.finalAssistant
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'intelligence_reply_revoked') {
            this.store.discardCompletedPiConversationOperation(operation.operationId, this.owner, error.message);
          }
          throw error;
        }
        return this.store.readIntelligenceConversation(operation.conversationId)!.conversation;
      } finally {
        await prepared?.mcp.close();
        if (!this.store.promoteNextPiConversationOperation(operation.conversationId, this.owner)) {
          try { this.store.maintainPiExecutionRetention(operation.conversationId, this.owner); }
          catch { /* Retention is maintenance and cannot replace a settled user result. */ }
        }
      }
    }
    const context = prepared || await this.prepare(operation.acceptance.projectScope);
    const agentCli = String(operation.acceptance.options.agentCli || '');
    if (!agentCli || operation.acceptance.executionProfile !== 'pi-core-0.87.1-v1') { await context.mcp.close(); throw new Error('pi_execution_profile_unsupported'); }
    const engine = new EmbeddedPiAgentEngine({
      agentCli,
      model: operation.acceptance.model.modelId,
      configRevision: String(operation.acceptance.options.configRevision || 'unversioned'),
      workingDirectory: this.globalDataPath
    });
    const current = this.store.readIntelligenceConversation(operation.conversationId);
    const messages: IntelligenceMessage[] = [...(current?.conversation.messages || []), { role: 'user', content: operation.acceptance.prompt }];
    const promise = (async () => {
      try {
        this.store.markPiConversationOperation(operation.operationId, this.owner, { status: 'running' });
        const currentOperation = this.store.readPiConversationOperation(operation.operationId);
        const terminal = await engine.chatNative({
          sessionId: operation.sessionId, lane: operation.lane, operationId: operation.operationId,
          messages, projectContext: operation.acceptance.projectContext as PreparedRuntimeContext['projectContext'],
          systemPrompt: operation.acceptance.systemPrompt, toolSnapshot: operation.acceptance.tools,
          authorizeTool: input => { this.store.admitPiToolInvocation(operation.operationId, this.owner, input); },
          cancelRequested: Boolean(currentOperation?.cancelRequested),
          withToolFence: async (invocationId, action) => {
            context.mcp.setPiToolFence({ operationId: operation.operationId, invocationId, ownerId: this.owner.ownerId, ownerGeneration: this.owner.generation });
            try {
              const result = await action();
              this.store.completePiToolInvocation(operation.operationId, invocationId, this.owner);
              return result;
            }
            finally { context.mcp.setPiToolFence(undefined); }
          }
        }, this.store.createPiSessionStorage(operation.sessionId, this.owner), context.mcp.client);
        if (terminal.status !== 'completed') {
          this.store.markPiConversationOperation(operation.operationId, this.owner, terminal);
          throw new Error(`intelligence_operation_${terminal.status}`);
        }
        const answer = String(terminal.finalAssistant || '').trim();
        if (!answer) {
          this.store.markPiConversationOperation(operation.operationId, this.owner, { status: 'missing_final_assistant', tipId: terminal.tipId });
          throw new Error('missing_final_assistant');
        }
        this.store.markPiConversationOperation(operation.operationId, this.owner, { status: 'completed', tipId: terminal.tipId, finalAssistant: answer });
        try {
          this.store.settlePiConversationOperation(operation.operationId, this.owner, { status: 'completed', tipId: terminal.tipId, finalAssistant: answer });
        } catch (error) {
          if (error instanceof Error && error.message === 'intelligence_reply_revoked') {
            this.store.discardCompletedPiConversationOperation(operation.operationId, this.owner, error.message);
          }
          throw error;
        }
        return this.store.readIntelligenceConversation(operation.conversationId)!.conversation;
      } finally {
        await context.mcp.close();
        if (!this.store.promoteNextPiConversationOperation(operation.conversationId, this.owner)) {
          try { this.store.maintainPiExecutionRetention(operation.conversationId, this.owner); }
          catch { /* Retention is maintenance and cannot replace a settled user result. */ }
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
    const current = this.store.readIntelligenceConversation(conversationId);
    if (input.requireExisting === true && !current) throw new Error('Intelligence conversation was not found.');
    await refreshCognitiveRuntimeConfig(this.globalDataPath, this.operations);
    const config = readCognitiveRuntimeConfig(this.globalDataPath);
    if (config.mode !== 'agent_cli') throw new Error('Choose an Agent in SoloMap settings to start a conversation.');
    const prepared = await this.prepare();
    const native = await prepareNativeIntelligenceExecution(prepared.projectContext, prepared.mcp.client);
    const operationId = String(input.operationId || crypto.randomUUID());
    const requestKey = String(input.requestId || operationId);
    const acceptance: PiConversationAcceptance = {
      schemaVersion: 1, conversationId, operationId, requestKey, prompt: text, attachments: [],
      baselineRevision: current?.revision || 0, source: String(input.source || 'sidebar'), sourceGeneration: Number((input.commitGuard as IntelligenceCommitGuard | undefined)?.generation || 0),
      projectScope: prepared.projectPath,
      systemPrompt: native.systemPrompt,
      projectContext: prepared.projectContext,
      model: { provider: 'agent-cli', modelId: config.model },
      tools: native.toolSnapshot,
      executionProfile: 'pi-core-0.87.1-v1',
      options: { agentCli: config.agentCli, configRevision: config.revision, retry: 'native', compaction: 'native', steeringMode: 'all', followUpMode: 'all', toolExecution: 'sequential' },
      ...(input.commitGuard ? { commitGuard: input.commitGuard as IntelligenceCommitGuard } : {})
    };
    let operation: PiConversationOperation;
    try { operation = this.store.admitPiConversationOperation(acceptance, this.owner); }
    catch (error) { await prepared.mcp.close(); throw error; }
    const running = this.active.get(operation.operationId);
    if (running) { await prepared.mcp.close(); return running.promise; }
    if (operation.status === 'settled') { await prepared.mcp.close(); return this.store.readIntelligenceConversation(conversationId)!.conversation; }
    let runnable: PiConversationOperation;
    try { runnable = await this.waitUntilRunnable(operation); }
    catch (error) { await prepared.mcp.close(); throw error; }
    return this.execute(runnable, prepared);
  }

  private async recoverPending(): Promise<{ recovered: number; failed: number }> {
    let recovered = 0, failed = 0;
    this.store.promoteRecoverablePiConversationOperations(this.owner);
    const attempted = new Set<string>();
    for (;;) {
      if (this.closed && attempted.size) break;
      const operation = this.store.listRecoverablePiConversationOperations().find(candidate => !attempted.has(candidate.operationId));
      if (!operation) break;
      attempted.add(operation.operationId);
      try { await this.execute(operation); recovered++; }
      catch { failed++; }
    }
    return { recovered, failed };
  }

  public recover(): Promise<{ recovered: number; failed: number }> {
    if (this.closed) return Promise.reject(new Error('intelligence_runtime_closed'));
    if (!this.recoveryPromise) {
      const recovery = this.recoverPending();
      const tracked = recovery.finally(() => {
        if (this.recoveryPromise === tracked) this.recoveryPromise = undefined;
      });
      this.recoveryPromise = tracked;
    }
    return this.recoveryPromise;
  }

  public async cancel(input: Record<string, unknown>): Promise<{ cancelled: boolean }> {
    const operationId = String(input.operationId || '');
    const cancelled = this.store.requestPiConversationCancellation({
      ...(operationId ? { operationId } : {}),
      ...(input.source ? { source: String(input.source) } : {}),
      ...(input.sourceGeneration === undefined ? {} : { sourceGeneration: Number(input.sourceGeneration) })
    }, this.owner);
    for (const id of cancelled) this.active.get(id)?.engine.cancel();
    await Promise.allSettled(cancelled.map(id => this.active.get(id)?.promise).filter((promise): promise is Promise<IntelligenceConversation> => Boolean(promise)));
    return { cancelled: cancelled.length > 0 };
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      const pending: Promise<unknown>[] = [...this.active.values()].map(value => value.promise);
      if (this.recoveryPromise) pending.push(this.recoveryPromise);
      this.closePromise = Promise.allSettled(pending).then(() => undefined);
    }
    return this.closePromise;
  }
}
