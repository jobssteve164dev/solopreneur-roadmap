import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface RunIndexHealth {
  digestCount: number;
  indexedCount: number;
  missingDigestCount: number;
  backfilledCount: number;
  ok: boolean;
  error: string;
}

export async function getRunIndexHealth(projectPath: string, extensionPath: string, globalDataPath = ''): Promise<RunIndexHealth> {
  try {
    return await sendRuntimeDataRequest<RunIndexHealth>(normalizeGlobalDataPathForExtension(globalDataPath, projectPath), { operation: 'read_run_index_health', input: { root: projectPath } });
  } catch (error) {
    return { digestCount: 0, indexedCount: 0, missingDigestCount: 0, backfilledCount: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function backfillRunIndexFromDigests(projectPath: string, extensionPath: string, globalDataPath = ''): Promise<RunIndexHealth> {
  try {
    return await sendRuntimeDataRequest<RunIndexHealth>(normalizeGlobalDataPathForExtension(globalDataPath, projectPath), { operation: 'backfill_run_indexes', input: { root: projectPath } });
  } catch (error) {
    return { digestCount: 0, indexedCount: 0, missingDigestCount: 0, backfilledCount: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
