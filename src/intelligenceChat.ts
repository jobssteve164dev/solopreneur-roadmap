import * as crypto from 'crypto';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import {
  createLocalDiagnosticTrace,
  getCurrentLocalDiagnosticTrace,
  observeLocalDiagnosticStage,
  withLocalDiagnosticTrace
} from './localDiagnostics';
import type { IntelligenceContextCheckpoint, StagedIntelligenceContextCheckpoint } from './intelligenceContextCheckpoint';
import { readProcessBirthMarker } from './processIdentity.js';

export interface IntelligenceMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IntelligenceConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: IntelligenceMessage[];
}

export interface IntelligenceReplyContext {
  checkpoint?: IntelligenceContextCheckpoint;
  operationId?: string;
  cutoverGeneration?: number;
  beforeTool?(input: { readOnly: boolean }): Promise<void>;
  stageCheckpoint(checkpoint: StagedIntelligenceContextCheckpoint): void;
}

export interface IntelligenceCommitGuard {
  type: 'telegram-reply-generation';
  generation: number;
}

type IntelligenceDataRequest = <T>(root: string, request: { operation: string; input: Record<string, unknown> }) => Promise<T>;

export class IntelligenceConversationStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly activeRuntimeOperations = new Set<string>();

  constructor(
    private readonly globalDataPath: string,
    private readonly reply?: (messages: IntelligenceMessage[], context: IntelligenceReplyContext) => Promise<string>,
    private readonly dataRequest: IntelligenceDataRequest = sendRuntimeDataRequest,
    private readonly runtimeRouting = false
  ) {}

  private validateId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('Invalid intelligence conversation ID.');
    }
  }

  private get databaseRoot(): string { return normalizeGlobalDataPathForExtension(this.globalDataPath); }

  get(id: string): Promise<IntelligenceConversation | null> {
    this.validateId(id);
    return this.dataRequest<{ conversation: IntelligenceConversation } | null>(this.databaseRoot, { operation: 'read_intelligence_conversation', input: { id } }).then(state => state?.conversation || null);
  }

  list(): Promise<Array<Pick<IntelligenceConversation, 'id' | 'title' | 'updatedAt'>>> {
    return this.dataRequest(this.databaseRoot, { operation: 'list_intelligence_conversations', input: {} });
  }

  async cancelAll(): Promise<void> {
    await this.dataRequest(this.databaseRoot, { operation: 'cancel_intelligence_operation', input: { source: 'telegram' } });
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
  }

  send(text: string, conversationId = '', canCommit: () => boolean = () => true, commitGuard?: IntelligenceCommitGuard): Promise<IntelligenceConversation> {
    const content = String(text || '').trim();
    if (!content) return Promise.reject(new Error('Please enter a message.'));
    const trace = getCurrentLocalDiagnosticTrace() || createLocalDiagnosticTrace(this.globalDataPath, 'sidebar.chat');
    return withLocalDiagnosticTrace(trace, () => {
      const startedAt = Date.now();
      trace.record('conversation.queue', 'start');
      const requireExisting = Boolean(conversationId);
      const id = conversationId || crypto.randomUUID();
      this.validateId(id);
      const previous = this.pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
      trace.record('conversation.queue', 'ok', Date.now() - startedAt);
      const requestId = crypto.randomUUID();
      const executionMode = this.runtimeRouting
        ? await this.dataRequest<{ mode: 'legacy' | 'harness' }>(this.databaseRoot, { operation: 'read_intelligence_execution_mode', input: {} })
        : { mode: this.reply ? 'legacy' as const : 'harness' as const };
      if (executionMode.mode === 'harness') {
        if (!canCommit()) throw new Error('intelligence_reply_revoked');
        this.activeRuntimeOperations.add(requestId);
        try {
          return await observeLocalDiagnosticStage('conversation.reply', () => this.dataRequest<IntelligenceConversation>(this.databaseRoot, {
            operation: 'send_intelligence_message',
            input: { text: content, conversationId: id, requireExisting, operationId: requestId, requestId, source: commitGuard ? 'telegram' : 'sidebar', ...(commitGuard ? { commitGuard } : {}) }
          }));
        } finally { this.activeRuntimeOperations.delete(requestId); }
      }
      if (!this.reply) throw new Error('intelligence_legacy_reply_unavailable');
      for (;;) {
        const state = await this.dataRequest<{ conversation: IntelligenceConversation; revision: number; contextCheckpoint?: IntelligenceContextCheckpoint } | null>(this.databaseRoot, { operation: 'read_intelligence_conversation', input: { id } });
        const current = state?.conversation || null;
        if (conversationId && !current) throw new Error('Intelligence conversation was not found.');
        const messages: IntelligenceMessage[] = [...(current?.messages || []), { role: 'user', content }];
        let contextCheckpoint: StagedIntelligenceContextCheckpoint | undefined;
        let legacy: { operationId: string; cutoverGeneration: number; status: string; replay?: boolean } | undefined;
        if (this.runtimeRouting) legacy = await this.dataRequest(this.databaseRoot, { operation: 'begin_legacy_intelligence_operation', input: {
          operationId: requestId, conversationId: id, requestKey: requestId, prompt: content,
          baselineRevision: state?.revision || 0, source: commitGuard ? 'telegram' : 'sidebar',
          ...(commitGuard ? { sourceGeneration: commitGuard.generation } : {}),
          ownerPid: process.pid, ownerBirth: readProcessBirthMarker(process.pid) || `pid:${process.pid}`
        } });
        if (legacy?.replay) {
          if (legacy.status === 'settled') {
            const settled = await this.get(id);
            if (settled) return settled;
          }
          throw new Error('上一次处理仍在继续，请稍后再试。');
        }
        let answer = '';
        try {
          answer = String(await observeLocalDiagnosticStage('conversation.reply', () => this.reply!(messages, {
            ...(state?.contextCheckpoint ? { checkpoint: state.contextCheckpoint } : {}),
            ...(legacy ? { operationId: legacy.operationId, cutoverGeneration: legacy.cutoverGeneration } : {}),
            ...(legacy ? { beforeTool: async ({ readOnly }: { readOnly: boolean }) => {
              if (!readOnly) await this.dataRequest(this.databaseRoot, { operation: 'mark_legacy_intelligence_side_effect', input: { operationId: legacy.operationId } });
            } } : {}),
            stageCheckpoint(checkpoint) { contextCheckpoint = checkpoint; }
          }))).trim();
        } catch (error) {
          if (legacy) await this.dataRequest(this.databaseRoot, { operation: 'fail_legacy_intelligence_operation', input: { operationId: legacy.operationId } });
          throw error;
        }
        if (!answer || !canCommit()) {
          if (legacy) await this.dataRequest(this.databaseRoot, { operation: 'mark_legacy_intelligence_operation', input: { operationId: legacy.operationId, status: 'failed' } });
          if (!answer) throw new Error('Intelligence did not return an answer.');
          throw new Error('intelligence_reply_revoked');
        }
        const now = new Date().toISOString();
        const conversation: IntelligenceConversation = {
          id,
          title: current?.title || content.replace(/\s+/g, ' ').slice(0, 72),
          createdAt: current?.createdAt || now,
          updatedAt: now,
          messages: [...messages, { role: 'assistant', content: answer }]
        };
        try { await observeLocalDiagnosticStage('conversation.persist', async () => {
          await this.dataRequest(this.databaseRoot, { operation: legacy ? 'write_legacy_intelligence_conversation' : 'write_intelligence_conversation', input: {
            ...(legacy ? { operationId: legacy.operationId } : {}),
            conversation,
            expectedRevision: state?.revision || 0,
            idempotencyKey: `${requestId}:${state?.revision || 0}`,
            ...(commitGuard ? { commitGuard } : {}),
            ...(contextCheckpoint ? { contextCheckpoint } : {})
          } });
        }); } catch (error) {
          if (legacy) {
            await this.dataRequest(this.databaseRoot, { operation: 'fail_legacy_intelligence_operation', input: { operationId: legacy.operationId } }).catch(() => undefined);
            const durable = await this.dataRequest<{ status: string } | null>(this.databaseRoot, { operation: 'read_legacy_intelligence_operation', input: { operationId: legacy.operationId } }).catch(() => null);
            if (durable?.status === 'settled') {
              const settled = await this.get(id);
              if (settled) return settled;
            }
            throw error;
          }
          if (error instanceof Error && error.message === 'revision_conflict') continue;
          throw error;
        }
        return conversation;
        }
      }).then(conversation => {
        trace.record('conversation.store', 'ok', Date.now() - startedAt);
        return conversation;
      }, error => {
        trace.record('conversation.store', 'error', Date.now() - startedAt, error);
        throw error;
      });
      this.pending.set(id, operation);
      void operation.finally(() => {
        if (this.pending.get(id) === operation) this.pending.delete(id);
      }).catch(() => undefined);
      return operation;
    });
  }
}
