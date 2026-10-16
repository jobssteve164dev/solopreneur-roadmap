import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RecyclingItem, UnifiedDataStore } from './db/unifiedDataStore';
import { isRetirableRunArtifact } from './projectDataMigration';
import { discoverLegacyRunProcesses } from './legacyRunProcessRecovery.js';
import { isRetiredProjectFile } from './legacyProjectFileMigration.js';
import { isGlobalRetiredDataKey } from './globalRetiredDataMigration.js';

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const conversationKey = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
const isRoadmapCsv = (file: string) => path.basename(path.resolve(file)).toLowerCase() === 'roadmap.csv';
export interface MigrationProjectScope { root: string; projectId: string; physicalRoot: string }
type RegisteredProjectScope = { root: string; projectId: string };
type CandidateSource = Pick<RecyclingItem, 'identity' | 'key'> & { kind?: string };
type AnchoredDirectory = { handle: fs.promises.FileHandle; path: string };
type VerifiedSource = { bytes: Buffer; stat: fs.Stats; symbolicLink: boolean };

/** Only collections whose writers and readers use the database may be retired. */
export class MigrationRecycling {
  private busy = new Set<string>();
  private matches = new Map<string, { hash: string; revision: number; matches: boolean }>();
  private fileChecks = new Map<string, { hash: string; device: number; inode: number; size: number; mtime: number; ctime: number }>();
  constructor(private readonly store: UnifiedDataStore) {}

  private sourceIdentities(scope: MigrationProjectScope): string[] {
    const roots = [...new Set([path.resolve(scope.root), scope.physicalRoot])];
    return [...roots.flatMap(root => [
      `documentation:${root}`, `project-journal:${root}`, `project-growth:${root}`, `agent-runs:${root}`,
      `project-agent-status:${root}`, `agent-status:${root}`, `native-session-history:${root}`, `historical-journal-output:${root}`,
      `project-legacy-files:${root}`
    ]), `step-memory:${scope.projectId}`, `run-digests:${scope.projectId}`];
  }
  private belongsToProject(identity: string, scope?: MigrationProjectScope): boolean {
    return !scope || this.sourceIdentities(scope).includes(identity);
  }

