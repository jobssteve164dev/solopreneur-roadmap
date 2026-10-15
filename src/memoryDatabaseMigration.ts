import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnifiedDataStore } from './db/unifiedDataStore';

export interface MemoryImportResult {
  imported: number;
  unchanged: number;
  originalBytes: number;
  conflicts: Array<{ source: string; error: string }>;
  /** Historical evidence that was already absent and cannot be recovered by retrying. */
  retainedGaps?: Array<{ source: string; error: string }>;
  /** Sources preserved as immutable evidence because their original shape cannot be normalized safely. */
  archivedSources?: Array<{ source: string; error: string; evidenceRef: string }>;
  retainedFiles: string[];
  interrupted?: boolean;
}

export interface MemoryImportOptions {
  projectScopes?: Record<string, string>;
  sourceIdentity?: string;
  shouldContinue?: () => boolean;
  onProgress?: (result: MemoryImportResult) => void;
  archiveUnresolved?: boolean;
}

const archivableMigrationConflicts = new Set([
  'project_scope_mapping_required', 'learning_ledger_mapping_incomplete', 'invalid_documentation_manifest',
  'migration_conflict: existing_database_choice', 'migration_conflict: newer_database_revision',
  'legacy_memory_entry_invalid', 'legacy_memory_hash_mismatch', 'legacy_memory_scope_invalid', 'legacy_memory_validity_invalid',
  'legacy_learning_decision_encoding_invalid', 'legacy_learning_decision_invalid', 'legacy_learning_decision_timestamp_invalid',
  'legacy_learning_event_encoding_invalid', 'legacy_learning_event_invalid', 'legacy_learning_event_timestamp_invalid',
  'legacy_lesson_confidence_invalid', 'legacy_lesson_events_invalid', 'legacy_lesson_invalid', 'legacy_lesson_timestamp_invalid',
  'legacy_review_application_invalid', 'legacy_review_application_sources_invalid', 'legacy_review_application_target_invalid',
  'legacy_review_cursor_invalid', 'legacy_review_encoding_invalid', 'legacy_review_lesson_after_invalid',
  'legacy_review_lesson_before_invalid', 'legacy_review_lock_invalid', 'legacy_review_manifest_invalid',
  'legacy_review_manifest_missing', 'legacy_review_memory_invalid', 'legacy_review_result_invalid', 'legacy_review_source_invalid',
  'historical_native_session_scope_mismatch', 'historical_run_binding_mismatch', 'historical_run_document_scope_mismatch',
  'historical_run_identity_ambiguous', 'historical_run_identity_invalid', 'historical_run_input_invalid', 'historical_run_input_missing',
  'historical_run_index_owner_unknown', 'execution_identity_conflict',
  'historical_run_legacy_identity_invalid', 'historical_run_native_source_mismatch', 'historical_run_native_source_missing',
  'historical_run_native_source_scope_mismatch', 'historical_run_output_hash_mismatch', 'historical_run_output_scope_mismatch',
  'historical_run_provider_context_invalid', 'historical_run_report_mismatch', 'historical_run_source_conflict',
  'historical_run_status_scope_mismatch', 'historical_run_task_mismatch', 'historical_run_workspace_mismatch',
  'invalid_completion_decision', 'legacy_report_source_ambiguous', 'legacy_task_execution_scope_mismatch', 'legacy_task_invalid',
  'migration_target_changed', 'capability_registry_invalid', 'capability_identity_invalid',
  'analysis_cache_source_invalid', 'historical_run_status_invalid',
  'growth_report_projection_conflict', 'step_memory_source_format_unsupported', 'step_memory_source_invalid',
  'step_memory_source_entries_invalid', 'run_digest_source_format_unsupported', 'run_digest_source_invalid'
]);

export function isArchivableMigrationConflict(error: string): boolean {
  const message = error.replace(/^Error:\s*/, '');
  if (archivableMigrationConflicts.has(message)) return true;
  try {
    const conflicts = JSON.parse(error);
    return Array.isArray(conflicts) && conflicts.length > 0 && conflicts.every(item => item && typeof item.error === 'string' && isArchivableMigrationConflict(item.error));
  } catch { return false; }
}

