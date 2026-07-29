export function buildSystemMaintenancePromptGuard(maintenanceRoot: string): string[] {
  return [
    '这是 SoloMap 系统维护任务，不是项目开发任务；只完成下面明确要求的维护动作。',
    `维护工作目录：${maintenanceRoot}`,
    '上下文边界：',
    '- 不要查找、读取或分析用户当前项目的源码、路线图、文档、Git 状态或项目级指令。',
    '- 不要读取 SoloMap 全局目录中与本次维护无关的 memory、context、projects、portfolio 或历史运行记录。',
    '- 只读取本提示明确列出的来源、安装器、目标目录和结果文件；仅在完成维护动作确有必要时检查系统级包管理器或 Agent 配置。',
    '- 不要规划或修改任何项目功能。完成维护、验证结果、写入指定结果文件后立即退出。'
  ];
}
