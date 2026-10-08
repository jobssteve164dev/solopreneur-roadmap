import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { RuntimeDataOperations } from './runtimeDataOperations';

type MigrationOperations = (request: Parameters<RuntimeDataOperations>[0]) => Promise<unknown>;
type MigrationAcknowledgement = { scheduled?: boolean };

export async function enqueueStartupDataMigrations(store: UnifiedDataStore, operations: RuntimeDataOperations, shouldContinue: () => boolean): Promise<void> {
  await enqueueAvailableDataMigrations(store, operations, shouldContinue);
}

/** Discovers current legacy sources without blocking the caller on their import. */
export async function enqueueAvailableDataMigrations(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean, refreshCompleted = false): Promise<{ queued: number }> {
  let queued = 0;
  const enqueue = async (request: Parameters<RuntimeDataOperations>[0]): Promise<void> => {
    const result = await operations(refreshCompleted ? { ...request, input: { ...request.input, refreshCompleted: true } } : request) as MigrationAcknowledgement;
    if (result.scheduled) queued++;
  };
  try { await enqueueStartupMemoryMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap memory migration startup: ${String(error)}\n`); }
  try { await enqueueStartupProjectMigrations(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap project data migration startup: ${String(error)}\n`); }
  if (!shouldContinue()) return { queued };
  const sourceRoot = path.join(store.root, 'intelligence-conversations');
  try {
    if ((await fs.promises.stat(sourceRoot)).isDirectory()) await enqueue({ operation: 'import_intelligence', input: { sourceRoot, idempotencyKey: `startup-intelligence-v1:${sourceRoot}` } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap intelligence migration startup: ${String(error)}\n`);
  }
  return { queued };
}

async function enqueueStartupProjectMigrations(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  let projects: Array<{ path: string }> = store.registeredProjectRoots().map(projectPath => ({ path: projectPath }));
  try {
    const registry = JSON.parse(await fs.promises.readFile(path.join(store.root, 'projects.json'), 'utf8'));
    if (!Array.isArray(registry.projects)) throw new Error('project_registry_invalid');
    const known = new Set(projects.map(project => path.resolve(project.path)));
    for (const project of registry.projects) {
      const projectPath = String(project?.path || '');
      if (path.isAbsolute(projectPath) && !known.has(path.resolve(projectPath))) projects.push({ path: projectPath });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap growth project registry: ${String(error)}\n`);
  }
  for (const project of projects) {
    if (!shouldContinue()) return;
    const projectRoot = String(project?.path || '');
    if (!path.isAbsolute(projectRoot)) continue;
    const sources = [
      { collection: 'project-growth', sourceRoot: path.join(projectRoot, '.solopreneur', 'project_growth.db') },
      { collection: 'project-journal', sourceRoot: path.join(projectRoot, '.solopreneur', 'project_journal.db') },
      { collection: 'agent-runs', sourceRoot: path.join(projectRoot, '.solopreneur', 'agent-runs') }
    ];
    for (const source of sources) {
      try { if (!fs.statSync(source.sourceRoot)[source.collection === 'agent-runs' ? 'isDirectory' : 'isFile']()) continue; }
      catch { continue; }
      await operations({ operation: 'import_project_data', input: { ...source, projectRoot, idempotencyKey: `startup-${source.collection}-v1:${projectRoot}` } });
    }
  }
}

/** Runs after the owner's control endpoint is ready; sources stay untouched. */
export async function enqueueStartupMemoryMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const sourceRoot = path.join(store.root, 'memory');
  try { if (!(await fs.promises.stat(sourceRoot)).isDirectory()) return; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Queue the source so the durable migration job exposes its failure and retry.
    process.stderr.write(`SoloMap memory source inspection: ${String(error)}\n`);
  }
  const mappings = new Map<string, string | null>();
  let projects: Array<{ path: string; name?: string }> = [];
  try {
    const registry = JSON.parse(await fs.promises.readFile(path.join(store.root, 'projects.json'), 'utf8'));
    if (!Array.isArray(registry.projects)) throw new Error('project_registry_invalid');
    projects = registry.projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap memory project registry: ${String(error)}\n`);
  }
  const legacySlugs = new Map<string, Set<string>>();
  const legacySlug = (root: string) => path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  for (const project of projects) {
    if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) continue;
    const slug = legacySlug(project.path);
    if (!legacySlugs.has(slug)) legacySlugs.set(slug, new Set());
    legacySlugs.get(slug)!.add(path.resolve(project.path));
  }
  for (const project of projects) {
    if (!shouldContinue()) return;
    try {
      if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error('project_registry_invalid');
      const registered = await store.registerProject({ root: project.path, name: project.name });
      // This is the legacy memory producer's path-based slug, not a display-name ID.
      const slug = legacySlug(project.path);
      if (legacySlugs.get(slug)!.size > 1) { mappings.set(slug, null); continue; }
      const previous = mappings.get(slug);
      mappings.set(slug, previous === undefined || previous === registered.projectId ? registered.projectId : null);
    } catch (error) {
      // A disconnected project must not prevent importing global or other project memory.
      process.stderr.write(`SoloMap memory project registration: ${String(project?.path || '')}: ${String(error)}\n`);
    }
  }
  if (!shouldContinue()) return;
  const projectScopes = Object.fromEntries([...mappings].filter((entry): entry is [string, string] => entry[1] !== null).sort(([a], [b]) => a.localeCompare(b)));
  const signature = crypto.createHash('sha256').update(JSON.stringify({ sourceRoot, projectScopes })).digest('hex');
  await operations({ operation: 'import_memory', input: { sourceRoot, projectScopes, idempotencyKey: `startup-memory-v1:${signature}` } });
}
