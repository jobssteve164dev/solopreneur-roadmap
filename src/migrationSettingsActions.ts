export interface MigrationSettingsDependencies {
  getRoot(): string;
  ready(root: string): Promise<void>;
  call(root: string, operation: string, input: Record<string, unknown>): Promise<any>;
  confirm(files: Array<{ itemId: string; path: string; bytes: number }>): Promise<boolean>;
  trash(file: string, hash: string): Promise<void>;
}

export async function handleMigrationSettingsAction(request: Record<string, unknown>, dependencies: MigrationSettingsDependencies): Promise<Record<string, unknown>> {
  const root = dependencies.getRoot();
  const command = String(request.command || '');
  if (command !== 'dataMigration.get' && request.dataRoot !== root) throw new Error('data_location_changed');
  await dependencies.ready(root);
  const call = (operation: string, input: Record<string, unknown> = {}) => {
    if (dependencies.getRoot() !== root) throw new Error('data_location_changed');
    return dependencies.call(root, operation, input);
  };
  const recycle = async (itemId: string) => {
    const held = await call('hold_recycling_file', { itemId });
    if (!held.recycled) {
      try { await dependencies.trash(held.path, held.hash); }
      catch { await call('retire_recycling_file', { itemId }); }
    }
    await call('finish_recycling_file', { itemId });
  };
  if (command === 'dataMigration.preview') return { plan: await call('prepare_recycling'), overview: await call('migration_overview'), dataRoot: root };
  if (command === 'dataMigration.recycle') {
    const planId = String(request.planId || '');
    const plan = await call('read_recycling_plan', { planId });
    if (!await dependencies.confirm(plan.files)) return { cancelled: true, dataRoot: root };
    await call('confirm_recycling', { planId });
    for (const file of plan.files) {
      await recycle(file.itemId);
    }
  } else if (command === 'dataMigration.retryRecycling') {
    await recycle(String(request.itemId || ''));
  } else if (command === 'dataMigration.restore') {
    await call('restore_recycling_file', { itemId: String(request.itemId || '') });
  } else if (command === 'dataMigration.retry') {
    await call('retry_migration', { jobId: String(request.jobId || '') });
  } else if (command !== 'dataMigration.get') throw new Error('unknown_migration_action');
  return { overview: await call('migration_overview'), dataRoot: root };
}
