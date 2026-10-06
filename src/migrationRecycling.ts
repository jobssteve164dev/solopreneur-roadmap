import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RecyclingItem, UnifiedDataStore } from './db/unifiedDataStore';
import { isRetirableRunArtifact } from './projectDataMigration';

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const conversationKey = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;

/** Only collections whose writers and readers use the database may be retired. */
export class MigrationRecycling {
  private busy = new Set<string>();
  private matches = new Map<string, { hash: string; revision: number; matches: boolean }>();
  private fileChecks = new Map<string, { hash: string; inode: number; size: number; mtime: number; ctime: number }>();
  constructor(private readonly store: UnifiedDataStore) {}

  private sourcePath(identity: string, key: string): string | null {
    if (identity.startsWith('intelligence:')) return path.join(identity.slice('intelligence:'.length), key);
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
  private allowedPath(file: string): boolean {
    const resolved = path.resolve(file); const recycleRoot = path.join(path.resolve(this.store.root), '.migration-recycle');
    if (resolved.startsWith(recycleRoot + path.sep)) return true;
    return this.store.capturedMigrationSources().some(source => this.sourcePath(source.identity, source.key) === resolved);
  }

  private async safeDirectory(directory: string, create = false): Promise<void> {
    if (create) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.promises.realpath(this.store.root);
    const expected = path.join(root, path.basename(directory));
    if ((await fs.promises.lstat(directory)).isSymbolicLink() || await fs.promises.realpath(directory) !== expected) throw new Error('recycling_path_invalid');
  }
  private async verifiedFile(file: string, expectedHash: string): Promise<Buffer> {
    if (!this.allowedPath(file)) throw new Error('recycling_path_invalid');
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('recycling_path_invalid');
    const bytes = await fs.promises.readFile(file);
    const after = await fs.promises.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || hash(bytes) !== expectedHash) throw new Error('recycling_source_changed');
    return bytes;
  }
  private async candidateSize(file: string, expectedHash: string): Promise<number> {
    if (!this.allowedPath(file)) throw new Error('recycling_path_invalid');
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('recycling_path_invalid');
    const previous = this.fileChecks.get(file);
    if (previous?.hash === expectedHash && previous.inode === stat.ino && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs) return stat.size;
    const bytes = await this.verifiedFile(file, expectedHash);
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
  private async candidates(): Promise<Array<Omit<RecyclingItem, 'itemId' | 'planId' | 'status' | 'error'>>> {
    const active = this.store.recyclingItems().filter(item => ['approved', 'moving', 'held', 'restoring'].includes(item.status));
    const files = [];
    for (const source of this.store.capturedMigrationSources()) {
      const file = this.sourcePath(source.identity, source.key);
      if (!file || active.some(item => item.path === file)) continue;
      if (source.identity.startsWith('intelligence:')) {
        if (!conversationKey.test(source.key) || !this.capturedConversationMatches(source)) continue;
      } else if (source.stage !== 'imported' || (source.identity.startsWith('agent-runs:') && !isRetirableRunArtifact(source.key))) continue;
      try {
        const bytes = await this.candidateSize(file, source.hash);
        files.push({ identity: source.identity, key: source.key, hash: source.hash, path: file, bytes });
      } catch { /* Changed, missing, or unsafe sources stay outside the recyclable list. */ }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return files;
  }
  public async overview() {
    const files = await this.candidates();
    const latestJobs = new Map<string, ReturnType<UnifiedDataStore['readMigrationJob']>>();
    for (const job of this.store.migrationJobs()) latestJobs.set(String(job.args.collection || 'memory') + ':' + String(job.args.sourceRoot), job);
    const jobs = [...latestJobs.values()];
    const sources = this.store.capturedMigrationSources();
    const intelligenceIdentity = `intelligence:${path.join(this.store.root, 'intelligence-conversations')}`;
    const migratedFiles = sources.filter(source => source.stage === 'imported' || (source.identity === intelligenceIdentity && conversationKey.test(source.key) && this.capturedConversationMatches(source))).length;
    const recycling: RecyclingItem[] = [];
    for (const item of this.store.recyclingItems()) {
      if (item.status === 'prepared') continue;
      if (item.status === 'restored') {
        try { await fs.promises.lstat(path.join(this.store.root, '.migration-recycle', item.itemId + '.restore')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      }
      recycling.push(item);
    }
    return { jobs, capturedFiles: sources.length, migratedFiles,
      recyclableFiles: files.length, recyclableBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      recycledFiles: recycling.filter(item => item.status === 'trashed').length,
      heldFiles: recycling.filter(item => ['moving', 'held'].includes(item.status)).length,
      recycling: recycling.map(({ identity, key, hash: _hash, planId, ...item }) => item) };
  }
  public async prepare() { return this.store.createRecyclingPlan(await this.candidates()); }
  public readPlan(planId: string) {
    const files = this.store.recyclingItems().filter(item => item.planId === planId);
    if (!files.length) throw new Error('recycling_plan_missing');
    return { planId, files };
  }
  public confirm(planId: string) {
    const files = this.store.recyclingItems().filter(item => item.planId === planId);
    if (!files.length) throw new Error('recycling_plan_missing');
    for (const item of files) if (item.status === 'prepared') this.store.setRecyclingStatus(item.itemId, 'approved');
    return { confirmed: true };
  }
  private item(itemId: string): RecyclingItem {
    const item = this.store.recyclingItems().find(value => value.itemId === itemId);
    if (!item) throw new Error('recycling_item_missing');
    if (this.sourcePath(item.identity, item.key) !== item.path) throw new Error('recycling_path_invalid');
    return item;
  }
  private heldPath(item: RecyclingItem): string { return path.join(this.store.root, '.migration-recycle', item.itemId + '.json'); }
  private async safeRestoreDirectory(item: RecyclingItem): Promise<void> {
    if (this.sourcePath(item.identity, item.key) !== item.path) throw new Error('recycling_path_invalid');
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
  public async hold(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'prepared') throw new Error('recycling_confirmation_required');
      if (!['approved', 'moving', 'held'].includes(item.status)) throw new Error('recycling_state_invalid');
      const target = this.heldPath(item);
      if (['moving', 'held'].includes(item.status)) {
        try {
          await this.verifiedFile(target, item.hash);
          this.store.setRecyclingStatus(itemId, 'held');
          return { path: target, hash: item.hash };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (item.status === 'held') {
          this.store.setRecyclingStatus(itemId, 'trashed');
          return { recycled: true };
        }
      }
      try {
        const bytes = await this.verifiedFile(item.path, item.hash);
        if (item.identity.startsWith('intelligence:') && !this.matchesConversation(item.key, bytes)) throw new Error('recycling_database_mismatch');
        await this.safeDirectory(path.dirname(target), true);
        try { await fs.promises.lstat(target); throw new Error('recycling_target_exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.store.setRecyclingStatus(itemId, 'moving');
        await fs.promises.rename(item.path, target);
        // A concurrent edit during the move must remain recoverable, never be trashed.
        await this.verifiedFile(target, item.hash);
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
    try { await fs.promises.lstat(this.heldPath(item)); throw new Error('recycling_file_not_trashed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.store.setRecyclingStatus(itemId, 'trashed');
    return { recycled: true };
  }
  public async retire(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'trashed') return { recycled: true };
      if (item.status !== 'held') throw new Error('recycling_state_invalid');
      // The immutable committed snapshot is the recovery authority, including when
      // an editor host has no usable operating-system trash implementation.
      if (!(await fs.promises.lstat(this.store.filePath)).isFile()) throw new Error('database_restore_required');
      if (this.store.recyclingSnapshot(itemId).hash !== item.hash) throw new Error('recycling_snapshot_changed');
      try {
        await this.verifiedFile(this.heldPath(item), item.hash);
        await fs.promises.unlink(this.heldPath(item));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.store.setRecyclingStatus(itemId, 'trashed');
      return { recycled: true };
    });
  }
  public async restore(itemId: string) {
    return this.exclusive(itemId, async () => {
      const item = this.item(itemId);
      if (item.status === 'prepared' || item.status === 'approved') throw new Error('recycling_state_invalid');
      const source = this.store.recyclingSnapshot(itemId);
      if (source.hash !== item.hash) throw new Error('recycling_snapshot_changed');
      if (item.status === 'restored') {
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
      try { await fs.promises.link(staged, item.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const [origin, published] = await Promise.all([fs.promises.lstat(staged), fs.promises.lstat(item.path)]);
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
      return { restored: true, path: item.path };
    });
  }
}
