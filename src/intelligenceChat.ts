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
  stageCheckpoint(checkpoint: StagedIntelligenceContextCheckpoint): void;
}

export interface IntelligenceCommitGuard {
  type: 'telegram-reply-generation';
  generation: number;
}

type IntelligenceDataRequest = <T>(root: string, request: { operation: string; input: Record<string, unknown> }) => Promise<T>;

export class IntelligenceConversationStore {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly globalDataPath: string,
    private readonly reply: (messages: IntelligenceMessage[], context: IntelligenceReplyContext) => Promise<string>,
    private readonly dataRequest: IntelligenceDataRequest = sendRuntimeDataRequest
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

  send(text: string, conversationId = '', canCommit: () => boolean = () => true, commitGuard?: IntelligenceCommitGuard): Promise<IntelligenceConversation> {
    const content = String(text || '').trim();
    if (!content) return Promise.reject(new Error('Please enter a message.'));
    const trace = getCurrentLocalDiagnosticTrace() || createLocalDiagnosticTrace(this.globalDataPath, 'sidebar.chat');
    return withLocalDiagnosticTrace(trace, () => {
      const startedAt = Date.now();
      trace.record('conversation.queue', 'start');
      const id = conversationId || crypto.randomUUID();
      this.validateId(id);
      const previous = this.pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
      trace.record('conversation.queue', 'ok', Date.now() - startedAt);
      const requestId = crypto.randomUUID();
      for (;;) {
        const state = await this.dataRequest<{ conversation: IntelligenceConversation; revision: number; contextCheckpoint?: IntelligenceContextCheckpoint } | null>(this.databaseRoot, { operation: 'read_intelligence_conversation', input: { id } });
        const current = state?.conversation || null;
        if (conversationId && !current) throw new Error('Intelligence conversation was not found.');
        const messages: IntelligenceMessage[] = [...(current?.messages || []), { role: 'user', content }];
        let contextCheckpoint: StagedIntelligenceContextCheckpoint | undefined;
        const answer = String(await observeLocalDiagnosticStage('conversation.reply', () => this.reply(messages, {
          ...(state?.contextCheckpoint ? { checkpoint: state.contextCheckpoint } : {}),
          stageCheckpoint(checkpoint) { contextCheckpoint = checkpoint; }
        }))).trim();
        if (!answer) throw new Error('Intelligence did not return an answer.');
        if (!canCommit()) throw new Error('intelligence_reply_revoked');
        const now = new Date().toISOString();
        const conversation: IntelligenceConversation = {
          id,
          title: current?.title || content.replace(/\s+/g, ' ').slice(0, 72),
          createdAt: current?.createdAt || now,
          updatedAt: now,
          messages: [...messages, { role: 'assistant', content: answer }]
        };
        try { await observeLocalDiagnosticStage('conversation.persist', async () => {
          await this.dataRequest(this.databaseRoot, { operation: 'write_intelligence_conversation', input: {
            conversation,
            expectedRevision: state?.revision || 0,
            idempotencyKey: `${requestId}:${state?.revision || 0}`,
            ...(commitGuard ? { commitGuard } : {}),
            ...(contextCheckpoint ? { contextCheckpoint } : {})
          } });
        }); } catch (error) {
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
