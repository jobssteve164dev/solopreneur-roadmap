export interface MigrationSettingsDependencies {
  getRoot(): string;
  getProjectRoot?(): string | undefined;
  ready(root: string): Promise<void>;
  call(root: string, operation: string, input: Record<string, unknown>): Promise<any>;
  confirm(files: Array<{ itemId: string; path: string; bytes: number }>): Promise<boolean>;
  chooseRestorePath?(): Promise<string | undefined>;
  launchAgent(root: string, kind: 'migration_review' | 'migration_apply' | 'recycling_apply', targetId?: string, projectRoot?: string): Promise<void>;
}

export async function handleMigrationSettingsAction(request: Record<string, unknown>, dependencies: MigrationSettingsDependencies): Promise<Record<string, unknown>> {
  const root = dependencies.getRoot();
  const projectRoot = dependencies.getProjectRoot?.();
  if (request.projectRoot !== undefined && String(request.projectRoot || '') !== (projectRoot || '')) throw new Error('project_location_changed');
  const response = (value: Record<string, unknown>) => ({ ...value, projectRoot: projectRoot || '' });
  const scoped = (input: Record<string, unknown> = {}) => projectRoot ? { ...input, projectRoot } : input;
  const command = String(request.command || '');
  if (command !== 'dataMigration.get' && request.dataRoot !== root) throw new Error('data_location_changed');
  await dependencies.ready(root);
  const assertCurrentRoot = (): void => {
    if (dependencies.getRoot() !== root) throw new Error('data_location_changed');
    if (dependencies.getProjectRoot?.() !== projectRoot) throw new Error('project_location_changed');
  };
  assertCurrentRoot();
  const call = (operation: string, input: Record<string, unknown> = {}) => {
    assertCurrentRoot();
    return dependencies.call(root, operation, scoped(input));
  };
  const launchAgent = async (kind: 'migration_review' | 'migration_apply' | 'recycling_apply', targetId?: string): Promise<void> => {
    assertCurrentRoot();
    await dependencies.launchAgent(root, kind, targetId, projectRoot);
    assertCurrentRoot();
  };
  if (command === 'dataMigration.agent') {
    await launchAgent('migration_review');
    return response({ overview: await call('migration_overview'), dataRoot: root, agentStarted: true });
  }
  if (command === 'dataMigration.delegate') {
    await launchAgent('migration_apply');
    return response({ overview: await call('migration_overview'), dataRoot: root, agentStarted: true });
  }
  if (command === 'dataMigration.preview') return response({ plan: await call('prepare_recycling'), overview: await call('migration_overview'), dataRoot: root });
  if (command === 'dataMigration.recycle') {
    const planId = String(request.planId || '');
    const plan = await call('read_recycling_plan', { planId });
    if (!await dependencies.confirm(plan.files)) return response({ cancelled: true, dataRoot: root });
    await call('confirm_recycling', { planId, files: plan.files });
    await launchAgent('recycling_apply', planId);
    return response({ overview: await call('migration_overview'), dataRoot: root, agentStarted: true });
  } else if (command === 'dataMigration.retryRecycling') {
    const planId = String(request.planId || '');
    const plan = await call('read_recycling_plan', { planId });
    if (plan.requiresConfirmation) {
      if (!await dependencies.confirm(plan.files)) return response({ cancelled: true, dataRoot: root });
      await call('confirm_recycling', { planId, files: plan.files });
    }
    await launchAgent('recycling_apply', planId);
    return response({ overview: await call('migration_overview'), dataRoot: root, agentStarted: true });
  } else if (command === 'dataMigration.restore') {
    const itemId = String(request.itemId || '');
    try { await call('restore_recycling_file', { itemId }); }
    catch (error) {
      if (!dependencies.chooseRestorePath || !(error instanceof Error) || !['recycling_path_identity_unavailable', 'recycling_path_invalid', 'restore_target_exists'].includes(error.message)) throw error;
      const destination = await dependencies.chooseRestorePath();
      if (!destination) return response({ cancelled: true, dataRoot: root });
      await call('restore_recycling_file', { itemId, destination });
    }
  } else if (command === 'dataMigration.retry') {
    await call('retry_migration', { jobId: String(request.jobId || '') });
  } else if (command !== 'dataMigration.get') throw new Error('unknown_migration_action');
  return response({ overview: await call('migration_overview'), dataRoot: root });
}
