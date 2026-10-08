export interface MigrationSettingsDependencies {
  getRoot(): string;
  ready(root: string): Promise<void>;
  call(root: string, operation: string, input: Record<string, unknown>): Promise<any>;
  confirm(files: Array<{ itemId: string; path: string; bytes: number }>): Promise<boolean>;
  launchAgent(kind: 'migration_review' | 'migration_apply' | 'recycling_apply', targetId?: string): Promise<void>;
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
  if (command === 'dataMigration.agent') {
    await dependencies.launchAgent('migration_review');
    return { overview: await call('migration_overview'), dataRoot: root, agentStarted: true };
  }
  if (command === 'dataMigration.delegate') {
    await dependencies.launchAgent('migration_apply');
    return { overview: await call('migration_overview'), dataRoot: root, agentStarted: true };
  }
  if (command === 'dataMigration.preview') return { plan: await call('prepare_recycling'), overview: await call('migration_overview'), dataRoot: root };
  if (command === 'dataMigration.recycle') {
    const planId = String(request.planId || '');
    const plan = await call('read_recycling_plan', { planId });
    if (!await dependencies.confirm(plan.files)) return { cancelled: true, dataRoot: root };
    await call('confirm_recycling', { planId });
    await dependencies.launchAgent('recycling_apply', planId);
    return { overview: await call('migration_overview'), dataRoot: root, agentStarted: true };
  } else if (command === 'dataMigration.retryRecycling') {
    await dependencies.launchAgent('recycling_apply', String(request.planId || ''));
    return { overview: await call('migration_overview'), dataRoot: root, agentStarted: true };
  } else if (command === 'dataMigration.restore') {
    await call('restore_recycling_file', { itemId: String(request.itemId || '') });
  } else if (command === 'dataMigration.retry') {
    await call('retry_migration', { jobId: String(request.jobId || '') });
  } else if (command !== 'dataMigration.get') throw new Error('unknown_migration_action');
  return { overview: await call('migration_overview'), dataRoot: root };
}
