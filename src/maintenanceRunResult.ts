import * as fs from 'fs';
import * as path from 'path';
import { captureInstallationFiles } from './capabilityRegistry';
import { maintenanceRunKinds, RunState } from './runLifecycleTypes';

export function maintenanceResultSignature(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function captureMaintenanceRunResult(dataRoot: string, state: RunState,
  operation: (name: string, input: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
  if (!maintenanceRunKinds.includes(String(state.status.runKind)) || !state.status.maintenanceResultPath) return false;
  const identity = { projectId: state.projectId, executionLogId: Number(state.status.rootExecutionLogId || state.status.executionLogId) };
  const purpose = `maintenance_result_${state.generation}`;
  if (await operation('read_run_document', { ...identity, purpose })) return true;
  if (state.status.maintenanceResultGeneration !== state.generation) return false;
  const file = String(state.status.maintenanceResultPath), temporaryRoot = path.join(dataRoot, 'tmp');
  const relative = path.relative(temporaryRoot, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('maintenance_result_path_invalid');
  const signature = maintenanceResultSignature(file);
  if (!signature || signature === state.status.maintenanceResultBaseline) return false;
  const [content] = captureInstallationFiles(temporaryRoot, { result: file });
  await operation('write_run_document', { ...identity, generation: state.generation, turnId: state.turnId, purpose,
    bytes: content.bytes, mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${state.runId}:${state.generation}:maintenance-result` });
  return true;
}
