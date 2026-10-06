import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import {
  createLocalDiagnosticTrace,
  getCurrentLocalDiagnosticTrace,
  observeLocalDiagnosticStage,
  withLocalDiagnosticTrace
} from './localDiagnostics';

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

export class IntelligenceConversationStore {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly globalDataPath: string,
    private readonly reply: (messages: IntelligenceMessage[]) => Promise<string>
  ) {
    this.directory = path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'intelligence-conversations');
  }

  private filePath(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('Invalid intelligence conversation ID.');
    }
    return path.join(this.directory, `${id}.json`);
  }

  private get databaseRoot(): string { return normalizeGlobalDataPathForExtension(this.globalDataPath); }
  private get databaseBacked(): boolean { return fs.existsSync(path.join(this.databaseRoot, 'solomap.db')); }

  get(id: string): IntelligenceConversation | null | Promise<IntelligenceConversation | null> {
    this.filePath(id);
    if (this.databaseBacked) return sendRuntimeDataRequest<{ conversation: IntelligenceConversation } | null>(this.databaseRoot, { operation: 'read_intelligence_conversation', input: { id } }).then(state => state?.conversation || null);
    return this.getLegacy(id);
  }

  private getLegacy(id: string): IntelligenceConversation | null {
    const filePath = this.filePath(id);
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IntelligenceConversation;
    if (value.id !== id || !Array.isArray(value.messages)) throw new Error('Intelligence conversation data is invalid.');
    return value;
  }

  list(): Array<Pick<IntelligenceConversation, 'id' | 'title' | 'updatedAt'>> | Promise<Array<Pick<IntelligenceConversation, 'id' | 'title' | 'updatedAt'>>> {
    if (this.databaseBacked) return sendRuntimeDataRequest(this.databaseRoot, { operation: 'list_intelligence_conversations', input: {} });
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map(name => {
        try {
          const conversation = this.getLegacy(name.slice(0, -5));
          return conversation && { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
        } catch {
          return null;
        }
      })
      .filter((item): item is Pick<IntelligenceConversation, 'id' | 'title' | 'updatedAt'> => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  send(text: string, conversationId = ''): Promise<IntelligenceConversation> {
    const content = String(text || '').trim();
    if (!content) return Promise.reject(new Error('Please enter a message.'));
    const trace = getCurrentLocalDiagnosticTrace() || createLocalDiagnosticTrace(this.globalDataPath, 'sidebar.chat');
    return withLocalDiagnosticTrace(trace, () => {
      const startedAt = Date.now();
      trace.record('conversation.queue', 'start');
      const id = conversationId || crypto.randomUUID();
      this.filePath(id);
      const previous = this.pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
        trace.record('conversation.queue', 'ok', Date.now() - startedAt);
        const requestId = crypto.randomUUID();
        for (;;) {
        const databaseBacked = this.databaseBacked;
        const state = databaseBacked
          ? await sendRuntimeDataRequest<{ conversation: IntelligenceConversation; revision: number } | null>(this.databaseRoot, { operation: 'read_intelligence_conversation', input: { id } })
          : null;
        const current = databaseBacked ? state?.conversation || null : this.getLegacy(id);
        if (conversationId && !current) throw new Error('Intelligence conversation was not found.');
        const messages: IntelligenceMessage[] = [...(current?.messages || []), { role: 'user', content }];
        const answer = String(await observeLocalDiagnosticStage('conversation.reply', () => this.reply(messages))).trim();
        if (!answer) throw new Error('Intelligence did not return an answer.');
        if (!databaseBacked && this.databaseBacked) continue;
        const now = new Date().toISOString();
        const conversation: IntelligenceConversation = {
          id,
          title: current?.title || content.replace(/\s+/g, ' ').slice(0, 72),
          createdAt: current?.createdAt || now,
          updatedAt: now,
          messages: [...messages, { role: 'assistant', content: answer }]
        };
        try { await observeLocalDiagnosticStage('conversation.persist', async () => {
          if (databaseBacked) {
            await sendRuntimeDataRequest(this.databaseRoot, { operation: 'write_intelligence_conversation', input: { conversation, expectedRevision: state?.revision || 0, idempotencyKey: `${requestId}:${state?.revision || 0}` } });
            return;
          }
          fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
          const filePath = this.filePath(id);
          const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
          fs.writeFileSync(temporaryPath, JSON.stringify(conversation), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          fs.renameSync(temporaryPath, filePath);
        }); } catch (error) {
          if (databaseBacked && error instanceof Error && error.message === 'revision_conflict') continue;
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
