import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { RuntimeDataOperations } from './runtimeDataOperations';
import { runArtifactKind, shouldDescendRunArtifactDirectory } from './runArtifactPolicy.js';
import { discoverLegacyRunProcesses, reapFinishedLegacyRunProcesses, type LegacyRunProcess } from './legacyRunProcessRecovery.js';
import { legacyProjectFilesStamp } from './legacyProjectFileMigration.js';

type MigrationOperations = (request: Parameters<RuntimeDataOperations>[0]) => Promise<unknown>;
type MigrationAcknowledgement = { scheduled?: boolean };

async function historicalRunSourceStamp(store: UnifiedDataStore, roots: string[], shouldContinue: () => boolean, discoveredOwners: LegacyRunProcess[]): Promise<string> {
  const hash = crypto.createHash('sha256'), pending = [...roots].sort();
  const statusRoot = roots.find(root => path.basename(root) === 'agent-status')!;
  const runRoot = roots.find(root => path.basename(root) === 'agent-runs')!;
  const projectRoot = path.dirname(path.dirname(runRoot));
  const liveOwners = discoveredOwners.filter(owner => path.resolve(owner.projectRoot) === path.resolve(projectRoot))
    .map(owner => [owner.pid, owner.birth, owner.runDirectory, owner.executionLogId || null]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  hash.update(JSON.stringify(['live-wrappers', liveOwners]));
  while (pending.length) {
    if (!shouldContinue()) return '';
    const file = pending.pop()!;
    let info: fs.Stats;
    try { info = await fs.promises.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update(JSON.stringify([file, 'missing'])); continue; }
    const runRelative = path.relative(runRoot, file);
    const withinRuns = !runRelative.startsWith('..') && !path.isAbsolute(runRelative);
    if (withinRuns && runRelative && (info.isDirectory() ? !shouldDescendRunArtifactDirectory(runRelative) : !runArtifactKind(runRelative))) continue;
    hash.update(JSON.stringify([file, info.mode, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
    const statusRelative = path.relative(statusRoot, file);
    if (info.isDirectory() && !info.isSymbolicLink()) pending.push(...(await fs.promises.readdir(file)).sort().map(name => path.join(file, name)));
    else if (info.isFile() && !info.isSymbolicLink() && (path.basename(file) === '.agent_status.json' || (statusRelative && !statusRelative.startsWith('..') && !path.isAbsolute(statusRelative)))) {
      try {
        const status = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (status && typeof status === 'object') hash.update(JSON.stringify([file, 'owner-alive', store.historicalRunOwnerAlive(status)]));
      } catch { /* The importer records invalid status sources; discovery preserves their metadata. */ }
    }
  }
  return hash.digest('hex');
}

/** Cheap owner-state probe used after startup; retained run payloads are scanned only when this stamp changes. */
export async function historicalRunOwnerStateStamp(store: UnifiedDataStore, shouldContinue: () => boolean): Promise<string> {
  const hash = crypto.createHash('sha256');
  const discoveredOwners = discoverLegacyRunProcesses(undefined, true);
  for (const projectRoot of store.existingRegisteredProjectRoots().sort()) {
    const liveOwners = discoveredOwners.filter(owner => path.resolve(owner.projectRoot) === path.resolve(projectRoot))
      .map(owner => [owner.pid, owner.birth, owner.runDirectory, owner.executionLogId || null]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    hash.update(JSON.stringify([projectRoot, 'live-wrappers', liveOwners]));
    const roots = [
      { root: path.join(projectRoot, '.agent_status.json'), allFiles: true },
      { root: path.join(projectRoot, '.solopreneur', 'agent-status'), allFiles: true },
      { root: path.join(projectRoot, '.solopreneur', 'agent-runs'), allFiles: false }
    ];
    for (const source of roots) {
      const capture = async (file: string, info: fs.Stats): Promise<void> => {
        let ownerState: boolean | 'invalid' = 'invalid';
        try { ownerState = store.historicalRunOwnerAlive(JSON.parse(await fs.promises.readFile(file, 'utf8'))); }
        catch { /* The full importer reports malformed sources. */ }
        hash.update(JSON.stringify([file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, ownerState]));
      };
      let rootInfo: fs.Stats;
      try { rootInfo = await fs.promises.lstat(source.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; continue; }
      if (rootInfo.isFile() && !rootInfo.isSymbolicLink()) { await capture(source.root, rootInfo); continue; }
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      const pending = [source.root];
      while (pending.length) {
        if (!shouldContinue()) return '';
        const directory = pending.pop()!;
        for (const entry of (await fs.promises.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (source.allFiles || shouldDescendRunArtifactDirectory(path.relative(source.root, file))) pending.push(file);
            continue;
          }
          if (!entry.isFile() || (!source.allFiles && entry.name !== '.agent_status.json')) continue;
          await capture(file, await fs.promises.lstat(file));
        }
      }
    }
  }
  return hash.digest('hex');
}

export async function refreshHistoricalRunMigrations(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean, previousStamp: string): Promise<string> {
  const currentStamp = await historicalRunOwnerStateStamp(store, shouldContinue);
  if (previousStamp && currentStamp && currentStamp !== previousStamp && shouldContinue()) {
    await enqueueAvailableDataMigrations(store, operations, shouldContinue, false, undefined, false);
  }
  return currentStamp;
}

export async function enqueueStartupDataMigrations(store: UnifiedDataStore, operations: RuntimeDataOperations, shouldContinue: () => boolean): Promise<void> {
  const recovered = await reapFinishedLegacyRunProcesses(store);
  for (const conflict of recovered.conflicts) process.stderr.write(`SoloMap legacy run recovery: ${conflict}\n`);
  await enqueueAvailableDataMigrations(store, operations, shouldContinue, false, undefined, false);
}

/** Discovers current legacy sources without blocking the caller on their import. */
export async function enqueueAvailableDataMigrations(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean, refreshCompleted = false, projectRoot?: string, includeLegacyProjectFiles = true): Promise<{ queued: number }> {
  let queued = 0;
  const enqueue = async (request: Parameters<RuntimeDataOperations>[0]): Promise<unknown> => {
    const result = await operations(refreshCompleted ? { ...request, input: { ...request.input, refreshCompleted: true } } : request) as MigrationAcknowledgement;
    if (result.scheduled) queued++;
    return result;
  };
  if (projectRoot) {
    try { await enqueueStartupProjectMigrations(store, enqueue, shouldContinue, projectRoot, includeLegacyProjectFiles); }
    catch (error) { process.stderr.write(`SoloMap project data migration startup: ${String(error)}\n`); }
    return { queued };
  }
  try {
    const registries = ['skills', 'mcp', 'enhancements'].map(directory => path.join(store.root, directory, 'registry.json'));
    const existing: Array<{ file: string; hash: string }> = [];
    for (const file of registries) {
      if (!shouldContinue()) return { queued };
      try { const bytes = await fs.promises.readFile(file); existing.push({ file, hash: crypto.createHash('sha256').update(bytes).digest('hex') }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (existing.length) await enqueue({ operation: 'import_project_data', input: { collection: 'capabilities', sourceRoot: store.root, archiveUnresolved: true, idempotencyKey: `startup-capabilities-v3:${crypto.createHash('sha256').update(JSON.stringify(existing)).digest('hex')}` } });
  } catch (error) { process.stderr.write(`SoloMap capability migration startup: ${String(error)}\n`); }
  try { await enqueueStartupProjectAutonomyMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap project autonomy migration startup: ${String(error)}\n`); }
  try { await enqueueStartupMemoryMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap memory migration startup: ${String(error)}\n`); }
  try { await enqueueStartupProjectMigrations(store, enqueue, shouldContinue, undefined, includeLegacyProjectFiles); }
  catch (error) { process.stderr.write(`SoloMap project data migration startup: ${String(error)}\n`); }
  try { await enqueueStartupLearningMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap learning migration startup: ${String(error)}\n`); }
  try { await enqueueStartupLearningReviewMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap review migration startup: ${String(error)}\n`); }
  try { await enqueueStartupStrategyMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap strategy migration startup: ${String(error)}\n`); }
  try { await enqueueStartupAnalysisMigration(store, enqueue, shouldContinue); }
  catch (error) { process.stderr.write(`SoloMap analysis cache migration startup: ${String(error)}\n`); }
  if (!shouldContinue()) return { queued };
  const sourceRoot = path.join(store.root, 'intelligence-conversations');
  try {
    if ((await fs.promises.stat(sourceRoot)).isDirectory()) await enqueue({ operation: 'import_intelligence', input: { sourceRoot, idempotencyKey: `startup-intelligence-v1:${sourceRoot}` } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap intelligence migration startup: ${String(error)}\n`);
  }
  return { queued };
}

async function enqueueStartupProjectAutonomyMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const root = path.join(store.root, 'runtime');
  const files: string[] = [path.join(root, 'project-autonomy-authorizations.json')];
  const recordsRoot = path.join(root, 'project-autonomy-authorizations');
  try {
    for (const entry of await fs.promises.readdir(recordsRoot, { withFileTypes: true })) {
      if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json')) files.push(path.join(recordsRoot, entry.name));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sources: Array<[string, string]> = [];
  for (const file of files.sort()) {
    if (!shouldContinue()) return;
    try {
      const info = await fs.promises.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      sources.push([path.relative(store.root, file).split(path.sep).join('/'), crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex')]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!sources.length || !shouldContinue()) return;
  const signature = crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  await operations({ operation: 'import_project_data', input: {
    collection: 'project-autonomy', sourceRoot: store.root, idempotencyKey: `startup-project-autonomy-v1:${signature}`
  } });
}

async function enqueueStartupAnalysisMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const projectScopes: Record<string, string> = {};
  const files = [path.join(store.root, 'usage', 'solomap-usage.json'), path.join(store.root, 'sidebar-core-snapshot-v1.json')];
  for (const projectRoot of store.existingRegisteredProjectRoots()) {
    if (!shouldContinue()) return;
    let project;
    try { project = await store.registerProject({ root: projectRoot }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    projectScopes[path.resolve(projectRoot)] = project.projectId;
    const projectKey = crypto.createHash('sha1').update(projectRoot).digest('hex');
    files.push(path.join(store.root, 'conversations', `sidebar-conversation-${projectKey}-v1.json`));
    files.push(path.join(store.root, `sidebar-conversation-${projectKey}-v1.json`));
    files.push(...['issues-cache.json', 'pull-requests-cache.json', 'delivery-cache.json', 'security-cache.json']
      .map(name => path.join(projectRoot, '.solopreneur', name)));
    files.push(path.join(projectRoot, '.solopreneur', 'coverage', 'project-growth-coverage.json'));
    files.push(path.join(projectRoot, '.solopreneur', 'time-plan.json'));
  }
  const existing: Array<[string, number, number]> = [];
  for (const file of files) {
    try { const info = await fs.promises.lstat(file); if (info.isFile() && !info.isSymbolicLink()) existing.push([file, info.size, info.mtimeMs]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!existing.length || !shouldContinue()) return;
  const signature = crypto.createHash('sha256').update(JSON.stringify({ projectScopes, existing })).digest('hex');
  await operations({ operation: 'import_project_data', input: { collection: 'analysis-caches', sourceRoot: store.root, projectScopes, archiveUnresolved: true, idempotencyKey: `startup-analysis-caches-v3:${signature}` } });
}

async function enqueueStartupLearningReviewMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const sourceRoot = path.join(store.root, 'maintenance');
  try { if (!(await fs.promises.lstat(sourceRoot)).isDirectory()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const projectScopes: Record<string, string> = {};
  for (const root of store.existingRegisteredProjectRoots()) {
    if (!shouldContinue()) return;
    let project;
    try { project = await store.registerProject({ root }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    projectScopes[path.resolve(root)] = project.projectId;
  }
  const sourceHash = crypto.createHash('sha256'), pending = [sourceRoot];
  while (pending.length) {
    if (!shouldContinue()) return;
    const file = pending.pop()!, info = await fs.promises.lstat(file);
    sourceHash.update(JSON.stringify([file, info.mode, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
    if (info.isDirectory() && !info.isSymbolicLink()) pending.push(...(await fs.promises.readdir(file)).sort().map(name => path.join(file, name)));
    else if (info.isFile() && file === path.join(sourceRoot, 'review.lock')) {
      try {
        const owner = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        sourceHash.update(JSON.stringify({ ownerAlive: store.historicalRunOwnerAlive({ agentPid: owner.pid, processBirth: owner.processStart ? `proc:${owner.processStart}` : '' }) }));
      } catch { sourceHash.update('invalid-review-lock'); }
    }
  }
  const signature = crypto.createHash('sha256').update(JSON.stringify({ sourceRoot, projectScopes, stamp: sourceHash.digest('hex') })).digest('hex');
  if (shouldContinue()) await operations({ operation: 'import_project_data', input: { collection: 'learning-review', sourceRoot, projectScopes, archiveUnresolved: true, idempotencyKey: `startup-learning-review-v3:${signature}` } });
}

async function enqueueStartupStrategyMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const sourceRoot = path.join(store.root, 'strategy');
  try { if (!(await fs.promises.stat(sourceRoot)).isDirectory()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const mappings: Array<[string, string]> = [];
  for (const projectRoot of store.existingRegisteredProjectRoots()) {
    if (!shouldContinue()) return;
    try {
      const registered = await store.registerProject({ root: projectRoot });
      mappings.push([projectRoot, registered.projectId]);
    } catch (error) { process.stderr.write(`SoloMap strategy project discovery: ${projectRoot}: ${String(error)}\n`); }
  }
  const projectScopes = Object.fromEntries(mappings.sort(([a], [b]) => a.localeCompare(b)));
  const signature = crypto.createHash('sha256').update(JSON.stringify({ sourceRoot, projectScopes })).digest('hex');
  if (shouldContinue()) await operations({ operation: 'import_project_data', input: { collection: 'strategy', sourceRoot, projectScopes, idempotencyKey: `startup-strategy-v1:${signature}` } });
}

async function enqueueStartupLearningMigration(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean): Promise<void> {
  const sourceRoot = path.join(store.root, 'learning');
  try { if (!(await fs.promises.stat(sourceRoot)).isDirectory()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const mappings: Array<[string, string]> = [];
  for (const projectRoot of store.existingRegisteredProjectRoots()) {
    if (!shouldContinue()) return;
    try {
      const project = await store.registerProject({ root: projectRoot });
      mappings.push([path.resolve(projectRoot), project.projectId]);
    } catch (error) { process.stderr.write(`SoloMap learning project discovery: ${projectRoot}: ${String(error)}\n`); }
  }
  const projectScopes = Object.fromEntries(mappings.sort(([a], [b]) => a.localeCompare(b)));
  const signature = crypto.createHash('sha256').update(JSON.stringify({ sourceRoot, projectScopes })).digest('hex');
  if (shouldContinue()) await operations({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes, archiveUnresolved: true, idempotencyKey: `startup-learning-v4:${signature}` } });
}

async function enqueueStartupProjectMigrations(store: UnifiedDataStore, operations: MigrationOperations, shouldContinue: () => boolean, selectedProjectRoot?: string, includeLegacyProjectFiles = true): Promise<void> {
  let projects: Array<{ path: string }> = store.existingRegisteredProjectRoots().map(projectPath => ({ path: projectPath }));
  try {
    const registry = (await store.initializeProjectRegistry()).registry;
    const known = new Set(projects.map(project => path.resolve(project.path)));
    for (const project of registry.projects) {
      const projectPath = String(project?.path || '');
      if (path.isAbsolute(projectPath) && !known.has(path.resolve(projectPath))) projects.push({ path: projectPath });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap growth project registry: ${String(error)}\n`);
  }
  if (selectedProjectRoot) {
    const selectedPhysical = await fs.promises.realpath(selectedProjectRoot);
    projects = projects.filter(project => {
      try { return fs.realpathSync(project.path) === selectedPhysical; } catch { return false; }
    });
  }
  const discoveredOwners = discoverLegacyRunProcesses(undefined, true);
  for (const project of projects) {
    if (!shouldContinue()) return;
    const projectRoot = String(project?.path || '');
    if (!path.isAbsolute(projectRoot)) continue;
    let registered: Awaited<ReturnType<UnifiedDataStore['registerProject']>>;
    try {
      registered = await store.registerProject({ root: projectRoot });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap project registration startup: ${projectRoot}: ${String(error)}\n`);
      continue;
    }
    if (store.missingProjectJournalSources(registered.projectId, 1).length) {
      try {
        await operations({ operation: 'import_project_data', input: { collection: 'project-journal', mode: 'unified', sourceRoot: `solomap://${store.databaseId}/${registered.projectId}/project-journal`, projectRoot, idempotencyKey: `startup-journal-projection-v12:${registered.projectId}`, refreshCompleted: true } });
      } catch (error) {
        process.stderr.write(`SoloMap journal projection startup: ${projectRoot}: ${String(error)}\n`);
      }
    }
    const sources = [
      { collection: 'documentation', sourceRoot: path.join(projectRoot, '.solopreneur', 'documentation.json') },
      { collection: 'project-growth', sourceRoot: path.join(projectRoot, '.solopreneur', 'project_growth.db') },
      { collection: 'agent-runs', sourceRoot: path.join(projectRoot, '.solopreneur', 'agent-runs') },
      { collection: 'project-journal', sourceRoot: path.join(projectRoot, '.solopreneur', 'project_journal.db') },
      { collection: 'step-memory', sourceRoot: path.join(projectRoot, '.solopreneur', 'step-memory') },
      { collection: 'run-digests', sourceRoot: path.join(projectRoot, '.solopreneur', 'run-digests') },
      ...(includeLegacyProjectFiles ? [{ collection: 'project-legacy-files', sourceRoot: path.join(projectRoot, '.solopreneur') }] : [])
    ];
    for (const source of sources) {
      if (source.collection !== 'agent-runs' && source.collection !== 'project-legacy-files') {
        try {
          const info = await fs.promises.lstat(source.sourceRoot);
          if (info.isSymbolicLink() || !info[['step-memory', 'run-digests'].includes(source.collection) ? 'isDirectory' : 'isFile']()) continue;
        }
        catch { continue; }
      }
      let legacyStamp = '';
      if (source.collection === 'project-legacy-files') {
        try {
          const current = await legacyProjectFilesStamp(projectRoot);
          if (!current.count) continue;
          legacyStamp = current.stamp;
        } catch { continue; }
      }
      const version = source.collection === 'agent-runs' ? 10 : source.collection === 'project-journal' ? 8 : source.collection === 'project-growth' ? 3 : source.collection === 'documentation' ? 3 : ['step-memory', 'run-digests', 'project-legacy-files'].includes(source.collection) ? 2 : 1;
      const stamp = source.collection === 'agent-runs'
        ? await historicalRunSourceStamp(store, [source.sourceRoot, path.join(projectRoot, '.solopreneur', 'agent-status'), path.join(projectRoot, '.agent_status.json')], shouldContinue, discoveredOwners)
        : source.collection === 'documentation'
          ? crypto.createHash('sha256').update(await fs.promises.readFile(source.sourceRoot)).digest('hex')
          : legacyStamp;
      if (!shouldContinue()) return;
      const input = { ...source, projectRoot, archiveUnresolved: true, idempotencyKey: `startup-${source.collection}-v${version}:${projectRoot}${stamp ? `:${stamp}` : ''}` };
      try {
        const current = await operations({ operation: 'import_project_data', input }) as { status?: string };
        if (source.collection === 'agent-runs' && current?.status === 'completed_with_conflicts') {
          await operations({ operation: 'import_project_data', input: { ...input, idempotencyKey: `startup-agent-runs-v11:${projectRoot}${stamp ? `:${stamp}` : ''}` } });
        }
      } catch (error) {
        process.stderr.write(`SoloMap ${source.collection} migration startup: ${projectRoot}: ${String(error)}\n`);
      }
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
  const projects: Array<{ path: string; name?: string }> = store.existingRegisteredProjectRoots().map(projectPath => ({ path: projectPath }));
  try {
    const registry = (await store.initializeProjectRegistry()).registry;
    const known = new Set(projects.map(project => path.resolve(project.path)));
    for (const project of registry.projects) {
      if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) continue;
      const projectPath = path.resolve(project.path);
      if (known.has(projectPath)) continue;
      projects.push(project);
      known.add(projectPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap memory project registry: ${String(error)}\n`);
  }
  const legacySlugs = new Map<string, Set<string>>();
  const legacySlug = (root: string) => path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  for (const project of projects) {
    if (!shouldContinue()) return;
    if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) continue;
    const slug = legacySlug(project.path);
    if (!legacySlugs.has(slug)) legacySlugs.set(slug, new Set());
    let physicalRoot = path.resolve(project.path);
    try { physicalRoot = await fs.promises.realpath(project.path); }
    catch { /* Unavailable locations still keep their ambiguous ownership claim. */ }
    legacySlugs.get(slug)!.add(physicalRoot);
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
  await operations({ operation: 'import_memory', input: { sourceRoot, projectScopes, archiveUnresolved: true, idempotencyKey: `startup-memory-v3:${signature}` } });
}
