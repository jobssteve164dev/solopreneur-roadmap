import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { reclaimDatabaseGeneration } from './databaseGeneration.js';

const port = parentPort;
if (!port) throw new Error('database_generation_cleanup_port_missing');
const input = workerData as { root: string; generationId: string; device: string; inode: string };
try {
  if (!/^[a-f0-9-]{36}$/.test(input.generationId)) throw new Error('database_generation_path_invalid');
  const directory = path.join(path.resolve(input.root), 'database-generations', input.generationId);
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== input.device || String(stat.ino) !== input.inode) throw new Error('database_generation_reclaim_changed');
  port.postMessage({ result: reclaimDatabaseGeneration(input.root, input.generationId, { device: input.device, inode: input.inode }) });
} catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
finally { port.close(); }
