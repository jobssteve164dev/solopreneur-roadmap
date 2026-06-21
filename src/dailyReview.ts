import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildAgentCommandForPromptFile, commandExists, getAgentCliCandidates, resolveAgentCli, shellQuote } from './agentCli';
import { readLearningSummary } from './learningLedger';
import { SolopreneurSettings } from './pluginContracts';
import { buildProjectPortfolioSummaries, commonParent, getDailyWorkRhythm, getLocalDateKey, normalizeGlobalDataPath, ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';
import { GlobalEngineeringSnapshot, ensureGlobalEngineeringStore } from './globalEngineeringStore';

export interface DailyReviewTodo {
  title: string;
  reason: string;
  projectPath?: string;
  nodeId?: string;
  action?: string;
}

export interface DailyReviewArtifact {
  schemaVersion: number;
  date: string;
  generatedAt: string;
  finishedAt?: string;
  rhythm: string;
  reviewMode?: string;
  source: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  summary: string;
  todos: DailyReviewTodo[];
  needsConfirmation: DailyReviewTodo[];
  inputSnapshot: {
    projectCount: number;
    learningCandidateCount: number;
    ledgerEventCount?: number;
    ledgerCandidateCount?: number;
    confirmedLearningCount?: number;
    blockedDependencyCount: number;
    reviewMode?: string;
  };
  resultPath?: string;
  promptPath?: string;
  outputLog?: string;
  error?: string;
}


export function getDailyReviewMode(
  rhythm: string,
  portfolio: ProjectPortfolioSummary[],
  globalStore: Pick<GlobalEngineeringSnapshot, 'dependencies' | 'learningCandidateCount'>
): string {
  const hasUrgentSignal = portfolio.some((project) => (
    Number(project.delivery?.failedWorkflowRuns || 0) > 0
    || Number(project.failedNodes || 0) > 0
    || Number((project.issues?.byPriority || {}).P0 || 0) > 0
    || project.globalPriority === 'P0'
    || Boolean(project.blocker)
  ));
  if (hasUrgentSignal || (globalStore.dependencies || []).length > 0) {
    return 'exception_review';
  }
  if (rhythm === 'monday') {
    return 'weekly_planning';
  }
  if (rhythm === 'friday') {
    return 'learning_closeout';
  }
  if (rhythm === 'monthEnd') {
    return 'monthly_review';
  }
  if (Number(globalStore.learningCandidateCount || 0) > 0 || portfolio.some((project) => Number(project.reusableSignals || 0) > 0)) {
    return 'daily_learning';
  }
  if (portfolio.some((project) => Number(project.documentationPendingReview || 0) > 0)) {
    return 'daily_learning';
  }
  return 'daily_check';
}

function describeDailyReviewMode(mode: string): { title: string; instruction: string; checks: string[] } {
  if (mode === 'exception_review') {
    return {
      title: '异常优先审视',
      instruction: '先判断是否存在必须立刻处理的发布失败、失败环节、P0 反馈或跨项目阻断；只有没有紧急项时才给常规推进建议。',
      checks: [
        '把 P0、失败检查、失败环节和阻断排在所有规划动作之前。',
        '如果某个项目的下一步被阻断，给出打开项目、继续环节或调整路线图的最短动作。',
        '不要输出学习归档建议，除非它直接解除当前阻断。'
      ]
    };
  }
  if (mode === 'weekly_planning') {
    return {
      title: '周一重点校准',
      instruction: '把全局工程执行指南的周一规划内化成一次本周重点判断：检查 P0，确认本周 P1，给出 P2 备选，并扫描外部变化。',
      checks: [
        '先确认有没有项目应该升为 P0。',
        '明确本周最该推进的 1 个 P1 项目，并用用户能理解的理由说明。',
        '如果没有紧急项，优先给可开始、可闭环的新推进动作。'
      ]
    };
  }
  if (mode === 'learning_closeout') {
    return {
      title: '周五收尾与学习审视',
      instruction: '把全局工程执行指南的周五审核内化成一次收尾判断：检查学习候选、复用机会、下周起点和潜在 blocker。',
      checks: [
        '优先找本周已经完成、接近完成或可沉淀的项目。',
        '只把未来大概率复用的经验放入 needsConfirmation，避免把内部归档工作转嫁给用户。',
        '如果下周 P1 已显露 blocker，给出提前处理动作。'
      ]
    };
  }
  if (mode === 'monthly_review') {
    return {
      title: '月末优先级与复用回顾',
      instruction: '把全局工程执行指南的月末审视内化成一次月度判断：回顾执行效率、优先级准确度、知识沉淀质量和跨项目协调。',
      checks: [
        '优先识别优先级可能要调整的项目。',
        '检查可复用经验是否真的支撑了推进，而不是只被记录。',
        '如果跨项目依赖影响下月推进，给出调整路线图或打开项目的动作。'
      ]
    };
  }
  if (mode === 'daily_learning') {
    return {
      title: '日常学习消化',
      instruction: '在日常行动建议之外，轻量检查可复用线索和学习候选是否已经到了需要用户确认的程度。',
      checks: [
        '先给今天最该推进的动作。',
        '只有当经验明显跨项目可复用时，才放入 needsConfirmation。',
        '不要让学习整理压过当前最重要的推进动作。'
      ]
    };
  }
  return {
    title: '每日快速自查',
    instruction: '把全局工程执行指南的每日自查内化成一次快速判断：今天做什么，是否切换项目，是否有 blocker，是否能用已有经验解决。',
    checks: [
      '先判断今天应该继续当前项目还是切换到更高优先级项目。',
      '检查进行中、可开始和失败状态。',
      '如果没有异常，给出最容易形成闭环的一步。'
    ]
  };
}

function getDailyReviewDir(globalRoot: string): string {
  return path.join(globalRoot, 'daily');
}

function getDailyReviewPath(globalRoot: string, dateKey = getLocalDateKey()): string {
  return path.join(getDailyReviewDir(globalRoot), `${dateKey}.json`);
}

function normalizeDailyReviewTodo(value: any): DailyReviewTodo {
  return {
    title: String(value?.title || '').trim(),
    reason: String(value?.reason || '').trim(),
    projectPath: String(value?.projectPath || '').trim(),
    nodeId: String(value?.nodeId || '').trim(),
    action: String(value?.action || '').trim()
  };
}

function normalizeDailyReviewArtifact(value: any, resultPath = ''): DailyReviewArtifact | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const todos = Array.isArray(value.todos) ? value.todos.map(normalizeDailyReviewTodo).filter((item: DailyReviewTodo) => item.title) : [];
  const needsConfirmation = Array.isArray(value.needsConfirmation)
    ? value.needsConfirmation.map(normalizeDailyReviewTodo).filter((item: DailyReviewTodo) => item.title)
    : [];
  const status = ['running', 'completed', 'failed'].includes(String(value.status || '')) ? String(value.status) as DailyReviewArtifact['status'] : 'completed';
  return {
    schemaVersion: Number(value.schemaVersion || 1),
    date: String(value.date || getLocalDateKey()),
    generatedAt: String(value.generatedAt || ''),
    finishedAt: String(value.finishedAt || ''),
    rhythm: String(value.rhythm || 'daily'),
    reviewMode: String(value.reviewMode || ''),
    source: String(value.source || 'agent_review'),
    status,
    summary: String(value.summary || ''),
    todos,
    needsConfirmation,
    inputSnapshot: {
      projectCount: Number(value.inputSnapshot?.projectCount || 0),
      learningCandidateCount: Number(value.inputSnapshot?.learningCandidateCount || 0),
      ledgerEventCount: Number(value.inputSnapshot?.ledgerEventCount || 0),
      ledgerCandidateCount: Number(value.inputSnapshot?.ledgerCandidateCount || 0),
      confirmedLearningCount: Number(value.inputSnapshot?.confirmedLearningCount || 0),
      blockedDependencyCount: Number(value.inputSnapshot?.blockedDependencyCount || 0),
      reviewMode: String(value.inputSnapshot?.reviewMode || value.reviewMode || '')
    },
    resultPath: String(value.resultPath || resultPath),
    promptPath: String(value.promptPath || ''),
    outputLog: String(value.outputLog || ''),
    error: String(value.error || '')
  };
}

