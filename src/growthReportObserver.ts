import { sendRuntimeDataRequest } from './autonomousRuntimeControl.js';

/** A visible report panel follows committed database generations, without reading report bodies. */
export function observeGrowthReports(globalDataPath: string, projectPath: string, changed: () => void, visible: () => boolean = () => true): { dispose(): void; ready: Promise<void> } {
  let disposed = false;
  let revision: number | undefined;
  let connectionFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (initial = false): Promise<void> => {
    try {
      if (disposed || (!initial && !visible())) return;
      const next = await sendRuntimeDataRequest<{ revision: number }>(globalDataPath, { operation: 'read_report_source_revision', input: { root: projectPath } });
      if (disposed) return;
      const previous = revision; revision = next.revision;
      if ((previous === undefined && connectionFailed) || (previous !== undefined && previous !== revision)) changed();
      connectionFailed = false;
    } catch {
      connectionFailed = true;
      // Reconnect through the current control endpoint after an owner restart.
    } finally {
      if (!disposed) { timer = setTimeout(() => void refresh(), 1000); timer.unref?.(); }
    }
  };
  const ready = refresh(true);
  return { ready, dispose: () => { disposed = true; if (timer) clearTimeout(timer); } };
}
