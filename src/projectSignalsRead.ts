import * as path from 'path';
import * as crypto from 'crypto';
import type { UnifiedDataStore } from './db/unifiedDataStore';
import type { ProjectRegistrySnapshot } from './projectRegistry';

export const projectSignalKinds = ['issues', 'pullRequests', 'delivery', 'security'] as const;

// Keep pages below the Pi tool-output boundary even after JSON escaping.
const pageCharacters = 4000;
interface SignalCursor { projectId: string; kind: string; ref: string; revision: number; offset: number }

export function projectSignalProjects(store: UnifiedDataStore) {
  const registry = store.readProjectRegistry() as ProjectRegistrySnapshot | null;
  const hidden = new Set((registry?.registry.hiddenProjects || []).map(root => path.resolve(root)));
  const locations = store.registeredProjectLocationsForRead();
  const projects = (registry?.registry.projects || []).filter(project => !hidden.has(path.resolve(project.path))).map(project => ({
    projectId: locations.find(location => path.resolve(location.root) === path.resolve(project.path))?.projectId || null,
    name: project.name, path: project.path
  }));
  return { registry, projects };
}

function pageContent(content: string, offset: number) {
  if (offset < 0 || offset >= content.length) throw new Error('invalid_project_signal_cursor');
  let end = Math.min(content.length, offset + pageCharacters);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  return { format: 'json', offset, totalCharacters: content.length, content: content.slice(offset, end), end };
}

export function readProjectSignals(store: UnifiedDataStore, input: Record<string, unknown>): unknown {
  const { registry, projects } = projectSignalProjects(store);
  const selector = input.project;
  if (selector === undefined) {
    if (input.kind !== undefined) throw new Error('project_required');
    const content = JSON.stringify({ projects, kinds: projectSignalKinds });
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    let offset = 0;
    if (input.cursor !== undefined) {
      let page;
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw new Error();
        page = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (page?.type !== 'projects' || !Number.isSafeInteger(page.offset) || page.offset < 1) throw new Error();
      } catch { throw new Error('invalid_project_signal_cursor'); }
      if (page.registryId !== registry?.objectId || page.revision !== registry?.revision || page.contentHash !== contentHash) throw new Error('project_list_changed: restart project discovery');
      offset = page.offset;
    }
    const { end, ...page } = pageContent(content, offset);
    return { status: 'projects', revision: registry?.revision || 0, ...page,
      cursor: end < content.length ? Buffer.from(JSON.stringify({ type: 'projects', registryId: registry?.objectId, revision: registry?.revision, contentHash, offset: end })).toString('base64url') : null };
  }
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 4096) throw new Error('invalid_project_selector');
  const matches = projects.filter(project => selector === project.projectId || selector === project.path || selector === project.name);
  if (matches.length !== 1) throw new Error(matches.length ? 'project_selector_ambiguous' : 'project_scope_denied');
  const project = matches[0];
  const kind = String(input.kind || '');
  if (!projectSignalKinds.includes(kind as typeof projectSignalKinds[number])) throw new Error('invalid_project_signal_kind');
  let cursor: SignalCursor | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as SignalCursor;
      if (!cursor || cursor.projectId !== project.projectId || cursor.kind !== kind || typeof cursor.ref !== 'string'
        || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1) throw new Error();
    } catch { throw new Error('invalid_project_signal_cursor'); }
  }
  const state = project.projectId ? store.readAnalysisState(project.projectId, 'external', kind) : { objectId: null, revision: 0, value: null };
  if (cursor && cursor.ref !== state.objectId) throw new Error('invalid_project_signal_cursor');
  if (!state.objectId) return { projectId: project.projectId, kind, status: 'not_synced', objectId: null, revision: 0, syncedAt: null, content: null, cursor: null };
  let value = state.value;
  if (cursor) {
    const metadata = store.readMetadata(cursor.ref, cursor.revision);
    if (metadata.kind !== 'setting' || metadata.projectId !== project.projectId || metadata.data.namespace !== 'analysis:external'
      || metadata.data.key !== kind || metadata.data.owner_scope !== project.projectId) throw new Error('project_scope_denied');
    value = JSON.parse(String(store.read(cursor.ref, cursor.revision).data.content));
  }
  if (!value || typeof value !== 'object') throw new Error('project_signal_cache_invalid');
  const envelope = value as Record<string, unknown>;
  const cache = Object.prototype.hasOwnProperty.call(envelope, 'cache') ? envelope.cache : value;
  if (!cache || typeof cache !== 'object') throw new Error('project_signal_cache_invalid');
  const content = JSON.stringify(cache);
  const offset = cursor?.offset || 0;
  const { end, ...page } = pageContent(content, offset);
  const revision = cursor?.revision || state.revision;
  const syncedAt = (cache as Record<string, unknown>).syncedAt;
  return { projectId: project.projectId, kind, status: 'saved', objectId: state.objectId, revision,
    syncedAt: typeof syncedAt === 'string' && syncedAt.length < 100 && Number.isFinite(Date.parse(syncedAt)) ? syncedAt : null, ...page,
    cursor: end < content.length ? Buffer.from(JSON.stringify({ projectId: project.projectId, kind, ref: state.objectId, revision, offset: end })).toString('base64url') : null };
}
