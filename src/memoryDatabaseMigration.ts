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
}

/** Read-only source import. File retirement is a separate, explicitly authorized action. */
export async function importMemoryDirectory(store: UnifiedDataStore, sourceRoot: string, options: { projectScopes?: Record<string, string>; sourceIdentity?: string } = {}): Promise<MemoryImportResult> {
  const root = await fs.promises.realpath(sourceRoot);
  const identity = options.sourceIdentity || `memory:${root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { result.conflicts.push({ source: path.relative(root, directory), error: String(error) }); return; }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const source = path.join(directory, entry.name);
      const key = path.relative(root, source).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) result.retainedFiles.push(key + '/');
        else await visit(source);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') { result.retainedFiles.push(key); continue; }
      try {
        const category = key === 'profile.md' ? 'profile' : key === 'operating-rules.md' ? 'rules' : ({ projects: 'project', decisions: 'decision', patterns: 'pattern', domains: 'domain', active: 'active', inbox: 'inbox' } as Record<string, string>)[key.split('/')[0]] || 'inbox';
        const scope = category === 'project' ? options.projectScopes?.[path.basename(entry.name, '.md')] : null;
        const before = await fs.promises.stat(source);
        const bytes = await fs.promises.readFile(source);
        const after = await fs.promises.stat(source);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('source_changed_during_read');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const text = bytes.toString('utf8');
        const content = Buffer.from(text, 'utf8').equals(bytes) ? text : { encoding: 'base64', data: bytes.toString('base64'), mimeType: 'text/markdown' };
        store.captureMigrationSource({ identity, key, hash }, bytes, { mimeType: typeof content === 'string' ? 'text/plain' : 'text/markdown', encoding: typeof content === 'string' ? 'utf8' : 'binary', ...(category === 'project' && !scope ? { error: 'project_scope_mapping_required' } : {}) });
        if (category === 'project' && !scope) throw new Error('project_scope_mapping_required');
        const imported = store.importObject({ kind: 'memory', action: 'create', scope: scope || null, idempotencyKey: `import:${identity}:${key}:${hash}`, data: { category, title: path.basename(entry.name, '.md'), status: category === 'inbox' ? 'captured' : 'active', confidence: 0, content, external_source: `${identity}/${key}`, external_revision: hash, canonical_hash: hash } }, { identity, key, hash });
        if (imported.unchanged) result.unchanged++; else result.imported++;
        result.originalBytes += bytes.length;
      } catch (error) { result.conflicts.push({ source: key, error: error instanceof Error ? error.message : String(error) }); }
      // Source traversal never monopolizes the owner between separate file commits.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  await visit(root);
  return result;
}