  private sourcePath(identity: string, key: string, projects?: RegisteredProjectScope[]): string | null {
    const normalizedKey = key.split(path.sep).join('/');
    const containedFile = (root: string): string | null => {
      const file = path.resolve(root, key), relative = path.relative(path.resolve(root), file);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
    };
    if (identity.startsWith('intelligence:')) return path.join(identity.slice('intelligence:'.length), key);
    if (identity.startsWith('global-retired:')) {
      if (!isGlobalRetiredDataKey(normalizedKey)) return null;
      return containedFile(identity.slice('global-retired:'.length));
    }
    if (identity.startsWith('local-diagnostics:')) {
      if (!/^diagnostics\/(?:\d{4}-\d{2}-\d{2}\/)?recent-(?:errors|operations)(?:\.\d+-[a-f0-9]{8})?\.json$/i.test(normalizedKey)) return null;
      return containedFile(identity.slice('local-diagnostics:'.length));
    }
    if (identity.startsWith('runtime-state:')) {
      if (!new Set(['runtime/cognitive-config.json', 'runtime/state.json', 'runtime/today-shadow.json', 'runtime/shadow-evaluation.json', 'runtime/shadow-feedback.jsonl', 'runtime/scheduled-tasks/scheduled-tasks.json', 'scheduled-tasks/scheduled-tasks.json']).has(normalizedKey)) return null;
      return containedFile(identity.slice('runtime-state:'.length));
    }
    if (identity.startsWith('project-registry:')) {
      if (normalizedKey !== 'projects.json') return null;
      return containedFile(identity.slice('project-registry:'.length));
    }
    if (identity.startsWith('analysis-caches:')) {
      const root = identity.slice('analysis-caches:'.length), local = containedFile(root);
      if (local) return local;
      const file = path.resolve(root, key);
      const isExternalCache = new Set(['issues-cache.json', 'pull-requests-cache.json', 'delivery-cache.json', 'security-cache.json']).has(path.basename(file))
        && path.basename(path.dirname(file)) === '.solopreneur';
      const isCoverageCache = path.basename(file) === 'project-growth-coverage.json'
        && path.basename(path.dirname(file)) === 'coverage'
        && path.basename(path.dirname(path.dirname(file))) === '.solopreneur';
      const isTimePlan = path.basename(file) === 'time-plan.json'
        && path.basename(path.dirname(file)) === '.solopreneur';
      if (!isExternalCache && !isCoverageCache && !isTimePlan) return null;
      const projectRoot = isCoverageCache ? path.dirname(path.dirname(path.dirname(file))) : path.dirname(path.dirname(file));
      const registered = (projects ?? this.store.registeredProjectScopes()).some(project => {
        try { return fs.realpathSync(project.root) === fs.realpathSync(projectRoot); } catch { return path.resolve(project.root) === projectRoot; }
      });
      return registered ? file : null;
    }
    for (const collection of ['capabilities', 'learning', 'learning-review', 'memory', 'strategy']) {
      if (identity.startsWith(collection + ':')) return containedFile(identity.slice(collection.length + 1));
    }
    if (identity.startsWith('documentation:')) return key === '.solopreneur/documentation.json'
      ? path.join(identity.slice('documentation:'.length), key) : null;
    if (identity.startsWith('project-legacy-files:')) {
      if (!isRetiredProjectFile(key)) return null;
      const root = path.join(identity.slice('project-legacy-files:'.length), '.solopreneur');
      return containedFile(root);
    }
    if (identity.startsWith('agent-status:')) return /^\d+\.json(?:\.\d+\.(?:\d+|[a-f0-9-]+)\.tmp)?$/i.test(key)
      ? path.join(identity.slice('agent-status:'.length), '.solopreneur', 'agent-status', key) : null;
    if (identity.startsWith('project-agent-status:')) return key === '.agent_status.json'
      ? path.join(identity.slice('project-agent-status:'.length), key) : null;
    for (const collection of ['step-memory', 'run-digests']) if (identity.startsWith(collection + ':')) {
      const projectId = identity.slice(collection.length + 1);
      const roots = [...new Set((projects ?? this.store.registeredProjectScopes()).filter(project => project.projectId === projectId)
        .map(project => { try { return fs.realpathSync(project.root); } catch { return ''; } }).filter(Boolean))];
      if (roots.length !== 1) return null;
      const root = path.join(roots[0], '.solopreneur', collection);
      const file = path.resolve(root, key), relative = path.relative(root, file);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
    }
    for (const collection of ['project-journal', 'project-growth']) if (identity.startsWith(collection + ':')) {
      const root = identity.slice(collection.length + 1); const expected = collection === 'project-journal' ? 'project_journal.db' : 'project_growth.db';
      return key === expected ? path.join(root, '.solopreneur', key) : null;
    }
    if (identity.startsWith('agent-runs:')) {
      const root = path.join(identity.slice('agent-runs:'.length), '.solopreneur', 'agent-runs');
      const file = path.resolve(root, key); const relative = path.relative(root, file);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
    }
    return null;
  }
  private isGlobalMemoryPath(file: string): boolean {
    const memoryRoot = path.resolve(this.store.root, 'memory');
    const contains = (root: string, candidate: string): boolean => {
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    const resolved = path.resolve(file);
    if (contains(memoryRoot, resolved)) return true;
    try { return contains(fs.realpathSync(memoryRoot), this.physicalPath(resolved)); }
    catch { return false; }
  }
  public verifyJobSource(job: { args: Record<string, unknown> }, key: string, scope?: MigrationProjectScope) {
    const collection = String(job.args.collection || '');
    const root = String(job.args.projectRoot || '');
    if (!root || !['project-growth', 'project-journal', 'agent-runs', 'documentation', 'step-memory', 'run-digests', 'project-legacy-files'].includes(collection)) throw new Error('migration_source_scope_mismatch');
    const project = scope || this.store.registeredProjectScopes().map(candidate => {
      try { return { ...candidate, physicalRoot: fs.realpathSync(candidate.root) }; } catch { return null; }
    }).find(candidate => candidate && candidate.physicalRoot === fs.realpathSync(root));
    if (!project || !this.jobBelongsToProject(job, project)) throw new Error('maintenance_scope_denied');
    const identity = ['step-memory', 'run-digests'].includes(collection) ? `${collection}:${project.projectId}` : `${collection}:${root}`;
    if (!this.sourcePath(identity, key)) throw new Error('migration_source_scope_mismatch');
    const captured = this.store.readMigrationSource(identity, key);
    if (hash(captured.bytes) !== captured.hash) throw new Error('migration_source_hash_mismatch');
    return { identity, key, hash: captured.hash, bytes: captured.bytes.length, verified: true, stage: captured.stage };
  }
  private allowedPath(file: string, source?: Pick<RecyclingItem, 'identity' | 'key'> & Partial<Pick<RecyclingItem, 'itemId' | 'restorePath'>>, projects?: RegisteredProjectScope[]): boolean {
    const resolved = path.resolve(file); const recycleRoot = path.join(path.resolve(this.store.root), '.migration-recycle');
    if (resolved.startsWith(recycleRoot + path.sep)) return true;
    if (this.isGlobalMemoryPath(resolved) || isRoadmapCsv(resolved)) return false;
    if (!source) return false;
    if (source.itemId && source.restorePath && path.resolve(source.restorePath) === resolved) {
      const bound = this.store.recyclingItem(source.itemId);
      if (!bound || bound.identity !== source.identity || bound.key !== source.key || bound.restorePath !== resolved) return false;
      try { return this.physicalPath(resolved) === resolved; } catch { return false; }
    }
    const declared = this.sourcePath(source.identity, source.key, projects);
    if (!declared) return false;
    try { return this.physicalSourcePath(source, projects) === resolved; } catch { return false; }
  }

  private physicalSourcePath(source: Pick<RecyclingItem, 'identity' | 'key'>, projects?: RegisteredProjectScope[]): string {
    const declared = this.sourcePath(source.identity, source.key, projects);
    if (!declared) throw new Error('recycling_path_invalid');
    const physical = this.physicalPath(declared);
    const projectIdentity = /^(documentation|project-journal|project-growth|agent-runs|agent-status|project-agent-status|project-legacy-files):(.+)$/.exec(source.identity);
    let projectRoot = projectIdentity?.[2];
    const sharedIdentity = /^(step-memory|run-digests):(.+)$/.exec(source.identity);
    if (sharedIdentity) {
      const roots = [...new Set((projects ?? this.store.registeredProjectScopes()).filter(project => project.projectId === sharedIdentity[2])
        .map(project => { try { return fs.realpathSync(project.root); } catch { return ''; } }).filter(Boolean))];
      if (roots.length !== 1) throw new Error('recycling_path_invalid');
      projectRoot = roots[0];
    }
    if (projectRoot && physical !== path.resolve(fs.realpathSync(projectRoot), path.relative(path.resolve(projectRoot), declared))) throw new Error('recycling_path_invalid');
    return physical;
  }

  private physicalPath(file: string): string {
    const original = path.dirname(file); let directory = original;
    for (;;) {
      try {
        const stat = fs.lstatSync(directory);
        if (directory === original && stat.isSymbolicLink()) throw new Error('recycling_path_invalid');
        if (!fs.statSync(directory).isDirectory()) throw new Error('recycling_path_invalid');
        return path.join(fs.realpathSync(directory), path.relative(directory, original), path.basename(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
        directory = path.dirname(directory);
      }
    }
  }

  private async safeDirectory(directory: string, create = false): Promise<void> {
    if (create) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.promises.realpath(this.store.root);
    const expected = path.join(root, path.basename(directory));
    if ((await fs.promises.lstat(directory)).isSymbolicLink() || await fs.promises.realpath(directory) !== expected) throw new Error('recycling_path_invalid');
  }
  private async openAnchoredDirectory(directory: string): Promise<AnchoredDirectory> {
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : '';
    if (!descriptorRoot) throw new Error('recycling_secure_path_unsupported');
    const expected = path.resolve(directory);
    const before = await fs.promises.lstat(expected);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('recycling_path_invalid');
    const directoryFlag = Number((fs.constants as unknown as Record<string, number>).O_DIRECTORY || 0);
    const noFollowFlag = Number((fs.constants as unknown as Record<string, number>).O_NOFOLLOW || 0);
    const handle = await fs.promises.open(expected, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
      const opened = await handle.stat();
      const anchored = path.join(descriptorRoot, String(handle.fd));
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || await fs.promises.realpath(anchored) !== expected) throw new Error('recycling_path_invalid');
      return { handle, path: anchored };
    } catch (error) { await handle.close(); throw error; }
  }
  private async renameAnchored(source: string, target: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): Promise<{ source: fs.Stats; target: fs.Stats }> {
    const sourceDirectory = await this.openAnchoredDirectory(path.dirname(source));
    let targetDirectory: AnchoredDirectory | undefined;
    try {
      targetDirectory = await this.openAnchoredDirectory(path.dirname(target));
      const anchoredSource = path.join(sourceDirectory.path, path.basename(source));
      const anchoredTarget = path.join(targetDirectory.path, path.basename(target));
      const sourceStat = await fs.promises.lstat(anchoredSource);
      if (sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino) throw new Error('recycling_source_changed');
      try { await fs.promises.lstat(anchoredTarget); throw new Error('recycling_target_exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.promises.rename(anchoredSource, anchoredTarget);
      const targetStat = await fs.promises.lstat(anchoredTarget);
      if (sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino || targetStat.dev !== expected.dev || targetStat.ino !== expected.ino) {
        try {
          await fs.promises.link(anchoredTarget, anchoredSource);
          await fs.promises.unlink(anchoredTarget);
        } catch { /* Keep the unexpected inode in the private hold area for formal recovery. */ }
        throw new Error('recycling_source_changed');
      }
      return { source: sourceStat, target: targetStat };
    } finally {
      await targetDirectory?.handle.close().catch(() => undefined);
      await sourceDirectory.handle.close().catch(() => undefined);
    }
  }
  private async linkAnchored(source: string, target: string): Promise<{ source: fs.Stats; target: fs.Stats; created: boolean }> {
    const sourceDirectory = await this.openAnchoredDirectory(path.dirname(source));
    let targetDirectory: AnchoredDirectory | undefined;
    try {
      targetDirectory = await this.openAnchoredDirectory(path.dirname(target));
      const anchoredSource = path.join(sourceDirectory.path, path.basename(source));
      const anchoredTarget = path.join(targetDirectory.path, path.basename(target));
      const sourceStat = await fs.promises.lstat(anchoredSource);
      let created = true;
      try { await fs.promises.link(anchoredSource, anchoredTarget); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        created = false;
      }
      const targetStat = await fs.promises.lstat(anchoredTarget);
      return { source: sourceStat, target: targetStat, created };
    } finally {
      await targetDirectory?.handle.close().catch(() => undefined);
      await sourceDirectory.handle.close().catch(() => undefined);
    }
  }
  private async verifiedFileRecord(file: string, expectedHash: string, source?: Pick<RecyclingItem, 'identity' | 'key'>, projects?: RegisteredProjectScope[]): Promise<VerifiedSource> {
    if (!this.allowedPath(file, source, projects)) throw new Error('recycling_path_invalid');
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('recycling_path_invalid');
    const bytes = await fs.promises.readFile(file);
    const after = await fs.promises.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || hash(bytes) !== expectedHash) throw new Error('recycling_source_changed');
    return { bytes, stat: after, symbolicLink: false };
  }
  private async verifiedFile(file: string, expectedHash: string, source?: Pick<RecyclingItem, 'identity' | 'key'>, projects?: RegisteredProjectScope[]): Promise<Buffer> {
    return (await this.verifiedFileRecord(file, expectedHash, source, projects)).bytes;
  }
  private symbolicLinkSource(source: CandidateSource): boolean {
    return (source.kind ?? this.store.migrationSourceKind(source.identity, source.key)) === 'symlink';
  }
  private async verifiedSourceRecord(file: string, expectedHash: string, source: CandidateSource, projects?: RegisteredProjectScope[]): Promise<VerifiedSource> {
    if (!this.symbolicLinkSource(source)) return this.verifiedFileRecord(file, expectedHash, source, projects);
    if (!this.allowedPath(file, source, projects)) throw new Error('recycling_path_invalid');
    const before = await fs.promises.lstat(file);
    if (!before.isSymbolicLink()) throw new Error('recycling_path_invalid');
    const target = await fs.promises.readlink(file), bytes = Buffer.from(target, 'utf8');
    const after = await fs.promises.lstat(file);
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || await fs.promises.readlink(file) !== target || hash(bytes) !== expectedHash) throw new Error('recycling_source_changed');
    return { bytes, stat: after, symbolicLink: true };
  }
  private async verifiedSource(file: string, expectedHash: string, source: CandidateSource, projects?: RegisteredProjectScope[]): Promise<Buffer> {
    return (await this.verifiedSourceRecord(file, expectedHash, source, projects)).bytes;
  }
  private async candidateSize(file: string, expectedHash: string, source: CandidateSource, projects?: RegisteredProjectScope[]): Promise<number> {
    // candidates() resolves this path immediately before and after the read;
    // the file identity checks below bind every byte between those boundaries.
    const stat = await fs.promises.lstat(file);
    if (this.symbolicLinkSource(source)) {
      if (!stat.isSymbolicLink()) throw new Error('recycling_path_invalid');
      return (await this.verifiedSource(file, expectedHash, source, projects)).length;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('recycling_path_invalid');
    const previous = this.fileChecks.get(file);
    if (previous?.hash === expectedHash && previous.device === stat.dev && previous.inode === stat.ino && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs) return stat.size;
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const handle = await fs.promises.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw new Error('recycling_source_changed');
      let position = 0;
      while (position < opened.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (!bytesRead) throw new Error('recycling_source_changed');
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const closedOver = await handle.stat();
      if (closedOver.dev !== opened.dev || closedOver.ino !== opened.ino || closedOver.size !== opened.size || closedOver.mtimeMs !== opened.mtimeMs || closedOver.ctimeMs !== opened.ctimeMs || digest.digest('hex') !== expectedHash) throw new Error('recycling_source_changed');
    } finally { await handle.close(); }
    const after = await fs.promises.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.size !== after.size) throw new Error('recycling_source_changed');
    this.fileChecks.set(file, { hash: expectedHash, device: after.dev, inode: after.ino, size: after.size, mtime: after.mtimeMs, ctime: after.ctimeMs });
    return after.size;
  }
  private matchesConversation(key: string, bytes: Buffer): boolean {
    try {
      const old = JSON.parse(bytes.toString('utf8'));
      const current = this.store.readIntelligenceConversation(key.slice(0, -5))?.conversation;
      return Boolean(current && old.id === current.id && new Date(old.createdAt).getTime() === new Date(current.createdAt).getTime()
        && Array.isArray(old.messages) && old.messages.length <= current.messages.length
        && old.messages.every((message: { role?: unknown; content?: unknown }, index: number) => message.role === current.messages[index].role && message.content === current.messages[index].content));
    } catch { return false; }
  }
  private capturedConversationMatches(source: { identity: string; key: string; hash: string }): boolean {
    let revision: number;
    try { revision = this.store.readMetadata(source.key.slice(0, -5)).revision; }
    catch { return false; }
    const cacheKey = source.identity + '/' + source.key;
    const cached = this.matches.get(cacheKey);
    if (cached?.hash === source.hash && cached.revision === revision) return cached.matches;
    const matches = this.matchesConversation(source.key, this.store.readMigrationSource(source.identity, source.key).bytes);
    this.matches.set(cacheKey, { hash: source.hash, revision, matches });
    return matches;
  }
  private legacyOwnerAlive(root: string, nodeId: string, executionLogId?: number): boolean {
    const nodeRoot = path.join(root, '.solopreneur', 'agent-runs', nodeId);
    const files = [path.join(root, '.agent_status.json'), path.join(nodeRoot, '.agent_status.json')];
    if (executionLogId !== undefined) files.push(path.join(root, '.solopreneur', 'agent-status', `${executionLogId}.json`), path.join(nodeRoot, String(executionLogId), '.agent_status.json'));
    for (const file of files) {
      try {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink()) return true;
        if (fs.realpathSync(file) !== path.resolve(fs.realpathSync(root), path.relative(root, file))) return true;
        const status = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (status.nodeId !== nodeId) continue;
        if (executionLogId !== undefined && Number(status.rootExecutionLogId || status.executionLogId) !== executionLogId) continue;
        if (executionLogId === undefined && file !== path.join(nodeRoot, '.agent_status.json') && !['promptFilePath', 'outputFilePath'].some(field => status[field] && path.dirname(path.resolve(String(status[field]))) === nodeRoot)) continue;
        if (this.store.historicalRunOwnerAlive(status)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) continue;
        return true;
      }
    }
    return discoverLegacyRunProcesses(root).some(owner => owner.runDirectory === nodeRoot
      || executionLogId !== undefined && owner.executionLogId === executionLogId && path.dirname(owner.runDirectory) === nodeRoot);
  }
  private runSourceRetirable(source: CandidateSource, projects?: RegisteredProjectScope[]): boolean {
    if (!isRetirableRunArtifact(source.key) && !['prompt', 'output', 'control', 'session', 'change_evidence', 'report'].includes(source.kind ?? this.store.migrationSourceKind(source.identity, source.key))) return false;
    const root = source.identity.slice('agent-runs:'.length);
    const project = (projects ?? this.store.registeredProjectScopes()).find(project => {
      try { return fs.realpathSync(project.root) === fs.realpathSync(root); } catch { return false; }
    });
    if (!source.key.startsWith('learning-tasks/')) {
      const parts = source.key.split(/[\\/]/);
      const executionLogId = parts.length === 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : undefined;
      if (executionLogId !== undefined && (!project || !this.store.historicalRunIndexHasOwner(project.projectId, executionLogId))) return false;
      return !this.legacyOwnerAlive(root, parts[0], executionLogId);
    }
    try {
      if (!project) return false;
      const original = JSON.parse(this.store.readMigrationSource(source.identity, source.key).bytes.toString('utf8'));
      if (original.schemaVersion !== 1 || typeof original.taskId !== 'string' || source.key !== `learning-tasks/${original.taskId}.json`) return false;
      const task = this.store.readRegisteredReportSources(project.projectId, { taskId: original.taskId, metadataOnly: true }).tasks[0];
      if (!task || !Array.isArray(original.executions)) return false;
      return original.executions.every((execution: { id: number }) => {
        const source = this.store.resolveRunConversation(project.projectId, Number(execution.id));
        return Boolean(source && source.state.taskId === task.sourceRef.objectId && !this.legacyOwnerAlive(root, String(source.state.status.nodeId), Number(source.state.status.rootExecutionLogId)));
      });
    } catch { return false; }
  }
  private legacyRunEvidenceInUse(source: CandidateSource): boolean {
    if (!source.identity.startsWith('project-legacy-files:')) return false;
    const root = source.identity.slice('project-legacy-files:'.length);
    const normalized = source.key.split(path.sep).join('/');
    const owners = discoverLegacyRunProcesses(root);
    if (normalized.startsWith('agent-runs/')) {
      const file = path.resolve(root, '.solopreneur', ...normalized.split('/'));
      return owners.some(owner => file === owner.runDirectory || file.startsWith(owner.runDirectory + path.sep));
    }
    const status = /^agent-status\/(\d+)\.json$/.exec(normalized);
    if (!status) return false;
    if (owners.some(owner => owner.executionLogId === Number(status[1]))) return true;
    try { return this.store.historicalRunOwnerAlive(JSON.parse(fs.readFileSync(path.join(root, '.solopreneur', ...normalized.split('/')), 'utf8'))); }
    catch { return false; }
  }
  private async candidates(scope?: MigrationProjectScope): Promise<Array<Omit<RecyclingItem, 'itemId' | 'planId' | 'status' | 'error'>>> {
    const identities = scope ? new Set(this.sourceIdentities(scope)) : undefined;
    const belongs = (identity: string) => !identities || identities.has(identity);
    const active = this.store.recyclingItems().filter(item => belongs(item.identity) && ['approved', 'moving', 'held', 'restoring'].includes(item.status));
    const occupied = new Set<string>();
    for (const item of active) {
      // The approved path is already physical for new plans. Older receipts
      // continue to reserve their source while it is held or being restored.
      try { occupied.add(this.physicalPath(item.path)); } catch { occupied.add(item.path); }
    }
    const files = [];
    let registeredProjects: RegisteredProjectScope[] | undefined;
    const projectSnapshot = () => registeredProjects ||= this.store.registeredProjectScopes();
    for (const source of this.store.recyclingCandidateSources(scope ? [...identities!] : undefined).filter(source => belongs(source.identity))) {
      const projects = /^(analysis-caches|step-memory|run-digests|agent-runs):/.test(source.identity) ? projectSnapshot() : undefined;
      const file = this.sourcePath(source.identity, source.key, projects);
      if (!file || this.isGlobalMemoryPath(file) || isRoadmapCsv(file) || active.some(item => item.path === file)) continue;
      if (this.legacyRunEvidenceInUse(source)) continue;
      if (source.identity.startsWith('intelligence:')) {
        if (!conversationKey.test(source.key) || !this.capturedConversationMatches(source)) continue;
      } else if (source.stage !== 'imported' || (source.identity.startsWith('agent-runs:') && !this.runSourceRetirable(source, projects))) continue;
      if (/^(project-journal|project-growth):/.test(source.identity) && !this.store.migrationSourceState(source.identity, source.key)?.reconciled) continue;
      try {
        const physical = this.physicalSourcePath(source, projects);
        if (isRoadmapCsv(physical)) continue;
        if (occupied.has(physical)) continue;
        const bytes = await this.candidateSize(physical, source.hash, source, projects);
        if (this.physicalSourcePath(source, projects) !== physical) throw new Error('recycling_path_invalid');
        files.push({ identity: source.identity, key: source.key, hash: source.hash, path: physical, bytes });
        occupied.add(physical);
      } catch { /* Changed, missing, or unsafe sources stay outside the recyclable list. */ }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return files;
  }
  public async overview(scope?: MigrationProjectScope) {
    const jobs = this.store.migrationJobSummaries().filter(job => !scope || this.jobBelongsToProject(job, scope));
    const allRecycling = this.store.recyclingItems().filter(item => this.belongsToProject(item.identity, scope));
    const intelligenceIdentity = `intelligence:${path.join(this.store.root, 'intelligence-conversations')}`;
    const sourceOverview = this.store.migrationSourceOverview(intelligenceIdentity, scope ? this.sourceIdentities(scope) : undefined);
    const recycling: RecyclingItem[] = [];
    for (const item of allRecycling) {
      if (item.status === 'prepared') continue;
      if (item.status === 'restored') {
        try { await fs.promises.lstat(path.join(this.store.root, '.migration-recycle', item.itemId + '.restore')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.store.recyclingRestoreStage(item.itemId)) continue; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      recycling.push(item);
    }
    return { jobs, ...sourceOverview,
      recyclableFiles: 0, recyclableBytes: 0,
      recycledFiles: recycling.filter(item => item.status === 'trashed').length,
      heldFiles: recycling.filter(item => ['moving', 'held'].includes(item.status)).length,
      recycling: recycling.map(({ identity, key, hash: _hash, ...item }) => item),
      recoveryConflicts: this.store.recyclingRestoreConflicts().filter(conflict => allRecycling.some(item => item.itemId === conflict.itemId)) };
  }
  public jobBelongsToProject(job: { args: Record<string, unknown> }, scope: MigrationProjectScope): boolean {
    const root = typeof job.args.projectRoot === 'string' ? job.args.projectRoot : '';
    if (!root) return false;
    try { return fs.realpathSync(root) === scope.physicalRoot; } catch { return path.resolve(root) === path.resolve(scope.root); }
  }
  public async prepare(scope?: MigrationProjectScope) { return this.store.createRecyclingPlan(await this.candidates(scope)); }
  public discardPlan(planId: string) { return { discarded: true, ...this.store.discardPreparedRecyclingPlan(planId) }; }
  public readPlan(planId: string, scope?: MigrationProjectScope) {
    let requiresConfirmation = false;
    const files = this.store.recyclingItems().filter(item => item.planId === planId).map(item => {
      const declared = this.sourcePath(item.identity, item.key);
      if (declared && item.path === declared && this.physicalPath(declared) !== item.path && ['prepared', 'approved'].includes(item.status)) {
        requiresConfirmation = true;
        return { ...item, path: this.physicalPath(declared) };
      }
      return item;
    });
    if (!files.length) throw new Error('recycling_plan_missing');
    if (scope && files.some(item => !this.belongsToProject(item.identity, scope))) throw new Error('maintenance_scope_denied');
    return { planId, files, requiresConfirmation };
  }
  public confirm(planId: string, reviewed?: Array<{ itemId: string; path: string; hash: string; bytes: number }>, scope?: MigrationProjectScope) {
    const files = this.store.recyclingItems().filter(item => item.planId === planId);
    if (!files.length) throw new Error('recycling_plan_missing');
    const preview = this.readPlan(planId, scope);
    if (preview.requiresConfirmation && !reviewed) throw new Error('recycling_path_identity_unavailable');
    if (reviewed && (reviewed.length !== preview.files.length || new Set(reviewed.map(file => file.itemId)).size !== reviewed.length || preview.files.some(file => !reviewed.some(value => value.itemId === file.itemId && value.path === file.path && value.hash === file.hash && value.bytes === file.bytes)))) throw new Error('recycling_source_changed');
    const approvals = files.filter(item => ['prepared', 'approved'].includes(item.status)).map(item => {
      const current = preview.files.find(file => file.itemId === item.itemId)!;
      this.assertReconciled(current);
      if (current.path === item.path) this.bindItemPath(item);
      return { itemId: item.itemId, expectedPath: item.path, path: current.path, changed: item.status === 'prepared' || current.path !== item.path };
    }).filter(item => item.changed);
    this.store.approveRecyclingFiles(approvals);
    return { confirmed: true };
  }
  private item(itemId: string): RecyclingItem {
    const item = this.store.recyclingItem(itemId);
    if (!item) throw new Error('recycling_item_missing');
    return item.restorePath ? { ...item, path: item.restorePath } : this.bindItemPath(item);
  }
  private bindItemPath(item: RecyclingItem): RecyclingItem {
    const declared = this.sourcePath(item.identity, item.key);
    if (!declared) throw new Error('recycling_path_invalid');
    const physical = this.physicalSourcePath(item);
    if (physical !== item.path) {
      if (item.path !== declared || this.physicalSourcePath(item) !== physical) throw new Error('recycling_path_invalid');
      // A later import cannot reconstruct the location approved in an old receipt.
      throw new Error('recycling_path_identity_unavailable');
    }
    return item;
  }
  private heldPath(item: RecyclingItem): string { return path.join(this.store.root, '.migration-recycle', item.itemId + '.json'); }
  private assertReconciled(item: RecyclingItem): void {
    const source = this.store.recyclingSourceState(item);
    if (!source || source.hash !== item.hash || !source.reconciled || source.stage === 'conflict') throw new Error('recycling_source_not_reconciled');
    if (item.identity.startsWith('intelligence:')) {
      if (!conversationKey.test(item.key) || !this.capturedConversationMatches(item)) throw new Error('recycling_database_mismatch');
    } else if (source.stage !== 'imported' || (item.identity.startsWith('agent-runs:') && !this.runSourceRetirable(item))) {
      throw new Error('recycling_source_not_reconciled');
    }
  }
  private async safeRestoreDirectory(item: RecyclingItem): Promise<void> {
    const declared = this.sourcePath(item.identity, item.key);
    if (!item.restorePath && (!declared || this.physicalSourcePath(item) !== item.path)) throw new Error('recycling_path_invalid');
    if (this.physicalPath(item.path) !== item.path) throw new Error('recycling_path_invalid');
    const directory = path.dirname(item.path);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== path.resolve(directory)) throw new Error('recycling_path_invalid');
  }
  private async restoreSymbolicLink(item: RecyclingItem, bytes: Buffer, forceSymbolicLink = false): Promise<{ restored: true; path: string; retainedCopy?: string }> {
    const expectedHash = hash(bytes), target = bytes.toString('utf8');
    const symbolicItem: CandidateSource = forceSymbolicLink ? { ...item, kind: 'symlink' } : item;
    if (!Buffer.from(target, 'utf8').equals(bytes) || target.includes('\0')) throw new Error('recycling_snapshot_changed');
    const staged = path.join(this.store.root, '.migration-recycle', item.itemId + '.restore');
    if (item.status === 'restored') {
      await this.verifiedSource(item.path, expectedHash, symbolicItem);
      try {
        await this.verifiedSource(staged, expectedHash, symbolicItem);
        await fs.promises.unlink(staged);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.clearLocalRestoreStage(item.itemId, true);
      return { restored: true, path: item.path };
    }
    await this.safeRestoreDirectory(item);
    await this.safeDirectory(path.dirname(staged), true);
    if (item.status !== 'restoring') {
      try { await fs.promises.lstat(item.path); throw new Error('restore_target_exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await this.verifiedSource(staged, expectedHash, symbolicItem); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.promises.symlink(target, staged);
        await this.verifiedSource(staged, expectedHash, symbolicItem);
      }
      this.store.setRecyclingStatus(item.itemId, 'restoring');
    } else await this.verifiedSource(staged, expectedHash, symbolicItem);
    let publishing = staged;
    let published: { source: fs.Stats; target: fs.Stats; created: boolean };
    try {
      try { published = await this.linkAnchored(publishing, item.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        publishing = await this.localRestoreStage(item, bytes, true);
        published = await this.linkAnchored(publishing, item.path);
      }
    }
    catch (error) { throw error; }
    if (!published.source.isSymbolicLink() || !published.target.isSymbolicLink()
      || published.source.dev !== published.target.dev || published.source.ino !== published.target.ino) throw new Error('restore_target_exists');
    await this.verifiedSource(item.path, expectedHash, symbolicItem);
    try {
      await this.verifiedSource(this.heldPath(item), expectedHash, symbolicItem);
      await fs.promises.unlink(this.heldPath(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.store.setRecyclingStatus(item.itemId, 'changed', 'restored_with_retained_copy');
        return { restored: true, path: item.path, retainedCopy: this.heldPath(item) };
      }
    }
    this.store.setRecyclingStatus(item.itemId, 'restored');
    await fs.promises.unlink(staged);
    await this.clearLocalRestoreStage(item.itemId, true);
    return { restored: true, path: item.path };
  }
  private async exclusive<T>(itemId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(itemId)) throw new Error('recycling_operation_in_progress');
    this.busy.add(itemId);
    try { return await work(); } finally { this.busy.delete(itemId); }
  }
  private async exclusiveMany<T>(itemIds: string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(itemIds)];
    if (ids.some(itemId => this.busy.has(itemId))) throw new Error('recycling_operation_in_progress');
    for (const itemId of ids) this.busy.add(itemId);
    try { return await work(); } finally { for (const itemId of ids) this.busy.delete(itemId); }
  }
  private async pruneRetiredProjectDirectories(item: RecyclingItem): Promise<void> {
    let sourceRoot = path.dirname(path.resolve(item.path));
    while (path.basename(sourceRoot) !== '.solopreneur') {
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) return;
      sourceRoot = parent;
    }
    const projectRoot = path.dirname(sourceRoot);
    const registered = this.store.registeredProjectScopes().some(project => {
      try { return fs.realpathSync(project.root) === projectRoot; }
      catch { return false; }
    });
    if (!registered) return;
    const sourceInfo = fs.lstatSync(sourceRoot);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || fs.realpathSync(sourceRoot) !== sourceRoot) return;
    if (item.path !== sourceRoot && !item.path.startsWith(sourceRoot + path.sep)) throw new Error('recycling_path_invalid');
    let directory = path.dirname(item.path);
    while (directory !== sourceRoot && directory.startsWith(sourceRoot + path.sep)) {
      let parent: AnchoredDirectory | undefined;
      try {
        parent = await this.openAnchoredDirectory(path.dirname(directory));
        const anchored = path.join(parent.path, path.basename(directory));
        const info = await fs.promises.lstat(anchored);
        if (!info.isDirectory() || info.isSymbolicLink()) return;
        await fs.promises.rmdir(anchored);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { directory = path.dirname(directory); continue; }
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
        throw error;
      } finally { await parent?.handle.close().catch(() => undefined); }
      directory = path.dirname(directory);
    }
  }
  public async recycleBatch(itemIds: string[]): Promise<{ failures: string[] }> {
    const ids = [...new Set(itemIds)];
    return this.exclusiveMany(ids, async () => {
      const failures = new Set<string>();
      const moving: RecyclingItem[] = [];
      const pruneOnly: RecyclingItem[] = [];
      const held = new Map<string, RecyclingItem>();
      const changed: Array<{ itemId: string; status: 'changed'; error: string }> = [];
      for (const itemId of ids) {
        let item: RecyclingItem;
        try {
          item = this.item(itemId);
          if (item.status === 'restored') continue;
          if (item.status === 'trashed') { pruneOnly.push(item); continue; }
          if (item.status === 'changed') { failures.add(itemId); continue; }
          if (item.status === 'prepared') throw new Error('recycling_confirmation_required');
          if (!['approved', 'moving', 'held'].includes(item.status)) throw new Error('recycling_state_invalid');
          this.assertReconciled(item);
          const target = this.heldPath(item);
          if (['moving', 'held'].includes(item.status)) {
            try {
              await this.verifiedSource(target, item.hash, item);
              held.set(item.itemId, item);
              continue;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              if (item.status === 'held') {
                try { await fs.promises.lstat(item.path); }
                catch (sourceError) {
                  if ((sourceError as NodeJS.ErrnoException).code !== 'ENOENT') throw sourceError;
                  try { fs.lstatSync(target); held.set(item.itemId, item); }
                  catch (targetNow) {
                    if ((targetNow as NodeJS.ErrnoException).code !== 'ENOENT') throw targetNow;
                    try { fs.lstatSync(item.path); moving.push(item); }
                    catch (sourceNow) {
                      if ((sourceNow as NodeJS.ErrnoException).code !== 'ENOENT') throw sourceNow;
                      this.store.setRecyclingStatus(item.itemId, 'trashed');
                      pruneOnly.push(item);
                    }
                  }
                  continue;
                }
              }
            }
          }
        } catch {
          failures.add(itemId);
          continue;
        }
        moving.push(item);
      }
      this.store.setRecyclingStatuses([
        ...moving.map(item => ({ itemId: item.itemId, status: 'moving' as const })),
        ...changed
      ]);

      const moved: RecyclingItem[] = [];
      const moveFailures: Array<{ itemId: string; status: 'changed'; error: string }> = [];
      for (const item of moving) {
        try {
          const target = this.heldPath(item);
          const verified = await this.verifiedSourceRecord(item.path, item.hash, item);
          if (item.identity.startsWith('intelligence:') && !this.matchesConversation(item.key, verified.bytes)) throw new Error('recycling_database_mismatch');
          await this.safeDirectory(path.dirname(target), true);
          try { await fs.promises.lstat(target); throw new Error('recycling_target_exists'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          this.assertReconciled(item);
          const sourceStat = verified.stat;
          const symlink = verified.symbolicLink;
          if (symlink ? !sourceStat.isSymbolicLink() : !sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) throw new Error('recycling_path_invalid');
          if (this.physicalSourcePath(item) !== item.path) throw new Error('recycling_path_invalid');
          const movedIdentity = await this.renameAnchored(item.path, target, sourceStat);
          if (movedIdentity.source.dev !== sourceStat.dev || movedIdentity.source.ino !== sourceStat.ino) throw new Error('recycling_source_changed');
          const targetStat = movedIdentity.target;
          if (symlink ? !targetStat.isSymbolicLink() : !targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) throw new Error('recycling_source_changed');
          if (targetStat.dev !== sourceStat.dev || targetStat.ino !== sourceStat.ino) throw new Error('recycling_source_changed');
          await this.verifiedSource(target, item.hash, item);
          this.assertReconciled(item);
          moved.push(item);
          held.set(item.itemId, item);
        } catch (error) {
          failures.add(item.itemId);
          moveFailures.push({ itemId: item.itemId, status: 'changed', error: String(error) });
        }
      }
      this.store.setRecyclingStatuses([
        ...moved.map(item => ({ itemId: item.itemId, status: 'held' as const })),
        ...[...held.values()].filter(item => !moved.some(movedItem => movedItem.itemId === item.itemId) && item.status === 'moving')
          .map(item => ({ itemId: item.itemId, status: 'held' as const })),
        ...moveFailures
      ]);

      const retired: RecyclingItem[] = [];
      for (const item of held.values()) {
        try {
          this.assertReconciled(item);
          if (!(await fs.promises.lstat(this.store.filePath)).isFile()) throw new Error('database_restore_required');
          if (this.store.recyclingSnapshot(item.itemId).hash !== item.hash) throw new Error('recycling_snapshot_changed');
          try {
            await this.verifiedSource(this.heldPath(item), item.hash, item);
            this.assertReconciled(item);
            await fs.promises.unlink(this.heldPath(item));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          retired.push(item);
        } catch {
          failures.add(item.itemId);
        }
      }
      this.store.setRecyclingStatuses(retired.map(item => ({ itemId: item.itemId, status: 'trashed' as const })));
      for (const item of [...pruneOnly, ...retired]) await this.pruneRetiredProjectDirectories(item);
      return { failures: [...failures] };
    });
  }
  public async hold(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'prepared') throw new Error('recycling_confirmation_required');
      if (!['approved', 'moving', 'held'].includes(item.status)) throw new Error('recycling_state_invalid');
      this.assertReconciled(item);
      const target = this.heldPath(item);
      if (['moving', 'held'].includes(item.status)) {
        try {
          await this.verifiedSource(target, item.hash, item);
          this.store.setRecyclingStatus(itemId, 'held');
          return { path: target, hash: item.hash };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (item.status === 'held') {
          try { await fs.promises.lstat(item.path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.store.setRecyclingStatus(itemId, 'trashed');
            return { recycled: true };
          }
        }
      }
      try {
        const verified = await this.verifiedSourceRecord(item.path, item.hash, item);
        if (item.identity.startsWith('intelligence:') && !this.matchesConversation(item.key, verified.bytes)) throw new Error('recycling_database_mismatch');
        await this.safeDirectory(path.dirname(target), true);
        try { await fs.promises.lstat(target); throw new Error('recycling_target_exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.assertReconciled(item);
        this.store.setRecyclingStatus(itemId, 'moving');
        const sourceStat = verified.stat;
        const movedIdentity = await this.renameAnchored(item.path, target, sourceStat);
        if (movedIdentity.source.dev !== sourceStat.dev || movedIdentity.source.ino !== sourceStat.ino) throw new Error('recycling_source_changed');
        // A concurrent edit during the move must remain recoverable, never be trashed.
        await this.verifiedSource(target, item.hash, item);
        this.assertReconciled(item);
        this.store.setRecyclingStatus(itemId, 'held');
        return { path: target, hash: item.hash };
      } catch (error) {
        this.store.setRecyclingStatus(itemId, 'changed', String(error));
        throw error;
      }
    });
  }
  public async finish(itemId: string) {
    const item = this.item(itemId);
    if (item.status === 'trashed') { await this.pruneRetiredProjectDirectories(item); return { recycled: true }; }
    if (item.status !== 'held' && item.status !== 'moving') throw new Error('recycling_state_invalid');
    this.assertReconciled(item);
    try { await fs.promises.lstat(this.heldPath(item)); throw new Error('recycling_file_not_trashed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.assertReconciled(item);
    this.store.setRecyclingStatus(itemId, 'trashed');
    await this.pruneRetiredProjectDirectories(item);
    return { recycled: true };
  }
  public async retire(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'trashed') { await this.pruneRetiredProjectDirectories(item); return { recycled: true }; }
      if (item.status !== 'held') throw new Error('recycling_state_invalid');
      this.assertReconciled(item);
      // The immutable committed snapshot is the recovery authority, including when
      // an editor host has no usable operating-system trash implementation.
      if (!(await fs.promises.lstat(this.store.filePath)).isFile()) throw new Error('database_restore_required');
      if (this.store.recyclingSnapshot(itemId).hash !== item.hash) throw new Error('recycling_snapshot_changed');
      try {
        await this.verifiedSource(this.heldPath(item), item.hash, item);
        this.assertReconciled(item);
        await fs.promises.unlink(this.heldPath(item));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.store.setRecyclingStatus(itemId, 'trashed');
      await this.pruneRetiredProjectDirectories(item);
      return { recycled: true };
    });
  }
  public async restore(itemId: string, destination?: string, scope?: MigrationProjectScope) {
    const scopedItem = this.store.recyclingItem(itemId);
    if (!scopedItem) throw new Error('recycling_item_missing');
    if (scope && !this.belongsToProject(scopedItem.identity, scope)) throw new Error('maintenance_scope_denied');
    return this.exclusive(itemId, async () => {
      if (destination !== undefined) {
        if (!path.isAbsolute(destination) || path.resolve(destination) !== destination || this.physicalPath(destination) !== destination) throw new Error('recycling_path_invalid');
        const dataRoot = fs.realpathSync(this.store.root);
        if (destination === this.store.filePath || destination.startsWith(dataRoot + path.sep)) throw new Error('recycling_path_invalid');
        const previous = this.store.recyclingItem(itemId);
        if (!previous) throw new Error('recycling_item_missing');
        if (previous.status === 'restoring' && destination !== (previous.restorePath || previous.path)) {
          const stage = this.store.recyclingRestoreStage(itemId);
          const receipt = stage ? path.join(stage.directory, 'content') : path.join(this.store.root, '.migration-recycle', itemId + '.restore');
          try {
            const [retained, published] = await Promise.all([fs.promises.lstat(receipt), fs.promises.lstat(previous.restorePath || previous.path)]);
            if (retained.dev === published.dev && retained.ino === published.ino) throw new Error('recycling_restore_already_published');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (stage) await this.clearLocalRestoreStage(itemId, this.symbolicLinkSource(previous));
          this.store.bindRecyclingRestorePath(itemId, destination, previous.restorePath ?? null);
        } else this.store.bindRecyclingRestorePath(itemId, destination);
      }
      const item = this.item(itemId);
      if (item.status === 'prepared' || item.status === 'approved') throw new Error('recycling_state_invalid');
      const source = this.store.recyclingSnapshot(itemId);
      if (source.hash !== item.hash) throw new Error('recycling_snapshot_changed');
      if (item.status === 'restored') {
        try {
          const restored = await fs.promises.lstat(item.path);
          if (restored.isSymbolicLink()) return this.restoreSymbolicLink(item, Buffer.from(await fs.promises.readlink(item.path), 'utf8'), true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (item.status === 'restored' && this.symbolicLinkSource(item)) return this.restoreSymbolicLink(item, source.bytes);
      if (item.status === 'restored') {
        if (this.store.recyclingRestoreStage(itemId)) {
          await this.clearLocalRestoreStage(itemId);
          const receipt = path.join(this.store.root, '.migration-recycle', itemId + '.restore');
          try {
            await this.safeDirectory(path.dirname(receipt));
            const stat = await fs.promises.lstat(receipt);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('recycling_path_invalid');
            await fs.promises.unlink(receipt);
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          return { restored: true, path: item.path };
        }
        const receipt = path.join(this.store.root, '.migration-recycle', itemId + '.restore');
        try {
          await this.safeDirectory(path.dirname(receipt));
          const [original, retained] = await Promise.all([fs.promises.lstat(item.path), fs.promises.lstat(receipt)]);
          if (!original.isFile() || original.isSymbolicLink() || !retained.isFile() || retained.isSymbolicLink() || original.dev !== retained.dev || original.ino !== retained.ino) throw new Error('restore_target_exists');
          await fs.promises.unlink(receipt);
          return { restored: true, path: item.path };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('restore_target_exists');
          throw error;
        }
      }
      let bytes = source.bytes;
      let restoreAsSymbolicLink = this.symbolicLinkSource(item);
      // Preserve a late edit found in the held copy, if the move raced with an editor.
      if (item.status === 'changed') {
        try {
          await this.safeDirectory(path.dirname(this.heldPath(item)));
          const stat = await fs.promises.lstat(this.heldPath(item));
          if (stat.isSymbolicLink()) {
            bytes = Buffer.from(await fs.promises.readlink(this.heldPath(item)), 'utf8');
            restoreAsSymbolicLink = true;
          } else {
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recycling_path_invalid');
            bytes = await fs.promises.readFile(this.heldPath(item));
            restoreAsSymbolicLink = false;
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (restoreAsSymbolicLink) return this.restoreSymbolicLink(item, bytes, true);
      await this.safeRestoreDirectory(item);
      const staged = path.join(this.store.root, '.migration-recycle', itemId + '.restore');
      await this.safeDirectory(path.dirname(staged), true);
      if (item.status !== 'restoring') {
        try { await fs.promises.lstat(item.path); throw new Error('restore_target_exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const partial = staged + '.writing';
        // Only the private, item-specific unfinished write may be replaced.
        try {
          const stat = await fs.promises.lstat(partial);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('recycling_path_invalid');
          const previous = await fs.promises.readFile(partial);
          if (!bytes.subarray(0, previous.length).equals(previous)) throw new Error('recycling_source_changed');
          await fs.promises.unlink(partial);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try {
          await this.verifiedFile(staged, hash(bytes));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const handle = await fs.promises.open(partial, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await fs.promises.rename(partial, staged);
        }
        this.store.setRecyclingStatus(itemId, 'restoring');
      } else {
        const stat = await fs.promises.lstat(staged);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2) throw new Error('recycling_path_invalid');
        bytes = await fs.promises.readFile(staged);
      }
      const localPending = this.store.recyclingRestoreIntents(itemId).some(intent => intent.status === 'planned');
      let publishing = this.store.recyclingRestoreStage(itemId) || localPending ? await this.localRestoreStage(item, bytes) : staged;
      let published: { source: fs.Stats; target: fs.Stats; created: boolean };
      try {
        try { published = await this.linkAnchored(publishing, item.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          publishing = await this.localRestoreStage(item, bytes);
          published = await this.linkAnchored(publishing, item.path);
        }
      }
      catch (error) { throw error; }
      // Matching bytes alone do not prove ownership: an unrelated user file stays untouched.
      if (!published.source.isFile() || published.source.isSymbolicLink() || !published.target.isFile() || published.target.isSymbolicLink()
        || published.source.dev !== published.target.dev || published.source.ino !== published.target.ino) throw new Error('restore_target_exists');
      if (hash(await fs.promises.readFile(item.path)) !== hash(bytes)) throw new Error('recycling_source_changed');
      try {
        await this.verifiedSource(this.heldPath(item), hash(bytes), item);
        await fs.promises.unlink(this.heldPath(item));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.store.setRecyclingStatus(itemId, 'changed', 'restored_with_retained_copy');
          return { restored: true, path: item.path, retainedCopy: this.heldPath(item) };
        }
      }
      // Keep the published inode as the receipt until the durable state is settled.
      this.store.setRecyclingStatus(itemId, 'restored');
      await fs.promises.unlink(staged);
      await this.clearLocalRestoreStage(itemId);
      return { restored: true, path: item.path };
    });
  }
  private async ownedRestoreDirectory(itemId: string): Promise<string | null> {
    const stage = this.store.recyclingRestoreStage(itemId);
    if (!stage) return null;
    let stat: fs.BigIntStats;
    try { stat = await fs.promises.lstat(stage.directory, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.store.clearRecyclingRestoreStage(itemId, stage.directory);
      return null;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== stage.device || String(stat.ino) !== stage.inode || await fs.promises.realpath(stage.directory) !== stage.directory) throw new Error('recycling_path_invalid');
    return stage.directory;
  }
  private async localRestoreStage(item: RecyclingItem, bytes: Buffer, symbolicLink = false): Promise<string> {
    let directory = await this.ownedRestoreDirectory(item.itemId);
    if (!directory) {
      const parent = path.dirname(item.path);
      let pending: { id: string; directory: string } | undefined;
      for (const intent of this.store.recyclingRestoreIntents(item.itemId).filter(value => value.status === 'planned')) {
        try {
          await fs.promises.lstat(intent.directory);
          // A creation intent cannot distinguish our interrupted mkdir from
          // somebody else's directory. Keep the exact conflict and continue.
          this.store.settleRecyclingRestoreIntent(intent.id, 'ownership_unknown');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!pending && path.dirname(intent.directory) === parent) pending = intent;
          else this.store.settleRecyclingRestoreIntent(intent.id, 'cleaned');
        }
      }
      while (!directory) {
        const intent = pending || this.store.reserveRecyclingRestoreIntent(item.itemId, parent);
        pending = undefined;
        let created: fs.BigIntStats | undefined;
        try {
          await fs.promises.mkdir(intent.directory, { mode: 0o700 });
          created = await fs.promises.lstat(intent.directory, { bigint: true });
          if (!created.isDirectory() || created.isSymbolicLink() || await fs.promises.realpath(intent.directory) !== intent.directory) throw new Error('recycling_path_invalid');
          this.store.registerRecyclingRestoreStage(item.itemId, { directory: intent.directory, device: String(created.dev), inode: String(created.ino) });
          directory = intent.directory;
        } catch (error) {
          if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            this.store.settleRecyclingRestoreIntent(intent.id, 'ownership_unknown');
            continue;
          }
          if (created) {
            try {
              const current = await fs.promises.lstat(intent.directory, { bigint: true });
              if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino || await fs.promises.realpath(intent.directory) !== intent.directory) throw new Error('recycling_path_invalid');
              // Only the live creator's unchanged, empty inode can be removed.
              await fs.promises.rmdir(intent.directory);
              if (this.store.recyclingRestoreStage(item.itemId)?.directory === intent.directory) this.store.clearRecyclingRestoreStage(item.itemId, intent.directory);
              else this.store.settleRecyclingRestoreIntent(intent.id, 'cleaned');
            } catch (cleanupError) { Object.assign(error as object, { cleanupError }); }
          }
          throw error;
        }
      }
    }
    const file = path.join(directory, 'content'); const partial = file + '.writing';
    try {
      const stat = await fs.promises.lstat(file);
      const retained = symbolicLink ? Buffer.from(await fs.promises.readlink(file), 'utf8') : await fs.promises.readFile(file);
      if ((symbolicLink ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2) || hash(retained) !== hash(bytes)) throw new Error('recycling_source_changed');
      return file;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (symbolicLink) {
      const target = bytes.toString('utf8');
      if (!Buffer.from(target, 'utf8').equals(bytes) || target.includes('\0')) throw new Error('recycling_snapshot_changed');
      await this.ownedRestoreDirectory(item.itemId);
      await fs.promises.symlink(target, file);
      return file;
    }
    try {
      const stat = await fs.promises.lstat(partial);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !bytes.subarray(0, stat.size).equals(await fs.promises.readFile(partial))) throw new Error('recycling_source_changed');
      await fs.promises.unlink(partial);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.ownedRestoreDirectory(item.itemId);
    const handle = await fs.promises.open(partial, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await this.ownedRestoreDirectory(item.itemId);
    await fs.promises.rename(partial, file);
    return file;
  }
  private async clearLocalRestoreStage(itemId: string, symbolicLink = false): Promise<void> {
    const directory = await this.ownedRestoreDirectory(itemId);
    if (!directory) return;
    for (const name of ['content', 'content.writing']) {
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.lstat(file);
        if (symbolicLink && name === 'content' ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink() || stat.nlink > (name === 'content' ? 2 : 1)) throw new Error('recycling_path_invalid');
        await this.ownedRestoreDirectory(itemId);
        await fs.promises.unlink(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.ownedRestoreDirectory(itemId);
    await fs.promises.rmdir(directory);
    this.store.clearRecyclingRestoreStage(itemId, directory);
  }
}
