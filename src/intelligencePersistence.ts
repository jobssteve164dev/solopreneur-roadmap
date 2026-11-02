import type {
  PiConversationAcceptance,
  PiConversationIngress,
  PiConversationIngressInput,
  PiConversationOperation,
  PiExecutionOwner,
  UnifiedDataStore
} from './db/unifiedDataStore';
import type { IntelligenceConversation } from './intelligenceChat';
import type { RuntimeDataRequest } from './autonomousRuntimeControl';
import type {
  PiBranchScan, PiEntry, PiEntryScan, PiEntryStructure, PiListElement, PiListReadOptions, PiSessionStats,
  PiSessionStorage, PiStoredValue, PiUsageRow, PiUsageScan, PiValue, PiValueList, PiWrite
} from './piSessionStorage';

export interface IntelligencePersistence {
  initialize(runtimeId: string, releaseVersion: string, buildId: string): Promise<{ owner: PiExecutionOwner; mode: 'legacy' | 'harness' }>;
  readConversation(conversationId: string): Promise<{ revision: number; conversation: IntelligenceConversation } | null>;
  admitIngress(input: PiConversationIngressInput, owner: PiExecutionOwner): Promise<PiConversationIngress>;
  readIngress(operationId: string): Promise<PiConversationIngress | null>;
  materializeIngress(operationId: string, acceptance: PiConversationAcceptance, owner: PiExecutionOwner): Promise<PiConversationOperation>;
  listRecoverableIngresses(conversationId?: string): Promise<PiConversationIngress[]>;
  nextIngressRetryAt(): Promise<number>;
  recordIngressFailure(operationId: string, owner: PiExecutionOwner, error: unknown): Promise<{ retryAt: number; retryCount: number }>;
  readOperation(operationId: string): Promise<PiConversationOperation | null>;
  admitOperation(acceptance: PiConversationAcceptance, owner: PiExecutionOwner): Promise<PiConversationOperation>;
  markOperation(operationId: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['markPiConversationOperation']>[2]): Promise<PiConversationOperation>;
  settleOperation(operationId: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['settlePiConversationOperation']>[2]): Promise<void>;
  discardCompleted(operationId: string, owner: PiExecutionOwner, reason: string): Promise<void>;
  promoteNext(conversationId: string, owner: PiExecutionOwner): Promise<PiConversationOperation | null>;
  maintainRetention(conversationId: string, owner: PiExecutionOwner): Promise<void>;
  promoteRecoverable(owner: PiExecutionOwner): Promise<void>;
  listRecoverable(conversationId?: string): Promise<PiConversationOperation[]>;
  requestCancellation(input: Parameters<UnifiedDataStore['requestPiConversationCancellation']>[0], owner: PiExecutionOwner): Promise<string[]>;
  admitToolInvocation(operationId: string, owner: PiExecutionOwner, input: Parameters<UnifiedDataStore['admitPiToolInvocation']>[2]): Promise<ReturnType<UnifiedDataStore['admitPiToolInvocation']>>;
  completeToolInvocation(operationId: string, invocationId: string, owner: PiExecutionOwner, result: unknown): Promise<void>;
  sessionStorage(sessionId: string, owner: PiExecutionOwner, operationId?: string): Promise<PiSessionStorage>;
}

export class LocalIntelligencePersistence implements IntelligencePersistence {
  constructor(private readonly store: UnifiedDataStore) {}

