import type { RuntimeDataOperations } from './runtimeDataOperations';

const namespace = 'runtime';
const ownerScope = 'global';
const key = 'autonomyPaused';

export async function readRuntimePauseState(operation: RuntimeDataOperations, legacyPaused = false): Promise<boolean> {
  const current = await operation({ operation: 'read_host_settings', input: { namespace, ownerScope } }) as { items: Array<{ key: string; revision: number; value?: unknown }> };
  const item = current.items.find(candidate => candidate.key === key);
  if (item) return item.value === true;
  if (!legacyPaused) return false;
  await operation({ operation: 'patch_host_settings', input: {
    namespace, ownerScope, patches: [{ key, expectedRevision: 0, value: true }],
    idempotencyKey: 'runtime-pause:legacy-service-disabled'
  } });
  return true;
}

export async function writeRuntimePauseState(operation: RuntimeDataOperations, paused: boolean): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await operation({ operation: 'read_host_settings', input: { namespace, ownerScope } }) as { items: Array<{ key: string; revision: number; value?: unknown }> };
    const item = current.items.find(candidate => candidate.key === key);
    if (item?.value === paused) return;
    try {
      await operation({ operation: 'patch_host_settings', input: {
        namespace, ownerScope, patches: [{ key, expectedRevision: item?.revision || 0, value: paused }],
        idempotencyKey: `runtime-pause:${paused}:${item?.revision || 0}`
      } });
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'revision_conflict' || attempt === 2) throw error;
    }
  }
}
