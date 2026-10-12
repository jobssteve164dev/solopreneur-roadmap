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
  learningCandidateCount: number;
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
    dependencies: portfolio
      .filter((project) => project.blocker)
      .map((project) => ({
        fromProject: slugifyProjectId(project.name || path.basename(project.path)),
        toProject: '',
        capability: project.blocker,
        status: 'blocked',
        priorityImpact: 'raise_to_P0',
        reason: project.blocker,
        updatedAt: project.recentActivityAt || ''
      })),
    learningCandidateCount: 0
  };
}

export function ensureGlobalEngineeringStore(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  return createGlobalEngineeringSnapshotPlaceholder(dataPath, portfolio);
}