const legacyProjectSlug = (value: string): string => path.basename(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function resolveLegacyProjectScope(options: MemoryImportOptions, value: string): string | null {
  const scopes = options.projectScopes || {};
  const direct = scopes[value] || (path.isAbsolute(value) ? scopes[path.resolve(value)] : undefined);
  if (direct) return direct;
  const slug = legacyProjectSlug(value);
  if (!slug) return null;
  const matches = new Set(Object.entries(scopes).filter(([candidate]) => legacyProjectSlug(candidate) === slug).map(([, projectId]) => projectId));
  return matches.size === 1 ? [...matches][0] : null;
}

export function archiveUnresolvedMigrationSource(
  store: UnifiedDataStore,
  result: MemoryImportResult,
  source: { identity: string; key: string; hash: string },
  bytes: Uint8Array,
  error: string,
  options: MemoryImportOptions,
  input: { displaySource?: string; mimeType?: string; projectId?: string | null; observedAt?: number } = {}
): boolean {
  if (!options.archiveUnresolved || !isArchivableMigrationConflict(error)) return false;
  const archived = store.archiveMigrationSource(source, bytes, { reason: error, mimeType: input.mimeType, projectId: input.projectId, observedAt: input.observedAt });
  result.archivedSources ||= [];
  result.archivedSources.push({ source: input.displaySource || source.key, error, evidenceRef: `solomap://evidence/${archived.objectId}` });
  if (archived.unchanged) result.unchanged++; else result.imported++;
  return true;
}

function structuredMemory(bytes: Buffer, options: MemoryImportOptions): { scope: string | null; data: Record<string, unknown> } {
  let entry: Record<string, any>;
  try { entry = JSON.parse(bytes.toString('utf8')) as Record<string, any>; }
  catch { throw new Error('legacy_memory_entry_invalid'); }
  const compactEntry = entry.objectType === undefined && typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.canonicalHash === 'string';
  if (entry.schemaVersion !== 1 || (!compactEntry && entry.objectType !== 'memory_entry') || typeof entry.title !== 'string' || typeof entry.content !== 'string' || typeof entry.kind !== 'string' || typeof entry.status !== 'string' || (!compactEntry && (!Number.isInteger(entry.revision) || entry.revision < 1)) || (compactEntry && entry.revision !== undefined && (!Number.isInteger(entry.revision) || entry.revision < 1))) throw new Error('legacy_memory_entry_invalid');
  if (entry.canonicalHash !== undefined) {
    const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    const { canonicalHash, ...data } = entry;
    if (canonicalHash !== `sha256:${crypto.createHash('sha256').update(JSON.stringify(ordered(data))).digest('hex')}`) throw new Error('legacy_memory_hash_mismatch');
  }
  let scope: string | null = null;
  if (entry.scopeId !== 'memory_scope:global') {
    if (typeof entry.scopeId !== 'string' || !entry.scopeId.startsWith('memory_scope:project:')) throw new Error('legacy_memory_scope_invalid');
    scope = resolveLegacyProjectScope(options, entry.scopeId.slice('memory_scope:project:'.length));
    if (!scope) throw new Error('project_scope_mapping_required');
  }
  const expiry = entry.validity?.validUntil ? Date.parse(entry.validity.validUntil) : null;
  const starts = entry.validity?.validFrom ? Date.parse(entry.validity.validFrom) : null;
  if ((expiry !== null && !Number.isFinite(expiry)) || (starts !== null && !Number.isFinite(starts)) || (expiry !== null && starts !== null && expiry <= starts)) throw new Error('legacy_memory_validity_invalid');
  return { scope, data: {
    category: ({ project_fact: 'project', operating_rule: 'rules' } as Record<string, string>)[entry.kind] || entry.kind,
    title: entry.title, status: entry.status, confidence: 0, content: entry.content, valid_until: expiry, valid_from: starts,
    legacy_entry_id: String(entry.entryId || entry.memoryId || entry.id || ''), external_scope: entry.scopeId,
    layer: typeof entry.layer === 'string' ? entry.layer : null, external_entry_revision: entry.revision ?? 1,
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
      let capturedSource: { identity: string; key: string; hash: string } | undefined;
      let capturedBytes: Buffer | undefined;
      try {
        const category = key === 'profile.md' ? 'profile' : key === 'operating-rules.md' ? 'rules' : ({ projects: 'project', decisions: 'decision', patterns: 'pattern', domains: 'domain', active: 'active', inbox: 'inbox' } as Record<string, string>)[key.split('/')[0]] || 'inbox';
        let scope = category === 'project' ? resolveLegacyProjectScope(options, path.basename(entry.name, '.md')) : null;
        const before = await fs.promises.stat(source);
        const bytes = await fs.promises.readFile(source);
        const after = await fs.promises.stat(source);
        if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('source_changed_during_read');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        capturedBytes = bytes;
        capturedSource = { identity, key, hash };
        const text = bytes.toString('utf8');
        if (category === 'project' && !scope && Buffer.from(text, 'utf8').equals(bytes)) {
          const declared = [...text.matchAll(/^\s*-\s*(?:Workspace|Path|Repo):\s*`([^`]+)`/gim)]
            .map(match => resolveLegacyProjectScope(options, match[1])).filter((value): value is string => Boolean(value));
          const unique = new Set(declared);
          if (unique.size === 1) scope = [...unique][0];
        }
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!capturedSource || !capturedBytes || !archiveUnresolvedMigrationSource(store, result, capturedSource, capturedBytes, message, options, { displaySource: key, mimeType: key.endsWith('.json') ? 'application/json' : 'text/markdown' })) result.conflicts.push({ source: key, error: message });
      }
      options.onProgress?.(result);
      // Source traversal never monopolizes the owner between separate file commits.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  await visit(root);
  return result;
}
