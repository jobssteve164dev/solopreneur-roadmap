import * as path from 'path';
import { normalizeGlobalDataPath, ProjectPortfolioSummary, slugifyProjectId } from './projectPortfolio';

export interface GlobalEngineeringSnapshot {
  dataPath: string;
  portfolio: Array<{
    id: string;
    name: string;
    path: string;
    type: string;
    status: string;
    priority: string;
    blocker: string;
    nextAction: string;
    updatedAt: string;
  }>;
  dependencies: Array<{
    fromProject: string;
    toProject: string;
    capability: string;
    status: string;
    priorityImpact: string;
    reason: string;
    updatedAt: string;
  }>;
  learningCandidateCount: number | null;
}

export function createGlobalEngineeringSnapshotPlaceholder(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  const normalizedPath = normalizeGlobalDataPath(dataPath);
  return {
    dataPath: normalizedPath,
    portfolio: portfolio.map((project) => ({
      id: slugifyProjectId(project.name || path.basename(project.path)),
      name: project.name,
      path: project.path,
      type: project.projectType || 'core_product',
      status: project.overallStatus || 'Pending',
      priority: project.globalPriority || 'P2',
      blocker: project.blocker || '',
      nextAction: project.globalNextAction || project.recommendedNodeTitle || '',
      updatedAt: project.recentActivityAt || ''
    })),
    dependencies: portfolio.flatMap(project => (project.blockedActions || []).map(action => ({
        fromProject: slugifyProjectId(project.name || path.basename(project.path)),
        toProject: '',
        capability: `${action.title}：${action.reason}`,
        status: 'blocked',
        priorityImpact: 'raise_to_P0',
        reason: `${action.title}：${action.reason}`,
        updatedAt: project.recentActivityAt || ''
      }))),
    learningCandidateCount: portfolio.every(project => Number.isInteger(project.learningCandidateCount))
      ? portfolio.reduce((sum, project) => sum + Number(project.learningCandidateCount), 0) + Number(portfolio[0]?.globalLearningCandidateCount || 0)
      : null
  };
}

export function ensureGlobalEngineeringStore(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  return createGlobalEngineeringSnapshotPlaceholder(dataPath, portfolio);
}
