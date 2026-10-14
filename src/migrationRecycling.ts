import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RecyclingItem, UnifiedDataStore } from './db/unifiedDataStore';
import { isRetirableRunArtifact } from './projectDataMigration';

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const conversationKey = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
export interface MigrationProjectScope { root: string; projectId: string; physicalRoot: string }

/** Only collections whose writers and readers use the database may be retired. */
export class MigrationRecycling {
  private busy = new Set<string>();
  private matches = new Map<string, { hash: string; revision: number; matches: boolean }>();
  private fileChecks = new Map<string, { hash: string; inode: number; size: number; mtime: number; ctime: number }>();
  constructor(private readonly store: UnifiedDataStore) {}

  private sourceIdentities(scope: MigrationProjectScope): string[] {
    const roots = [...new Set([path.resolve(scope.root), scope.physicalRoot])];
    return [...roots.flatMap(root => [
      `documentation:${root}`, `project-journal:${root}`, `project-growth:${root}`, `agent-runs:${root}`,
      `project-agent-status:${root}`, `agent-status:${root}`, `native-session-history:${root}`, `historical-journal-output:${root}`
    ]), `step-memory:${scope.projectId}`, `run-digests:${scope.projectId}`];
  }
  private belongsToProject(identity: string, scope?: MigrationProjectScope): boolean {
    return !scope || this.sourceIdentities(scope).includes(identity);
  }