export function readTodayReview(globalDataPath: string, projects: SolopreneurProject[]): DailyReviewArtifact | null {
  const globalRoot = normalizeGlobalDataPath(globalDataPath, projects);
  const resultPath = getDailyReviewPath(globalRoot);
  if (!fs.existsSync(resultPath)) {
    return null;
  }
  try {
    return normalizeDailyReviewArtifact(JSON.parse(fs.readFileSync(resultPath, 'utf8')), resultPath);
  } catch {
    return {
      schemaVersion: 1,
      date: getLocalDateKey(),
      generatedAt: '',
      rhythm: getDailyWorkRhythm(),
      source: 'agent_review',
      status: 'failed',
      summary: '',
      todos: [],
      needsConfirmation: [],
      inputSnapshot: { projectCount: projects.length, learningCandidateCount: 0, blockedDependencyCount: 0, reviewMode: getDailyWorkRhythm() },
      resultPath,
      error: 'Today review cache is not valid JSON.'
    };
  }
}


export function buildDailyReviewPrompt(options: {
  resultPath: string;
  dateKey: string;
  rhythm: string;
  reviewMode: string;
  portfolio: ProjectPortfolioSummary[];
  globalStore: GlobalEngineeringSnapshot;
  learningSummary?: ReturnType<typeof readLearningSummary>;
}): string {
  const mode = describeDailyReviewMode(options.reviewMode);
  const learningSummary = options.learningSummary;
  const snapshot = {
    date: options.dateKey,
    rhythm: options.rhythm,
    reviewMode: options.reviewMode,
    learningCandidateCount: options.globalStore.learningCandidateCount || 0,
    ledgerEventCount: learningSummary?.eventCount || 0,
    ledgerCandidateCount: learningSummary?.candidateCount || 0,
    confirmedLearningCount: (learningSummary?.approvedCount || 0) + (learningSummary?.promotedCount || 0),
    projectLearningSignals: (learningSummary?.projectSignals || []).slice(0, 8),
    blockedDependencyCount: (options.globalStore.dependencies || []).length,
    projects: options.portfolio.map((project) => ({
      name: project.name,
      path: project.path,
      type: project.projectType,
      priority: project.globalPriority,
      status: project.overallStatus,
      progressPercent: project.progressPercent,
      blocker: project.blocker,
      nextAction: project.globalNextAction || project.recommendedNodeTitle,
      recommendedNodeId: project.recommendedNodeId,
      recommendedNodeTitle: project.recommendedNodeTitle,
      recommendedStatus: project.recommendedStatus,
      failedNodes: project.failedNodes,
      runningNodes: project.runningNodes,
      inProgressNodes: project.inProgressNodes,
      pendingNodes: project.pendingNodes,
      reusableSignals: project.reusableSignals,
      stageGap: project.stageGap,
      issuePressure: project.issuePressure,
      deliverySignal: project.deliverySignal,
      securitySignal: project.securitySignal,
      securityRisks: project.security?.openCriticalHigh || 0,
      foundationMissing: project.foundation?.missingCount || 0,
      documentationDocumentCount: project.documentationDocumentCount || 0,
      documentationPendingReview: project.documentationPendingReview || 0
    }))
  };
  return [
    '# SoloMap 今日审视',
    '',
    '你要按 SoloMap 全局工程执行指南做一次轻量审视，只输出一个简单、可执行的今日 Todo 清单。',
    `本次按钮背后的审视模式是：${mode.title}。`,
    '',
    '## 必须遵守',
    '- 用户目标：少判断，直接知道今天该先做什么。',
    '- 不要改路线图、不要改优先级、不要创建新任务系统、不要写除结果 JSON 以外的文件。',
    '- 不要把 `.solomap-global`、CSV 字段、评分公式、内部目录结构暴露给用户。',
    '- Todo 必须回到已有项目、路线图环节、Issue 或路线图调整入口；如果拿不准，用项目级 action。',
    '- 最多输出 5 条 todos，最多 3 条 needsConfirmation。',
    '- 文案用用户行动语言，避免工程自描述。',
    '- needsConfirmation 只放确实需要用户确认的学习、优先级或阻断判断；不要把后台归档动作包装成用户任务。',
    '- 学习账本只作为行动证据：不能改变今天动作、验证或优先级的经验，不要输出给用户。',
    '- 如果项目有文档待确认，只在周五、月末、日常学习或异常相关时放入 needsConfirmation；普通推进日不要让文档整理压过主行动。',
    '- action 只能使用 open_project、continue_step、adjust_roadmap、confirm_learning、ignore_suggestion、open_issue。',
    '',
    '## 本次情景化审视逻辑',
    mode.instruction,
    ...mode.checks.map((item) => `- ${item}`),
    '',
    '## 全局工程执行指南第一部分已内化为这些判断',
    '- 每日：今天先做什么；是否继续当前项目；是否切换到更高优先级；blocker 是否能用已有经验解决。',
    '- 周一：先检查 P0；确认本周 P1；保留 P2 备选；扫描外部变化和跨项目模式。',
    '- 周五：检查学习候选；判断经验是否值得复用；预览下周 P1；提前识别 blocker。',
    '- 月末：回顾执行效率、优先级准确度、知识沉淀质量和跨项目协调。',
    '- 异常：只要出现失败检查、失败环节、P0 反馈或依赖阻断，先处理异常，再考虑周期节奏。',
    '',
    '## 输出优先级',
    '1. 异常处理：发布检查、失败环节、P0 Issue、跨项目阻断。',
    '2. 当前推进：本周 P1、Running/In Progress、可开始 Pending。',
    '3. 收尾复利：完成验证、学习候选、可复用经验、路线图调整。',
    '4. 文档卫生：只处理 documentationPendingReview 指出的正式文档风险，不新增文档后台或独立任务系统。',
    '',
    '## 当前本地事实快照',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
    '',
    '## 写入结果',
    `请把结果写入这个 JSON 文件：${options.resultPath}`,
    '',
    '结果必须是合法 JSON，结构如下：',
    '```json',
    JSON.stringify({
      schemaVersion: 1,
      date: options.dateKey,
      generatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rhythm: options.rhythm,
      reviewMode: options.reviewMode,
      source: 'agent_review',
      status: 'completed',
      summary: '一句话说明今天的安排判断。',
      todos: [
        {
          title: '行动标题',
          reason: '为什么今天做它',
          projectPath: '/absolute/project/path',
          nodeId: 'optional-roadmap-node-id',
          action: 'open_project'
        }
      ],
      needsConfirmation: [
        {
          title: '需要用户确认的选择',
          reason: '为什么需要确认',
          projectPath: '/absolute/project/path',
          action: 'confirm_priority'
        }
      ],
      inputSnapshot: {
        projectCount: snapshot.projects.length,
        learningCandidateCount: snapshot.learningCandidateCount,
        ledgerEventCount: snapshot.ledgerEventCount,
        ledgerCandidateCount: snapshot.ledgerCandidateCount,
        confirmedLearningCount: snapshot.confirmedLearningCount,
        blockedDependencyCount: snapshot.blockedDependencyCount,
        reviewMode: options.reviewMode
      }
    }, null, 2),
    '```',
    '',
    '完成后不要再解释，只确保文件已经写好。'
  ].join('\n');
}

