import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IntelligenceConversation } from './intelligenceChat';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

export async function importLegacyIntelligenceConversation(store: UnifiedDataStore, file: string, shouldContinue = () => true): Promise<{ imported: boolean; bytes: number }> {
  const before = await fs.promises.stat(file);
  const bytes = await fs.promises.readFile(file);
  const after = await fs.promises.stat(file);
  if (!shouldContinue()) throw new Error('migration_interrupted');
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('source_changed_during_read');
  const source = { identity: `intelligence:${path.dirname(file)}`, key: path.basename(file), hash: crypto.createHash('sha256').update(bytes).digest('hex') };
  store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
  const conversation = JSON.parse(bytes.toString('utf8')) as IntelligenceConversation;
  if (conversation.id + '.json' !== path.basename(file)) throw new Error('conversation_identity_conflict');
  // A resumed/newer database conversation always wins over the retained historical source.
  if (store.readIntelligenceConversation(conversation.id)) return { imported: false, bytes: bytes.length };
  store.writeIntelligenceConversation({ conversation, expectedRevision: 0, idempotencyKey: `import:${source.identity}:${source.key}:${source.hash}` });
  return { imported: true, bytes: bytes.length };
}

export async function readIntelligenceConversation(store: UnifiedDataStore, id: string): Promise<ReturnType<UnifiedDataStore['readIntelligenceConversation']>> {
  const current = store.readIntelligenceConversation(id);
  if (current) return current;
  const file = path.join(store.root, 'intelligence-conversations', id + '.json');
  try { await importLegacyIntelligenceConversation(store, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return store.readIntelligenceConversation(id);
}

export async function listIntelligenceConversations(store: UnifiedDataStore): Promise<ReturnType<UnifiedDataStore['listIntelligenceConversations']>> {
  const known = new Map(store.listIntelligenceConversations().map(value => [value.id, value]));
  const directory = path.join(store.root, 'intelligence-conversations');
  let names: string[];
  try { names = await fs.promises.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...known.values()]; throw error; }
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name) || known.has(name.slice(0, -5))) continue;
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8')) as IntelligenceConversation;
      if (value.id + '.json' !== name || typeof value.title !== 'string' || typeof value.updatedAt !== 'string') continue;
      known.set(value.id, { id: value.id, title: value.title, updatedAt: value.updatedAt });
    } catch { /* The background importer retains and reports unreadable history. */ }
  }
  // A write that committed while reading retained sources has precedence over old headers.
  for (const value of store.listIntelligenceConversations()) known.set(value.id, value);
  return [...known.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function importIntelligenceDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions): Promise<MemoryImportResult> {
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  const entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; break; }
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name)) { result.retainedFiles.push(entry.name); continue; }
    try {
      const imported = await importLegacyIntelligenceConversation(store, path.join(sourceRoot, entry.name), options.shouldContinue);
      if (imported.imported) result.imported++; else result.unchanged++;
      result.originalBytes += imported.bytes;
    } catch (error) {
      if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; break; }
      result.conflicts.push({ source: entry.name, error: String(error) });
    }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}
