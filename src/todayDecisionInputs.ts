import { createHash } from 'crypto';
import type { RoadmapNodeLike, SolopreneurProject } from './projectPortfolio.js';

export interface TodayLearningInput {
  revision: string;
  instructions: string;
  projects: Array<{ root: string; lessons: Array<{
    objectId: string; revision: number; summary: string; appliesWhen: string; doesNotApplyWhen: string;
    doThis: string; avoidThis: string; verification: string;
    outcomes: Array<{ verdict: string; result: string; evidence: string[] }>;
  }> }>;
}

export interface TodaySourceGuard { projects: SolopreneurProject[]; revision: string; registryRevision: string }

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function todayRegistryRevision(registry: { projects: SolopreneurProject[]; hiddenProjects: string[] }): string {
  return hash({ projects: registry.projects, hiddenProjects: [...registry.hiddenProjects].sort() });
}

export function todayRoadmapRevision(nodes: RoadmapNodeLike[]): string {
  return hash(nodes.map(node => ({
    id: String(node.id || '').trim(), title: String(node.title || '').trim(), stage: String(node.stage || '').trim(),
    status: String(node.status || 'Pending').trim() || 'Pending', agentCli: String(node.agentCli || '').trim(), dependencies: String(node.dependencies || '').trim()
  })).filter(node => node.id));
}

export function todayRoadmapSnapshotRevision(snapshot: { acceptedHash: string; revision: number; generation: number; projectedGeneration: number; pending: boolean }): string {
  return hash([snapshot.acceptedHash, snapshot.revision, snapshot.generation, snapshot.projectedGeneration, snapshot.pending]);
}

export function todaySourceRevision(projects: SolopreneurProject[], roadmaps: Map<string, string>, learningRevision = ''): string {
  return hash({ projects: projects.map(project => ({
    name: String(project.name || ''), path: String(project.path || ''), type: String(project.type || ''),
    priority: String(project.priority || ''), pinnedAt: String(project.pinnedAt || ''), roadmapRevision: roadmaps.get(project.path) || todayRoadmapRevision([])
  })), learningRevision });
}