  private sourcePath(identity: string, key: string): string | null {
    if (identity.startsWith('intelligence:')) return path.join(identity.slice('intelligence:'.length), key);
    if (identity.startsWith('documentation:')) return key === '.solopreneur/documentation.json'
      ? path.join(identity.slice('documentation:'.length), key) : null;
    if (identity.startsWith('agent-status:')) return /^\d+\.json$/.test(key)
      ? path.join(identity.slice('agent-status:'.length), '.solopreneur', 'agent-status', key) : null;
    if (identity.startsWith('project-agent-status:')) return key === '.agent_status.json'
      ? path.join(identity.slice('project-agent-status:'.length), key) : null;
    for (const collection of ['step-memory', 'run-digests']) if (identity.startsWith(collection + ':')) {
      const projectId = identity.slice(collection.length + 1);
      const roots = [...new Set(this.store.registeredProjectScopes().filter(project => project.projectId === projectId)
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
  public verifyJobSource(job: { args: Record<string, unknown> }, key: string, scope?: MigrationProjectScope) {
    const collection = String(job.args.collection || '');
    const root = String(job.args.projectRoot || '');
    if (!root || !['project-growth', 'project-journal', 'agent-runs', 'documentation', 'step-memory', 'run-digests'].includes(collection)) throw new Error('migration_source_scope_mismatch');
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
  private allowedPath(file: string, source?: Pick<RecyclingItem, 'identity' | 'key'>): boolean {
    const resolved = path.resolve(file); const recycleRoot = path.join(path.resolve(this.store.root), '.migration-recycle');
    if (resolved.startsWith(recycleRoot + path.sep)) return true;
    if (!source) return false;
    const declared = this.sourcePath(source.identity, source.key);
    if (!declared) return false;
    try { return this.physicalSourcePath(source) === resolved; } catch { return false; }
  }

  private physicalSourcePath(source: Pick<RecyclingItem, 'identity' | 'key'>): string {
    const declared = this.sourcePath(source.identity, source.key);
    if (!declared) throw new Error('recycling_path_invalid');
    const physical = this.physicalPath(declared);
    const projectIdentity = /^(documentation|project-journal|project-growth|agent-runs|agent-status|project-agent-status):(.+)$/.exec(source.identity);
    let projectRoot = projectIdentity?.[2];
    const sharedIdentity = /^(step-memory|run-digests):(.+)$/.exec(source.identity);
    if (sharedIdentity) {
      const roots = [...new Set(this.store.registeredProjectScopes().filter(project => project.projectId === sharedIdentity[2])
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
  private async verifiedFile(file: string, expectedHash: string, source?: Pick<RecyclingItem, 'identity' | 'key'>): Promise<Buffer> {
    if (!this.allowedPath(file, source)) throw new Error('recycling_path_invalid');
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('recycling_path_invalid');
    const bytes = await fs.promises.readFile(file);
    const after = await fs.promises.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || hash(bytes) !== expectedHash) throw new Error('recycling_source_changed');
    return bytes;
  }
  private async candidateSize(file: string, expectedHash: string, source: Pick<RecyclingItem, 'identity' | 'key'>): Promise<number> {
    if (!this.allowedPath(file, source)) throw new Error('recycling_path_invalid');
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('recycling_path_invalid');
    const previous = this.fileChecks.get(file);
    if (previous?.hash === expectedHash && previous.inode === stat.ino && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs) return stat.size;
    const bytes = await this.verifiedFile(file, expectedHash, source);
    const after = await fs.promises.lstat(file);
    if (stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.size !== after.size) throw new Error('recycling_source_changed');
    this.fileChecks.set(file, { hash: expectedHash, inode: after.ino, size: after.size, mtime: after.mtimeMs, ctime: after.ctimeMs });
    return bytes.length;
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
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
    }
    return false;
  }
  private runSourceRetirable(source: Pick<RecyclingItem, 'identity' | 'key'>): boolean {
    if (!isRetirableRunArtifact(source.key) && !['prompt', 'output', 'control', 'session', 'change_evidence', 'report'].includes(this.store.migrationSourceKind(source.identity, source.key))) return false;
    const root = source.identity.slice('agent-runs:'.length);
    if (!source.key.startsWith('learning-tasks/')) {
      const parts = source.key.split(/[\\/]/);
      return !this.legacyOwnerAlive(root, parts[0], parts.length === 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : undefined);
    }
    try {
      const project = this.store.registeredProjectScopes().find(project => {
        try { return fs.realpathSync(project.root) === fs.realpathSync(root); } catch { return false; }
      });
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
    for (const source of this.store.capturedMigrationSources().filter(source => belongs(source.identity))) {
      const file = this.sourcePath(source.identity, source.key);
      if (!file || active.some(item => item.path === file)) continue;
      if (source.identity.startsWith('intelligence:')) {
        if (!conversationKey.test(source.key) || !this.capturedConversationMatches(source)) continue;
      } else if (source.stage !== 'imported' || (source.identity.startsWith('agent-runs:') && !this.runSourceRetirable(source))) continue;
      if (!this.store.migrationSourceState(source.identity, source.key)?.reconciled) continue;
      try {
        const physical = this.physicalSourcePath(source);
        if (occupied.has(physical)) continue;
        const bytes = await this.candidateSize(physical, source.hash, source);
        if (this.physicalSourcePath(source) !== physical) throw new Error('recycling_path_invalid');
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
  public async recycleBatch(itemIds: string[]): Promise<{ failures: string[] }> {
    const ids = [...new Set(itemIds)];
    return this.exclusiveMany(ids, async () => {
      const failures = new Set<string>();
      const moving: RecyclingItem[] = [];
      const held = new Map<string, RecyclingItem>();
      const changed: Array<{ itemId: string; status: 'changed'; error: string }> = [];
      for (const itemId of ids) {
        let item: RecyclingItem;
        try {
          item = this.item(itemId);
          if (['trashed', 'restored'].includes(item.status)) continue;
          if (item.status === 'changed') { failures.add(itemId); continue; }
          if (item.status === 'prepared') throw new Error('recycling_confirmation_required');
          if (!['approved', 'moving', 'held'].includes(item.status)) throw new Error('recycling_state_invalid');
          this.assertReconciled(item);
          const target = this.heldPath(item);
          if (['moving', 'held'].includes(item.status)) {
            try {
              await this.verifiedFile(target, item.hash);
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
          const bytes = await this.verifiedFile(item.path, item.hash, item);
          if (item.identity.startsWith('intelligence:') && !this.matchesConversation(item.key, bytes)) throw new Error('recycling_database_mismatch');
          await this.safeDirectory(path.dirname(target), true);
          try { await fs.promises.lstat(target); throw new Error('recycling_target_exists'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          this.assertReconciled(item);
          const sourceStat = await fs.promises.lstat(item.path);
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || this.physicalSourcePath(item) !== item.path) throw new Error('recycling_path_invalid');
          await fs.promises.rename(item.path, target);
          const targetStat = await fs.promises.lstat(target);
          if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1 || targetStat.dev !== sourceStat.dev || targetStat.ino !== sourceStat.ino) throw new Error('recycling_source_changed');
          await this.verifiedFile(target, item.hash);
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
            await this.verifiedFile(this.heldPath(item), item.hash);
            this.assertReconciled(item);
            await fs.promises.unlink(this.heldPath(item));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          retired.push(item);
        } catch {
          failures.add(item.itemId);
        }
      }
      this.store.setRecyclingStatuses(retired.map(item => ({ itemId: item.itemId, status: 'trashed' as const })));
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
          await this.verifiedFile(target, item.hash);
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
        const bytes = await this.verifiedFile(item.path, item.hash, item);
        if (item.identity.startsWith('intelligence:') && !this.matchesConversation(item.key, bytes)) throw new Error('recycling_database_mismatch');
        await this.safeDirectory(path.dirname(target), true);
        try { await fs.promises.lstat(target); throw new Error('recycling_target_exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.assertReconciled(item);
        this.store.setRecyclingStatus(itemId, 'moving');
        await fs.promises.rename(item.path, target);
        // A concurrent edit during the move must remain recoverable, never be trashed.
        await this.verifiedFile(target, item.hash);
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
    if (item.status === 'trashed') return { recycled: true };
    if (item.status !== 'held' && item.status !== 'moving') throw new Error('recycling_state_invalid');
    this.assertReconciled(item);
    try { await fs.promises.lstat(this.heldPath(item)); throw new Error('recycling_file_not_trashed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.assertReconciled(item);
    this.store.setRecyclingStatus(itemId, 'trashed');
    return { recycled: true };
  }
  public async retire(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'trashed') return { recycled: true };
      if (item.status !== 'held') throw new Error('recycling_state_invalid');
      this.assertReconciled(item);
      // The immutable committed snapshot is the recovery authority, including when
      // an editor host has no usable operating-system trash implementation.
      if (!(await fs.promises.lstat(this.store.filePath)).isFile()) throw new Error('database_restore_required');
      if (this.store.recyclingSnapshot(itemId).hash !== item.hash) throw new Error('recycling_snapshot_changed');
      try {
        await this.verifiedFile(this.heldPath(item), item.hash);
        this.assertReconciled(item);
        await fs.promises.unlink(this.heldPath(item));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.store.setRecyclingStatus(itemId, 'trashed');
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
          if (stage) await this.clearLocalRestoreStage(itemId);
          this.store.bindRecyclingRestorePath(itemId, destination, previous.restorePath ?? null);
        } else this.store.bindRecyclingRestorePath(itemId, destination);
      }
      const item = this.item(itemId);
      if (item.status === 'prepared' || item.status === 'approved') throw new Error('recycling_state_invalid');
      const source = this.store.recyclingSnapshot(itemId);
      if (source.hash !== item.hash) throw new Error('recycling_snapshot_changed');
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
      // Preserve a late edit found in the held copy, if the move raced with an editor.
      if (item.status === 'changed') {
        try {
          await this.safeDirectory(path.dirname(this.heldPath(item)));
          const stat = await fs.promises.lstat(this.heldPath(item));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recycling_path_invalid');
          bytes = await fs.promises.readFile(this.heldPath(item));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
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
      try {
        try { await fs.promises.link(publishing, item.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          publishing = await this.localRestoreStage(item, bytes);
          await fs.promises.link(publishing, item.path);
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const [origin, published] = await Promise.all([fs.promises.lstat(publishing), fs.promises.lstat(item.path)]);
        // Matching bytes alone do not prove ownership: an unrelated user file stays untouched.
        if (!published.isFile() || published.isSymbolicLink() || origin.dev !== published.dev || origin.ino !== published.ino) throw new Error('restore_target_exists');
      }
      if (hash(await fs.promises.readFile(item.path)) !== hash(bytes)) throw new Error('recycling_source_changed');
      try {
        await this.verifiedFile(this.heldPath(item), hash(bytes));
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
  private async localRestoreStage(item: RecyclingItem, bytes: Buffer): Promise<string> {
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2 || hash(await fs.promises.readFile(file)) !== hash(bytes)) throw new Error('recycling_source_changed');
      return file;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
  private async clearLocalRestoreStage(itemId: string): Promise<void> {
    const directory = await this.ownedRestoreDirectory(itemId);
    if (!directory) return;
    for (const name of ['content', 'content.writing']) {
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > (name === 'content' ? 2 : 1)) throw new Error('recycling_path_invalid');
        await this.ownedRestoreDirectory(itemId);
        await fs.promises.unlink(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.ownedRestoreDirectory(itemId);
    await fs.promises.rmdir(directory);
    this.store.clearRecyclingRestoreStage(itemId, directory);
  }
}
