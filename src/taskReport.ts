import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export function writeLearningJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

export function readLearningJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function learningTasksRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'agent-runs', 'learning-tasks');
}

export function registerLearningTask(workspaceRoot: string, input: {
  executionLogId: number; runDir: string; userMessage: string; startedAt: string;
  taskId?: string; parentExecutionLogId?: number;
}): string {
  const root = learningTasksRoot(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  const tasks = fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => readLearningJson(path.join(root, name)));
  const parent = tasks.find(task => task && (task.taskId === input.taskId || (input.parentExecutionLogId && task.executions?.some((run: any) => run.id === input.parentExecutionLogId))));
  const taskId = parent?.taskId || `task-${crypto.randomUUID()}`;
  const executions = [...(parent?.executions || [])].filter(run => run.id !== input.executionLogId);
  executions.push({ id: input.executionLogId, runDir: input.runDir });
  writeLearningJson(path.join(root, `${taskId}.json`), {
    schemaVersion: 1, taskId, projectPath: workspaceRoot,
    startedAt: parent?.startedAt || input.startedAt,
    userMessage: parent?.userMessage || input.userMessage, executions
  });
  return taskId;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export function validateTaskReport(value: any): any {
  if (!value || value.schemaVersion !== 1) throw new Error('report schemaVersion must be 1');
  const result: any = { schemaVersion: 1, summary: text(value.summary, 'summary') };
  for (const field of ['outputs', 'artifacts']) if (Array.isArray(value[field])) result[field] = value[field];
  for (const field of ['unmetRequirements', 'decisions', 'corrections', 'verification', 'commits', 'experienceUsage', 'lessons']) {
    if (!Array.isArray(value[field])) throw new Error(`${field} must be an array`);
    result[field] = value[field];
  }
  for (const commit of result.commits) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(commit.repository) || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('commit requires owner/repo and full SHA');
    if (!Array.isArray(commit.files) || commit.files.some((file: any) => typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) throw new Error('commit files must be project relative paths');
  }
  for (const usage of result.experienceUsage) {
    text(usage.experienceId, 'experienceId'); text(usage.action, 'action'); text(usage.result, 'result');
    if (!Array.isArray(usage.evidence)) throw new Error('experienceUsage evidence must be an array');
  }
  return result;
}

export function recordTaskReport(status: any, args: Record<string, string>, sequence: number): Record<string, string> {
  const finish = (result: Record<string, string>) => {
    try {
      const runDir = path.dirname(status.outputFilePath || status.completionDecisionFilePath);
      writeLearningJson(path.join(runDir, `task-report-status-${sequence}.json`), {
        schemaVersion: 1, taskId: status.learningTaskId || '', projectPath: status.workspaceRoot,
        executionLogId: status.executionLogId, turnId: `${sequence}:complete`, createdAt: new Date().toISOString(),
        availability: result.taskReportStatus
      });
    } catch { /* A receipt failure cannot block the existing checkpoint. */ }
    return result;
  };
  if (!args['report-file']) return finish({ taskReportStatus: 'missing', taskReportPath: '', taskReportError: '' });
  let report: any;
  try {
    const file = path.resolve(status.workspaceRoot, args['report-file']);
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('report exceeds 1 MiB');
    report = validateTaskReport(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error: any) {
    return finish({ taskReportStatus: 'invalid', taskReportPath: '', taskReportError: String(error.message) });
  }
  try {
    const runDir = path.dirname(status.outputFilePath || status.completionDecisionFilePath);
    const taskReportPath = path.join(runDir, `task-report-${sequence}.json`);
    writeLearningJson(taskReportPath, {
      schemaVersion: 1, taskId: status.learningTaskId || '', projectPath: status.workspaceRoot,
      executionLogId: status.executionLogId, turnId: `${sequence}:complete`,
      createdAt: new Date().toISOString(), outcome: args.outcome || 'partial', report
    });
    return finish({ taskReportStatus: 'recorded', taskReportPath, taskReportError: '' });
  } catch (error: any) {
    return finish({ taskReportStatus: 'save_failed', taskReportPath: '', taskReportError: String(error.message) });
  }
}

export function buildTaskReportInstructions(taskId: string, reportFile: string, interactive: boolean): string {
  return [
    'SoloMap 任务汇报与提交关联：',
    `- 当前任务标识：${taskId}；沿本任务续聊保持，不得用 __solo__ 或节点名替换。`,
    '- 如果本轮产生 Git 提交，标题遵守项目风格，正文说明原因、实际改动、验证结果及未验证范围；不要把用户原话、秘密或本地绝对路径写入公开提交。',
    `- 每个属于本任务的提交增加独立 trailer：SoloMap-Task: ${taskId}。共享提交须在报告 files 中明确本任务范围。`,
    `- 在 ${reportFile} 写入严格 JSON，schemaVersion=1，summary 为本轮结果，其余字段为数组：unmetRequirements、decisions、corrections、verification、commits、experienceUsage、lessons。没有内容用 []，不制造经验或提交。`,
    '- decisions 说明做法与理由；corrections 说明原要求、偏差、修正及来源消息；verification 说明实际检查、结果、证据位置、产物版本与未验证范围。',
    '- commits 每项为 {"repository":"owner/repo","sha":"完整40位提交SHA","files":["本任务相对文件路径"]}。无提交时留空并在 summary 说明。',
    '- experienceUsage 每项为 {"experienceId":"已采用经验标识","action":"实际改变的动作","result":"观察结果","evidence":["证据引用"]}；召回不等于采用。lessons 说明条件、动作、结果、判断和反例，只是待复盘材料。',
    interactive
      ? `- 沿原有 complete 命令结算，并附加 --report-file ${JSON.stringify(reportFile)}；报告问题不阻断原任务。不要为写报告额外调用一次 complete。`
      : '- 本轮结束时保存报告，插件在原有收尾路径读取；不需要改变原任务完成协议。',
    '- 报告只是执行者声明；不要因保存报告直接修改候选状态或全局指令。学习提炼由用户手动“复盘经验”完成。'
  ].join('\n');
}
