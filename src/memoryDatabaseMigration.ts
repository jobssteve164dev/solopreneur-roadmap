import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnifiedDataStore } from './db/unifiedDataStore';

export interface MemoryImportResult {
  imported: number;
  unchanged: number;
  originalBytes: number;
  conflicts: Array<{ source: string; error: string }>;
  retainedFiles: string[];
  interrupted?: boolean;
}

export interface MemoryImportOptions {
  projectScopes?: Record<string, string>;
  sourceIdentity?: string;
  shouldContinue?: () => boolean;
  onProgress?: (result: MemoryImportResult) => void;
}

function structuredMemory(bytes: Buffer, options: MemoryImportOptions): { scope: string | null; data: Record<string, unknown> } {
  const entry = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
  if (entry.schemaVersion !== 1 || entry.objectType !== 'memory_entry' || typeof entry.title !== 'string' || typeof entry.content !== 'string' || typeof entry.kind !== 'string' || typeof entry.status !== 'string' || !Number.isInteger(entry.revision) || entry.revision < 1) throw new Error('legacy_memory_entry_invalid');
  let scope: string | null = null;
  if (entry.scopeId !== 'memory_scope:global') {
    if (typeof entry.scopeId !== 'string' || !entry.scopeId.startsWith('memory_scope:project:')) throw new Error('legacy_memory_scope_invalid');
    scope = options.projectScopes?.[entry.scopeId.slice('memory_scope:project:'.length)] || null;
    if (!scope) throw new Error('project_scope_mapping_required');
  }
  const expiry = entry.validity?.validUntil ? Date.parse(entry.validity.validUntil) : null;
  const starts = entry.validity?.validFrom ? Date.parse(entry.validity.validFrom) : null;
  if ((expiry !== null && !Number.isFinite(expiry)) || (starts !== null && !Number.isFinite(starts)) || (expiry !== null && starts !== null && expiry <= starts)) throw new Error('legacy_memory_validity_invalid');
  return { scope, data: {
    category: ({ project_fact: 'project', operating_rule: 'rules' } as Record<string, string>)[entry.kind] || entry.kind,
    title: entry.title, status: entry.status, confidence: 0, content: entry.content, valid_until: expiry, valid_from: starts,
    legacy_entry_id: String(entry.entryId || entry.memoryId || entry.id || ''), external_scope: entry.scopeId,
    layer: typeof entry.layer === 'string' ? entry.layer : null, external_entry_revision: entry.revision,
    tags_json: JSON.stringify(entry.tags || []), provenance_json: JSON.stringify(entry.provenance || {}),
    validity_json: JSON.stringify(entry.validity || {}), supersedes_json: JSON.stringify(entry.supersedes || []), metadata_json: JSON.stringify(entry.metadata || {})
  } };
}

/** Read-only source import. File retirement is a separate, explicitly authorized action. */
export async function importMemoryDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions = {}): Promise<MemoryImportResult> {
  const root = await fs.promises.realpath(sourceRoot);
  const identity = options.sourceIdentity || `memory:${root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { result.conflicts.push({ source: path.relative(root, directory), error: String(error) }); return; }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
      const source = path.join(directory, entry.name);
      const key = path.relative(root, source).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) result.retainedFiles.push(key + '/');
        else await visit(source);
        continue;
      }
      const structured = key.startsWith('entries/') && path.extname(entry.name).toLowerCase() === '.json';
      if (!entry.isFile() || (!structured && path.extname(entry.name).toLowerCase() !== '.md')) { result.retainedFiles.push(key); continue; }
      try {
        const category = key === 'profile.md' ? 'profile' : key === 'operating-rules.md' ? 'rules' : ({ projects: 'project', decisions: 'decision', patterns: 'pattern', domains: 'domain', active: 'active', inbox: 'inbox' } as Record<string, string>)[key.split('/')[0]] || 'inbox';
        let scope = category === 'project' ? options.projectScopes?.[path.basename(entry.name, '.md')] : null;
        const before = await fs.promises.stat(source);
        const bytes = await fs.promises.readFile(source);
        const after = await fs.promises.stat(source);
        if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('source_changed_during_read');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const text = bytes.toString('utf8');
        const content = Buffer.from(text, 'utf8').equals(bytes) ? text : { encoding: 'base64', data: bytes.toString('base64'), mimeType: 'text/markdown' };
        let structuredData: Record<string, unknown> | undefined;
        let mappingError: string | undefined;
        if (structured) {
          try { const mapped = structuredMemory(bytes, options); scope = mapped.scope; structuredData = mapped.data; }
          catch (error) { mappingError = error instanceof Error ? error.message : String(error); }
        }
        store.captureMigrationSource({ identity, key, hash }, bytes, { mimeType: structured ? 'application/json' : typeof content === 'string' ? 'text/plain' : 'text/markdown', encoding: typeof content === 'string' ? 'utf8' : 'binary', ...(mappingError || (category === 'project' && !scope) ? { error: mappingError || 'project_scope_mapping_required' } : {}) });
        if (mappingError) throw new Error(mappingError);
        if (category === 'project' && !scope) throw new Error('project_scope_mapping_required');
        const imported = store.importObject({ kind: 'memory', action: 'create', scope: scope || null, idempotencyKey: `import:${identity}:${key}:${hash}`, data: { ...(structuredData || { category, title: path.basename(entry.name, '.md'), status: category === 'inbox' ? 'captured' : 'active', confidence: 0, content }), external_source: `${identity}/${key}`, external_revision: hash, canonical_hash: hash } }, { identity, key, hash });
        if (imported.unchanged) result.unchanged++; else result.imported++;
        result.originalBytes += bytes.length;
      } catch (error) { result.conflicts.push({ source: key, error: error instanceof Error ? error.message : String(error) }); }
      options.onProgress?.(result);
      // Source traversal never monopolizes the owner between separate file commits.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  await visit(root);
  return result;
}
