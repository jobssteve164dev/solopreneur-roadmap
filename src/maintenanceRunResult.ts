import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { captureInstallationFiles } from './capabilityRegistry';
import { maintenanceResultRunKinds, RunState } from './runLifecycleTypes';

export function maintenanceResultSignature(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function captureMaintenanceRunResult(dataRoot: string, state: RunState,
  operation: (name: string, input: Record<string, unknown>) => Promise<unknown>, platform = process.platform): Promise<boolean> {
  if (!maintenanceResultRunKinds.includes(String(state.status.runKind)) || !state.status.maintenanceResultPath) return false;
  const identity = { projectId: state.projectId, executionLogId: Number(state.status.rootExecutionLogId || state.status.executionLogId) };
  const purpose = `maintenance_result_${state.generation}`;
  const existing = await operation('read_run_document', { ...identity, purpose });
  if (existing) {
    if (secureDescriptorRoot(platform)) removeCapturedMaintenanceResult(dataRoot, String(state.status.maintenanceResultPath), existing, undefined, platform);
    return true;
  }
  if (state.status.maintenanceResultGeneration !== state.generation) return false;
  const file = String(state.status.maintenanceResultPath), temporaryRoot = path.join(dataRoot, 'tmp');
  const relative = path.relative(temporaryRoot, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('maintenance_result_path_invalid');
  const signature = maintenanceResultSignature(file);
  if (!signature || signature === state.status.maintenanceResultBaseline) return false;
  const before = fs.lstatSync(file);
  const [content] = captureInstallationFiles(temporaryRoot, { result: file });
  const after = fs.lstatSync(file);
  if (!sameFile(before, after)) throw new Error('maintenance_result_source_changed');
  await operation('write_run_document', { ...identity, generation: state.generation, turnId: state.turnId, purpose,
    bytes: content.bytes, mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${state.runId}:${state.generation}:maintenance-result` });
  const stored = await operation('read_run_document', { ...identity, purpose });
  if (!stored) throw new Error('maintenance_result_readback_missing');
  if (secureDescriptorRoot(platform)) removeCapturedMaintenanceResult(dataRoot, file, stored, after, platform);
  return true;
}

type AnchoredDirectory = { descriptor: number; path: string; stat: fs.Stats };

function sameFile(left: Pick<fs.Stats, 'dev' | 'ino'>, right: Pick<fs.Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureDescriptorRoot(platform: NodeJS.Platform): string {
  return platform === 'linux' ? '/proc/self/fd' : platform === 'darwin' ? '/dev/fd' : '';
}

function openAnchoredDirectory(directory: string, expected: string, platform: NodeJS.Platform): AnchoredDirectory {
  const descriptorRoot = secureDescriptorRoot(platform);
  if (!descriptorRoot) throw new Error('maintenance_result_secure_path_unsupported');
  const before = fs.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('maintenance_result_path_invalid');
  const directoryFlag = Number((fs.constants as unknown as Record<string, number>).O_DIRECTORY || 0);
  const noFollowFlag = Number((fs.constants as unknown as Record<string, number>).O_NOFOLLOW || 0);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
  try {
    const opened = fs.fstatSync(descriptor), anchored = path.join(descriptorRoot, String(descriptor));
    if (!opened.isDirectory() || !sameFile(before, opened) || fs.realpathSync(anchored) !== expected) throw new Error('maintenance_result_path_invalid');
    return { descriptor, path: anchored, stat: opened };
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function readStableFile(file: string): { bytes: Buffer; stat: fs.Stats } {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('maintenance_result_path_invalid');
  const noFollowFlag = Number((fs.constants as unknown as Record<string, number>).O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(before, opened)) throw new Error('maintenance_result_source_changed');
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    if (!sameFile(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('maintenance_result_source_changed');
    return { bytes, stat: after };
  } finally { fs.closeSync(descriptor); }
}

function matchesStored(bytes: Buffer, stored: unknown): boolean {
  const document = stored as { bytes?: unknown; hash?: unknown; totalBytes?: unknown };
  return document.bytes === bytes.toString('base64')
    && document.hash === crypto.createHash('sha256').update(bytes).digest('hex')
    && document.totalBytes === bytes.length;
}

function removeCapturedMaintenanceResult(dataRoot: string, file: string, stored: unknown, expected: Pick<fs.Stats, 'dev' | 'ino'> | undefined, platform: NodeJS.Platform): void {
  const temporaryRoot = path.join(dataRoot, 'tmp'), relative = path.relative(temporaryRoot, file);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== 'result.json' || parts[0] === '..' || path.isAbsolute(relative)) return;
  const physicalRoot = path.resolve(temporaryRoot), root = openAnchoredDirectory(physicalRoot, physicalRoot, platform);
  let operation: AnchoredDirectory | undefined;
  try {
    const operationPath = path.join(root.path, parts[0]), physicalOperation = path.join(physicalRoot, parts[0]);
    try { operation = openAnchoredDirectory(operationPath, physicalOperation, platform); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const source = path.join(operation.path, 'result.json'), hold = path.join(operation.path, '.solomap-result-captured');
    let sourceExists = true, holdExists = true;
    try { fs.lstatSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') sourceExists = false; else throw error; }
    try { fs.lstatSync(hold); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') holdExists = false; else throw error; }
    if (sourceExists && holdExists) throw new Error('maintenance_result_cleanup_conflict');
    if (sourceExists && !expected) return;
    if (!sourceExists && !holdExists) {
      const operationStat = operation.stat;
      fs.closeSync(operation.descriptor); operation = undefined;
      const anchoredOperation = path.join(root.path, parts[0]), current = fs.lstatSync(anchoredOperation);
      if (sameFile(operationStat, current) && fs.readdirSync(anchoredOperation).length === 0) fs.rmdirSync(anchoredOperation);
      return;
    }
    const selected = sourceExists ? source : hold, observed = readStableFile(selected);
    if (expected && sourceExists && !sameFile(expected, observed.stat)) throw new Error('maintenance_result_source_changed');
    if (!matchesStored(observed.bytes, stored)) throw new Error('maintenance_result_readback_mismatch');
    if (sourceExists) {
      fs.renameSync(source, hold);
      const moved = fs.lstatSync(hold);
      if (!sameFile(observed.stat, moved)) {
        try { fs.lstatSync(source); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fs.renameSync(hold, source); }
        throw new Error('maintenance_result_source_changed');
      }
    }
    const sealed = readStableFile(hold);
    if (!sameFile(observed.stat, sealed.stat) || !matchesStored(sealed.bytes, stored)) throw new Error('maintenance_result_source_changed');
    fs.unlinkSync(hold);
    const operationStat = operation.stat;
    fs.closeSync(operation.descriptor); operation = undefined;
    const anchoredOperation = path.join(root.path, parts[0]), current = fs.lstatSync(anchoredOperation);
    if (sameFile(operationStat, current) && fs.readdirSync(anchoredOperation).length === 0) fs.rmdirSync(anchoredOperation);
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) return;
    throw error;
  } finally {
    if (operation) fs.closeSync(operation.descriptor);
    fs.closeSync(root.descriptor);
  }
}