  async initialize(runtimeId: string, releaseVersion: string, buildId: string): Promise<{ owner: PiExecutionOwner; mode: 'legacy' | 'harness' }> {
    const owner = this.store.claimPiExecutionOwner(runtimeId);
    return { owner, mode: this.store.registerPiCompatibilityRelease(releaseVersion, buildId, runtimeId).mode };
  }
  async readConversation(id: string) { return this.store.readIntelligenceConversation(id); }
  async admitIngress(input: PiConversationIngressInput, owner: PiExecutionOwner) { return this.store.admitPiConversationIngress(input, owner); }
  async readIngress(id: string) { return this.store.readPiConversationIngress(id); }
  async materializeIngress(id: string, acceptance: PiConversationAcceptance, owner: PiExecutionOwner) { return this.store.materializePiConversationIngress(id, acceptance, owner); }
  async listRecoverableIngresses(conversationId?: string) { return this.store.listRecoverablePiConversationIngresses(conversationId); }
  async nextIngressRetryAt() { return this.store.nextPiConversationIngressRetryAt(); }
  async recordIngressFailure(id: string, owner: PiExecutionOwner, error: unknown) { return this.store.recordPiConversationIngressFailure(id, owner, error); }
  async readOperation(id: string) { return this.store.readPiConversationOperation(id); }
  async admitOperation(acceptance: PiConversationAcceptance, owner: PiExecutionOwner) { return this.store.admitPiConversationOperation(acceptance, owner); }
  async markOperation(id: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['markPiConversationOperation']>[2]) { return this.store.markPiConversationOperation(id, owner, terminal); }
  async settleOperation(id: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['settlePiConversationOperation']>[2]) { this.store.settlePiConversationOperation(id, owner, terminal); }
  async discardCompleted(id: string, owner: PiExecutionOwner, reason: string) { this.store.discardCompletedPiConversationOperation(id, owner, reason); }
  async promoteNext(id: string, owner: PiExecutionOwner) { return this.store.promoteNextPiConversationOperation(id, owner); }
  async maintainRetention(id: string, owner: PiExecutionOwner) { this.store.maintainPiExecutionRetention(id, owner); }
  async promoteRecoverable(owner: PiExecutionOwner) { this.store.promoteRecoverablePiConversationOperations(owner); }
  async listRecoverable(conversationId?: string) { return this.store.listRecoverablePiConversationOperations(conversationId); }
  async requestCancellation(input: Parameters<UnifiedDataStore['requestPiConversationCancellation']>[0], owner: PiExecutionOwner) { return this.store.requestPiConversationCancellation(input, owner); }
  async admitToolInvocation(id: string, owner: PiExecutionOwner, input: Parameters<UnifiedDataStore['admitPiToolInvocation']>[2]) { return this.store.admitPiToolInvocation(id, owner, input); }
  async completeToolInvocation(id: string, invocationId: string, owner: PiExecutionOwner, result: unknown) { this.store.completePiToolInvocation(id, invocationId, owner, result); }
  async sessionStorage(id: string, owner: PiExecutionOwner, operationId?: string) { return this.store.createPiSessionStorage(id, owner, operationId); }
}

