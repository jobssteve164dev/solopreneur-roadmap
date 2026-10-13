export type MigrationMaintenanceKind = 'migration_review' | 'migration_apply' | 'recycling_apply';

export function buildMigrationMaintenancePrompt(kind: MigrationMaintenanceKind, planId = '', projectRoot = ''): string {
  const argumentsText = projectRoot ? `每次调用维护工具都必须传入 projectRoot=${JSON.stringify(projectRoot)}，不得读取或处理其他项目。` : '';
  const common = [
    '你正在执行 SoloMap 数据维护任务。只使用 MCP 服务器 solomap_data 提供的维护工具；不要调用 shell、文件系统或其他工具，不要直接读取或修改任何数据库或旧文件。',
    argumentsText,
    '先调用 solomap_migration_status，所有迁移与回收写入都由 SoloMap Runtime 串行执行。',
  ];
  const steps = kind === 'migration_apply' ? [
    '调用 solomap_migration_start 发现当前仍存在的旧数据源并幂等加入后台迁移队列。',
    '调用 solomap_migration_status；对 failed、interrupted 或 completed_with_conflicts 的任务，逐个调用 solomap_migration_retry。',
    '调用 solomap_recycling_preview 生成精确回收清单；不要调用 solomap_recycling_apply，回收必须回到插件界面由用户确认。',
    '再次调用 solomap_migration_status，确认迁移结果。'
  ] : kind === 'migration_review' ? [
    '对 failed、interrupted 或 completed_with_conflicts 的任务，逐个调用 solomap_migration_retry。',
    '调用 solomap_recycling_preview 生成精确回收清单；不要调用 solomap_recycling_apply，回收必须回到插件界面由用户确认。',
    '再次调用 solomap_migration_status，确认迁移结果。'
  ] : [
    `本任务只允许执行插件已确认的回收清单 ${planId}。调用 solomap_recycling_apply，planId 必须逐字等于该值。`,
    '完成后再次调用 solomap_migration_status，确认回收结果。'
  ];
  return [...common.filter(Boolean), ...steps,
    '工具失败时不要绕过权限或自行处理文件；保留原始错误并停止。'
  ].join('\n');
}
