import * as path from 'path';
import { SolopreneurSettings } from './pluginContracts';
import { normalizeGlobalDataPath, SolopreneurProject } from './projectPortfolio';
import { ensureHealthyAutonomousRuntime } from './autonomousRuntimeHost';
import { projectShadowDecisionForToday, readCurrentShadowDecision, readShadowDecisionFeedbackOutcome, refreshShadowRuntimeState } from './autonomousRuntime';
import { sendRuntimeControlCommand } from './autonomousRuntimeControl';

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
  decisionId?: string;
  baselineProjectPath?: string;
  recommendedProjectPath?: string;
  sourceRevision?: string;
  readOnly?: boolean;
  feedbackOutcome?: string;
}


export function readTodayReview(globalDataPath: string, projects: SolopreneurProject[]): DailyReviewArtifact | null {
  const globalRoot = normalizeGlobalDataPath(globalDataPath, projects);
  const shadowDecision = readCurrentShadowDecision(globalRoot, projects);
  return shadowDecision ? projectShadowDecisionForToday(
    shadowDecision,
    readShadowDecisionFeedbackOutcome(globalRoot, shadowDecision.decisionId)
  ) as DailyReviewArtifact : null;
}


export async function startDailyReviewAgent(settings: SolopreneurSettings, projects: SolopreneurProject[], _extensionUri?: unknown): Promise<DailyReviewArtifact> {
  const globalRoot = normalizeGlobalDataPath(settings.globalDataPath, projects);
  await ensureHealthyAutonomousRuntime({ extensionPath: path.resolve(__dirname, '..'), globalDataPath: globalRoot });
  await refreshShadowRuntimeState(globalRoot);
  let review = readTodayReview(globalRoot, projects);
  if (!review) {
    await sendRuntimeControlCommand(globalRoot, 'refresh', { timeoutMs: 10_000 });
    const deadline = Date.now() + 30_000;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      await refreshShadowRuntimeState(globalRoot);
      review = readTodayReview(globalRoot, projects);
    } while (!review && Date.now() < deadline);
  }
  if (review) return review;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    date: now.slice(0, 10),
    generatedAt: now,
    finishedAt: now,
    rhythm: 'runtime',
    reviewMode: 'shadow_decision',
    source: 'runtime_shadow',
    status: 'failed',
    summary: '今日安排暂时无法生成，请稍后重试。',
    todos: [],
    needsConfirmation: [],
    inputSnapshot: { projectCount: projects.length, learningCandidateCount: 0, blockedDependencyCount: 0, reviewMode: 'shadow_decision' },
    readOnly: true,
    error: 'Today arrangement is not available.'
  };
}