export class RemoteIntelligencePersistence implements IntelligencePersistence {
  constructor(private readonly request: (request: RuntimeDataRequest) => Promise<unknown>) {}
  private call<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    return this.request({ operation, input }) as Promise<T>;
  }
  initialize(runtimeId: string, releaseVersion: string, buildId: string) {
    return this.call<{ owner: PiExecutionOwner; mode: 'legacy' | 'harness' }>('claim_pi_execution_owner', { runtimeId, releaseVersion, buildId });
  }
  readConversation(id: string) { return this.call<{ revision: number; conversation: IntelligenceConversation } | null>('read_intelligence_conversation', { id }); }
  admitIngress(input: PiConversationIngressInput, owner: PiExecutionOwner) { return this.call<PiConversationIngress>('admit_intelligence_ingress', { request: input, owner }); }
  readIngress(id: string) { return this.call<PiConversationIngress | null>('read_intelligence_ingress', { operationId: id }); }
  materializeIngress(id: string, acceptance: PiConversationAcceptance, owner: PiExecutionOwner) { return this.call<PiConversationOperation>('materialize_pi_acceptance', { operationId: id, acceptance, owner }); }
  listRecoverableIngresses(conversationId?: string) { return this.call<PiConversationIngress[]>('list_recoverable_intelligence_ingress', { ...(conversationId ? { conversationId } : {}) }); }
  nextIngressRetryAt() { return this.call<number>('next_intelligence_ingress_retry_at', {}); }
  recordIngressFailure(id: string, owner: PiExecutionOwner, error: unknown) {
    return this.call<{ retryAt: number; retryCount: number }>('record_intelligence_ingress_failure', {
      operationId: id, owner, error: String(error instanceof Error ? error.message : error)
    });
  }
  readOperation(id: string) { return this.call<PiConversationOperation | null>('read_pi_operation', { operationId: id }); }
  admitOperation(acceptance: PiConversationAcceptance, owner: PiExecutionOwner) { return this.call<PiConversationOperation>('admit_pi_operation', { acceptance, owner }); }
  markOperation(id: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['markPiConversationOperation']>[2]) { return this.call<PiConversationOperation>('mark_pi_operation', { operationId: id, owner, terminal }); }
  async settleOperation(id: string, owner: PiExecutionOwner, terminal: Parameters<UnifiedDataStore['settlePiConversationOperation']>[2]) { await this.call('settle_pi_operation', { operationId: id, owner, terminal }); }
  async discardCompleted(id: string, owner: PiExecutionOwner, reason: string) { await this.call('discard_pi_completed', { operationId: id, owner, reason }); }
  promoteNext(id: string, owner: PiExecutionOwner) { return this.call<PiConversationOperation | null>('promote_next_pi_operation', { conversationId: id, owner }); }
  async maintainRetention(id: string, owner: PiExecutionOwner) { await this.call('maintain_pi_retention', { conversationId: id, owner }); }
  async promoteRecoverable(owner: PiExecutionOwner) { await this.call('promote_recoverable_pi_operations', { owner }); }
  listRecoverable(conversationId?: string) { return this.call<PiConversationOperation[]>('list_recoverable_pi_operations', { ...(conversationId ? { conversationId } : {}) }); }
  requestCancellation(input: Parameters<UnifiedDataStore['requestPiConversationCancellation']>[0], owner: PiExecutionOwner) { return this.call<string[]>('request_pi_cancellation', { request: input, owner }); }
  admitToolInvocation(id: string, owner: PiExecutionOwner, input: Parameters<UnifiedDataStore['admitPiToolInvocation']>[2]) {
    return this.call<ReturnType<UnifiedDataStore['admitPiToolInvocation']>>('admit_pi_tool_invocation', { operationId: id, owner, invocation: input });
  }
  async completeToolInvocation(id: string, invocationId: string, owner: PiExecutionOwner, result: unknown) { await this.call('complete_pi_tool_invocation', { operationId: id, invocationId, owner, result }); }
  async sessionStorage(sessionId: string, owner: PiExecutionOwner, operationId?: string): Promise<PiSessionStorage> {
    const metadata = await this.call<PiSessionStorage['metadata']>('initialize_pi_session', { sessionId });
    const read = <T>(method: string, args: unknown[] = []) => this.call<T>('read_pi_session_storage', { sessionId, method, args });
    let closed = false;
    const open = () => { if (closed) throw new Error('pi_storage_closed'); };
    return {
      metadata,
      commit: async (writes: PiWrite[], context) => {
        open();
        const effectiveOperationId = operationId || context?.operationId;
        const result = await this.call<import('./piSessionStorage').PiCommitResult>('commit_pi_session_batch', {
          sessionId, owner, writes,
          ...(context?.commitId ? { commitId: context.commitId } : {}),
          ...(effectiveOperationId ? { operationId: effectiveOperationId } : {})
        });
        if (effectiveOperationId && result.commitId) {
          await this.call('ack_pi_session_commit', { sessionId, operationId: effectiveOperationId, commitId: result.commitId, owner });
        }
        return result;
      },
      getEntries: async (ids: string[]) => { open(); return new Map(await read<Array<[string, PiEntry]>>('getEntries', [ids])); },
      getValue: async <T>(address: PiValue<T>) => { open(); return read<PiStoredValue<T> | undefined>('getValue', [address]); },
      scanValues: async <T>(prefix: PiValue<T>) => { open(); return read<PiStoredValue<T>[]>('scanValues', [prefix]); },
      readList: async <T>(address: PiValueList<T>, options?: PiListReadOptions) => { open(); return read<PiListElement<T>[]>('readList', [address, options]); },
      scanBranch: async (query: PiBranchScan) => { open(); return read<PiEntry[]>('scanBranch', [query]); },
      scanBranchStructure: async (query: PiBranchScan) => { open(); return read<PiEntryStructure[]>('scanBranchStructure', [query]); },
      scanEntries: async (query: PiEntryScan) => { open(); return read<PiEntry[]>('scanEntries', [query]); },
      scanUsage: async (query: PiUsageScan) => { open(); return read<PiUsageRow[]>('scanUsage', [query]); },
      getStats: async () => { open(); return read<PiSessionStats>('getStats'); },
      close: async () => { closed = true; }
    };
  }
}
