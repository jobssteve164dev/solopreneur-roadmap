import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DiskDatabase } from './diskDatabase.js';

export interface DatabaseSnapshotBinding {
  token: string;
  snapshotNonce: string;
  databaseId: string;
  writerIncarnation: string;
  committedSequence: number;
  migrationVersion: number;
  schemaCookie: number;
  sourceDevice: string;
  sourceInode: string;
}
export interface DatabaseSnapshotOwner { isCurrent(binding: DatabaseSnapshotBinding): boolean }
export interface DatabaseSnapshotDirectory { device: string; inode: string }

export function syncSnapshotDirectoryChain(directory: string, expectedDevice?: bigint): void {
  const start = fs.realpathSync(directory), device = expectedDevice ?? fs.statSync(start, { bigint: true }).dev;
  for (let current = start;;) {
    const descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    let sameDevice: boolean;
    try {
      sameDevice = fs.fstatSync(descriptor, { bigint: true }).dev === device;
      if (sameDevice) fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    const container = path.dirname(current);
    if (!sameDevice || container === current) break;
    current = container;
  }
}

/** A dedicated connection owns one actual SQLite read snapshot until copying ends. */
export class PinnedDatabaseSnapshot {
  private database?: DiskDatabase;
  private binding?: Readonly<DatabaseSnapshotBinding>;
  private copying = false;
  constructor(private readonly source: string, private readonly databaseId: string, private readonly writerIncarnation: string) {}
  pin(token: string): Readonly<DatabaseSnapshotBinding> {
    if (this.copying) throw new Error('database_snapshot_busy');
    this.cancel();
    if (!/^[a-f0-9-]{36}$/.test(token) || !this.databaseId || !this.writerIncarnation) throw new Error('database_snapshot_binding_invalid');
    const before = fs.lstatSync(this.source, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('database_snapshot_source_invalid');
    const database = new DiskDatabase(this.source, { readOnly: true });
    try {
      database.run('BEGIN');
      const actualId = database.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values[0]?.[0];
      if (actualId !== this.databaseId) throw new Error('database_snapshot_identity_mismatch');
      const committedSequence = Number(database.exec('SELECT COALESCE(MAX(sequence),0) FROM events')[0].values[0][0]);
      const migrationVersion = Number(database.exec('SELECT COALESCE(MAX(version),0) FROM schema_migrations')[0].values[0][0]);
      const schemaCookie = Number(database.exec('PRAGMA schema_version')[0].values[0][0]);
      const after = fs.lstatSync(this.source, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('database_snapshot_source_changed');
      this.database = database;
      this.binding = Object.freeze({ token, snapshotNonce: randomUUID(), databaseId: this.databaseId, writerIncarnation: this.writerIncarnation, committedSequence, migrationVersion, schemaCookie,
        sourceDevice: String(before.dev), sourceInode: String(before.ino) });
      return this.binding;
    } catch (error) { database.close(); throw error; }
  }
  private matches(binding: DatabaseSnapshotBinding): boolean {
    return Boolean(binding && this.binding && Object.keys(this.binding).every(key => this.binding![key as keyof DatabaseSnapshotBinding] === binding[key as keyof DatabaseSnapshotBinding]));
  }
  isCurrent(binding: DatabaseSnapshotBinding): boolean { return !this.copying && this.matches(binding); }
  private assertSource(binding: DatabaseSnapshotBinding): void {
    const source = fs.lstatSync(this.source, { bigint: true });
    if (!source.isFile() || source.isSymbolicLink() || String(source.dev) !== binding.sourceDevice || String(source.ino) !== binding.sourceInode) throw new Error('database_snapshot_source_changed');
  }
  async copyTo(destination: string, binding: DatabaseSnapshotBinding, expectedDirectory?: DatabaseSnapshotDirectory): Promise<void> {
    if (!this.database || !this.matches(binding)) throw new Error('database_snapshot_binding_invalid');
    if (this.copying) throw new Error('database_snapshot_busy');
    this.assertSource(binding);
    if (fs.existsSync(destination)) throw new Error('database_snapshot_destination_exists');
    const database = this.database, expected = this.binding!, parent = path.dirname(path.resolve(destination));
    let parentDescriptor: number | undefined, stageDescriptor: number | undefined, fileDescriptor: number | undefined;
    let stageDirectory: string | undefined, stagedFile: string | undefined, stableDestination: string | undefined;
    let ownedFile: fs.BigIntStats | undefined, ownedStage: fs.BigIntStats | undefined, parentIdentity: fs.BigIntStats | undefined;
    let published = false, complete = false;
    const sameInode = (file: string, identity: fs.BigIntStats): boolean => {
      try { const stat = fs.lstatSync(file, { bigint: true }); return stat.dev === identity.dev && stat.ino === identity.ino && !stat.isSymbolicLink(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    const assertParent = (): void => { if (!parentIdentity || !sameInode(parent, parentIdentity)) throw new Error('database_snapshot_destination_changed'); };
    this.copying = true;
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      parentIdentity = fs.fstatSync(parentDescriptor, { bigint: true });
      if (expectedDirectory && (String(parentIdentity.dev) !== expectedDirectory.device || String(parentIdentity.ino) !== expectedDirectory.inode)) throw new Error('database_snapshot_destination_changed');
      assertParent();
      // Revisit the full chain on retries, including paths an earlier failed
      // copy or the generation creator made but had not durably synchronized.
      syncSnapshotDirectoryChain(parent, parentIdentity.dev);
      assertParent();
      const descriptorPath = (descriptor: number, fallback: string) => process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : process.platform === 'darwin' ? `/dev/fd/${descriptor}` : fallback;
      const stableParent = descriptorPath(parentDescriptor, parent);
      stableDestination = path.join(stableParent, path.basename(destination));
      stageDirectory = path.join(stableParent, `.solomap-snapshot-${randomUUID()}`);
      fs.mkdirSync(stageDirectory, { mode: 0o700 });
      stageDescriptor = fs.openSync(stageDirectory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      ownedStage = fs.fstatSync(stageDescriptor, { bigint: true });
      stagedFile = path.join(descriptorPath(stageDescriptor, stageDirectory), 'solomap.db');
      fileDescriptor = fs.openSync(stagedFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      ownedFile = fs.fstatSync(fileDescriptor, { bigint: true });
      await database.backup(stagedFile);
      if (this.binding !== expected) throw new Error('database_snapshot_revoked');
      this.assertSource(expected);
      if (!sameInode(stagedFile, ownedFile)) throw new Error('database_snapshot_stage_changed');
      const candidate = new DiskDatabase(stagedFile, { readOnly: true, immutable: true });
      try {
        if (candidate.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values[0]?.[0] !== expected.databaseId
          || Number(candidate.exec('SELECT COALESCE(MAX(sequence),0) FROM events')[0].values[0][0]) !== expected.committedSequence
          || Number(candidate.exec('SELECT COALESCE(MAX(version),0) FROM schema_migrations')[0].values[0][0]) !== expected.migrationVersion) throw new Error('database_snapshot_copy_invalid');
      } finally { candidate.close(); }
      fs.fsyncSync(fileDescriptor);
      assertParent();
      try { fs.linkSync(stagedFile, stableDestination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('database_snapshot_destination_exists'); throw error; }
      published = true;
      assertParent();
      if (!sameInode(stableDestination, ownedFile)) throw new Error('database_snapshot_destination_changed');
      fs.fsyncSync(parentDescriptor);
      complete = true;
    } finally {
      this.copying = false;
      this.cancel();
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
      try {
        if (published && !complete && stableDestination && ownedFile && sameInode(stableDestination, ownedFile)) fs.unlinkSync(stableDestination);
        if (stagedFile && ownedFile) {
          if (!sameInode(stagedFile, ownedFile)) throw new Error('database_snapshot_stage_changed');
          fs.unlinkSync(stagedFile);
        }
        if (stageDirectory && ownedStage) {
          if (!sameInode(stageDirectory, ownedStage)) throw new Error('database_snapshot_stage_changed');
          fs.rmdirSync(stageDirectory);
        }
        if (parentDescriptor !== undefined) fs.fsyncSync(parentDescriptor);
      } finally {
        if (stageDescriptor !== undefined) fs.closeSync(stageDescriptor);
        if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
      }
    }
  }
  cancel(): void {
    this.binding = undefined;
    if (this.copying) return;
    this.database?.close();
    this.database = undefined;
  }
}
