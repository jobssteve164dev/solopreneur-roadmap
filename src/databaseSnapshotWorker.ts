import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { PinnedDatabaseSnapshot, syncSnapshotDirectoryChain, type DatabaseSnapshotBinding } from './db/pinnedDatabaseSnapshot.js';
import type { DatabaseSnapshotWorkerConfiguration } from './databaseSnapshotWorkerClient.js';

const port = parentPort;
if (!port) throw new Error('database_snapshot_worker_port_missing');
const configuration = workerData as DatabaseSnapshotWorkerConfiguration;
const root = path.resolve(configuration.root), candidateDir = path.resolve(configuration.candidateDir);
if (path.dirname(candidateDir) !== path.join(root, 'database-generations') || !/^[a-f0-9-]{36}$/.test(path.basename(candidateDir))
  || !configuration.databaseId || !configuration.writerIncarnation || !['solomap.db', 'baseline.db'].includes(configuration.baselineName || 'solomap.db')) throw new Error('database_snapshot_generation_invalid');
const assertGeneration = (): void => {
  const stat = fs.lstatSync(candidateDir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== configuration.generationDevice || String(stat.ino) !== configuration.generationInode) throw new Error('database_snapshot_generation_changed');
};
assertGeneration();
const changesetDir = path.join(candidateDir, 'changesets');
fs.mkdirSync(changesetDir, { mode: 0o700 });
syncSnapshotDirectoryChain(changesetDir);
const directoryDescriptor = fs.openSync(changesetDir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
const directoryIdentity = fs.fstatSync(directoryDescriptor, { bigint: true });
const assertChangesetDirectory = (): void => {
  const stat = fs.lstatSync(changesetDir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directoryIdentity.dev || stat.ino !== directoryIdentity.ino) throw new Error('database_snapshot_changeset_directory_changed');
};
const stableChangesetDir = process.platform === 'linux' ? `/proc/self/fd/${directoryDescriptor}` : process.platform === 'darwin' ? `/dev/fd/${directoryDescriptor}` : changesetDir;
const snapshot = new PinnedDatabaseSnapshot(path.join(root, 'solomap.db'), configuration.databaseId, configuration.writerIncarnation);
let closed = false;
const close = (): void => { if (closed) return; closed = true; snapshot.cancel(); fs.closeSync(directoryDescriptor); };
port.on('close', close);
process.on('exit', close);
port.on('message', async (message: { id: number; operation: string; token?: string; binding?: DatabaseSnapshotBinding; sequence?: number; changeset?: Uint8Array; searchObjectIds?: string[]; liveSequence?: number }) => {
  try {
    assertGeneration();
    let result: unknown;
    if (message.operation === 'pin') result = snapshot.pin(String(message.token || ''));
    else if (message.operation === 'copy') {
      const binding = message.binding!, destination = path.join(candidateDir, configuration.baselineName || 'solomap.db');
      await snapshot.copyTo(destination, binding, { device: configuration.generationDevice, inode: configuration.generationInode });
      result = { destination, databaseId: binding.databaseId, committedSequence: binding.committedSequence, bytes: fs.statSync(destination).size };
    } else if (message.operation === 'persist_changeset') {
      if (!Number.isSafeInteger(message.sequence) || Number(message.sequence) < 1 || Number(message.sequence) >= 1e12 || !(message.changeset instanceof Uint8Array)
        || !Number.isSafeInteger(message.liveSequence) || Number(message.liveSequence) < 0 || !Array.isArray(message.searchObjectIds) || message.searchObjectIds.some(id => typeof id !== 'string')) throw new Error('database_snapshot_changeset_invalid');
      const name = `${String(message.sequence).padStart(12, '0')}.changeset`;
      assertChangesetDirectory();
      const file = await fs.promises.open(path.join(stableChangesetDir, name), 'wx', 0o600);
      let identity: fs.BigIntStats;
      try { await file.writeFile(message.changeset); await file.sync(); identity = await file.stat({ bigint: true }); } finally { await file.close(); }
      fs.fsyncSync(directoryDescriptor);
      assertChangesetDirectory();
      const current = fs.lstatSync(path.join(changesetDir, name), { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== BigInt(message.changeset.byteLength)) throw new Error('database_snapshot_changeset_file_changed');
      result = { file: path.join(changesetDir, name), searchObjectIds: message.searchObjectIds, liveSequence: message.liveSequence };
    } else throw new Error('database_snapshot_operation_invalid');
    assertGeneration();
    port.postMessage({ id: message.id, result });
  } catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
port.postMessage({ ready: true });
