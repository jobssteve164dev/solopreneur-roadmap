export type MigrationMaintenanceKind = 'migration_review' | 'migration_apply' | 'recycling_apply';

export function buildMigrationMaintenancePrompt(kind: MigrationMaintenanceKind, planId = '', projectRoot = ''): string {
  const argumentsText = projectRoot ? `每次调用维护工具都必须传入 projectRoot=${JSON.stringify(projectRoot)}，不得读取或处理其他项目。` : '';
  const common = [
    '你正在执行 SoloMap 数据维护任务。只使用 MCP 服务器 solomap_data 提供的维护工具；不要调用 shell、文件系统或其他工具，不要直接读取或修改任何数据库或旧文件。',
    argumentsText,
    '先调用 solomap_migration_status 读取任务摘要；对每个需要处理的 jobId 再调用 solomap_migration_status 读取完整详情。所有迁移与回收写入都由 SoloMap Runtime 串行执行。',
  ];
  const steps = kind === 'migration_apply' ? [
    '调用 solomap_migration_start 发现当前仍存在的旧数据源并幂等加入后台迁移队列。',
    '调用 solomap_migration_status；对 failed、interrupted 或 completed_with_conflicts 的任务，先按 jobId 读取完整详情，再逐个调用 solomap_migration_retry。',
    '每次启动或重试后按 jobId 查询状态；状态为 queued 或 running 时继续等待并查询，直到进入终态，再处理下一项。只要状态读取成功，无可见进度不等于失败，不得提前停止。',
    '调用 solomap_recycling_preview 生成精确回收清单；不要调用 solomap_recycling_apply，回收必须回到插件界面由用户确认。',
    '再次调用 solomap_migration_status，确认迁移结果。'
  ] : kind === 'migration_review' ? [
    '对 failed、interrupted 或 completed_with_conflicts 的任务，先按 jobId 读取完整详情，再逐个调用 solomap_migration_retry。',
    '每次重试后按 jobId 查询状态；状态为 queued 或 running 时继续等待并查询，直到进入终态，再处理下一项。只要状态读取成功，无可见进度不等于失败，不得提前停止。',
    '调用 solomap_recycling_preview 生成精确回收清单；不要调用 solomap_recycling_apply，回收必须回到插件界面由用户确认。',
    '再次调用 solomap_migration_status，确认迁移结果。'
  ] : [
    `本任务只允许执行插件已确认的回收清单 ${planId}。调用 solomap_recycling_apply，planId 必须逐字等于该值。`,
    '完成后再次调用 solomap_migration_status，确认回收结果。'
  ];
  return [...common.filter(Boolean), ...steps,
    '单次工具失败不代表迁移失败。保留原始错误，不要绕过权限或自行处理文件；首次失败后重新调用 solomap_migration_status 核对动作是否已经生效，再从尚未完成的步骤继续。连接中断或响应不完整时按同一方式恢复；只有状态读取连续 3 次无法建立时，才保留三次原始错误并报告持续连接阻塞，且必须说明任务仍可能在后台运行，不得宣称迁移失败。工具明确返回不可恢复的权限或项目范围错误时，报告具体阻塞。'
  ].join('\n');
}