export function startDailyReviewAgent(settings: SolopreneurSettings, projects: SolopreneurProject[], extensionUri?: vscode.Uri): DailyReviewArtifact {
  const portfolio = buildProjectPortfolioSummaries(projects, { includeReusableSignals: true, globalDataPath: settings.globalDataPath });
  const globalStore = ensureGlobalEngineeringStore(settings.globalDataPath, portfolio);
  const learningSummary = readLearningSummary(projects[0]?.path || process.cwd(), settings.globalDataPath);
  const dateKey = getLocalDateKey();
  const rhythm = getDailyWorkRhythm();
  const reviewMode = getDailyReviewMode(rhythm, portfolio, globalStore);
  const dailyDir = getDailyReviewDir(globalStore.dataPath);
  const runDir = path.join(dailyDir, 'runs', `${dateKey}-${Date.now()}`);
  const resultPath = getDailyReviewPath(globalStore.dataPath, dateKey);
  const promptPath = path.join(runDir, 'prompt.txt');
  const outputLog = path.join(runDir, 'output.log');
  const runScriptPath = path.join(runDir, 'run.sh');
  fs.mkdirSync(runDir, { recursive: true });

  const artifact: DailyReviewArtifact = {
    schemaVersion: 1,
    date: dateKey,
    generatedAt: new Date().toISOString(),
    rhythm,
    reviewMode,
    source: 'agent_review',
    status: 'running',
    summary: '',
    todos: [],
    needsConfirmation: [],
    inputSnapshot: {
      projectCount: projects.length,
      learningCandidateCount: globalStore.learningCandidateCount || 0,
      ledgerEventCount: learningSummary.eventCount || 0,
      ledgerCandidateCount: learningSummary.candidateCount || 0,
      confirmedLearningCount: (learningSummary.approvedCount || 0) + (learningSummary.promotedCount || 0),
      blockedDependencyCount: (globalStore.dependencies || []).length,
      reviewMode
    },
    resultPath,
    promptPath,
    outputLog
  };
  fs.writeFileSync(resultPath, JSON.stringify(artifact, null, 2), 'utf8');

  const prompt = buildDailyReviewPrompt({ resultPath, dateKey, rhythm, reviewMode, portfolio, globalStore, learningSummary });
  fs.writeFileSync(promptPath, prompt, 'utf8');

  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    artifact.status = 'failed';
    artifact.error = `Agent CLI not found. Tried: ${getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ')}.`;
    artifact.finishedAt = new Date().toISOString();
    fs.writeFileSync(resultPath, JSON.stringify(artifact, null, 2), 'utf8');
    return artifact;
  }

  const workspaceRoot = commonParent([
    path.dirname(globalStore.dataPath),
    ...projects.map((project) => project.path)
  ]);
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptPath, workspaceRoot, settings.taskPermissionMode);
  const finalizer = [
    'const fs = require("fs");',
    `const resultPath = ${JSON.stringify(resultPath)};`,
    `const outputLog = ${JSON.stringify(outputLog)};`,
    'const code = Number(process.env.SOLOMAP_AGENT_STATUS || 0);',
    'let data = {};',
    'try { data = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch {}',
    'if (data.status !== "completed" && data.status !== "failed") {',
    '  data = Object.assign({}, data, {',
    '    schemaVersion: 1,',
    `    date: ${JSON.stringify(dateKey)},`,
    `    rhythm: ${JSON.stringify(rhythm)},`,
    `    reviewMode: ${JSON.stringify(reviewMode)},`,
    '    source: "agent_review",',
    '    status: "failed",',
    '    summary: "",',
    '    todos: Array.isArray(data.todos) ? data.todos : [],',
    '    needsConfirmation: Array.isArray(data.needsConfirmation) ? data.needsConfirmation : [],',
    '    finishedAt: new Date().toISOString(),',
    '    outputLog,',
    '    error: code === 0 ? "Agent finished but did not write the review JSON." : "Agent review command failed. Open the run log for details."',
    '  });',
    '  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), "utf8");',
    '}'
  ].join('\n');
  const script = [
    '#!/usr/bin/env bash',
    'set +e',
    `cd ${shellQuote(workspaceRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputLog)}`,
    'status=${PIPESTATUS[0]}',
    `SOLOMAP_AGENT_STATUS=$status node -e ${shellQuote(finalizer)}`,
    'exit $status'
  ].join('\n');
  fs.writeFileSync(runScriptPath, script, 'utf8');

  const terminalOpts: vscode.TerminalOptions = {
    name: `Agent Review · ${dateKey}`,
    cwd: workspaceRoot,
  };
  if (extensionUri) {
    terminalOpts.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'logo.svg');
  }
  const terminal = vscode.window.createTerminal(terminalOpts);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  return artifact;
}
