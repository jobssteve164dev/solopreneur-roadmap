import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentConversation } from './db/types';
import { ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

const cacheVersion = 3;

export interface SidebarConversationSnapshot {
  solo: AgentConversation[];
  project: AgentConversation[];
  flow: AgentConversation[];
  revision: AgentConversation[];
}

interface CachedConversationSnapshot {
  sourceRevision: string;
  snapshot: SidebarConversationSnapshot;
}

interface AnalysisState<T> { objectId: string | null; revision: number; value: T | null }

export interface SidebarCoreSnapshotCache {
  version: number;
  projectSignature: string;
  portfolio: ProjectPortfolioSummary[];
}

export interface SidebarCoreSnapshotReservation {
  requestId: string;
  generation: number;
}

function statSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

export function buildSidebarProjectSignature(projects: SolopreneurProject[]): string {
  return projects.map((project) => JSON.stringify({
    name: project.name,
    path: project.path,
    type: project.type || '',
    priority: project.priority || '',
    pinnedAt: project.pinnedAt || '',
    roadmap: statSignature(path.join(project.path, '.solopreneur', 'roadmap.csv'))
  })).join('|');
}

function dataRoot(globalDataPath: string, projectPath = ''): string {
  return normalizeGlobalDataPathForExtension(globalDataPath, projectPath || process.cwd());
}

async function readState<T>(globalDataPath: string, projectPath: string | null, key: string): Promise<AnalysisState<T>> {
  return sendRuntimeDataRequest<AnalysisState<T>>(dataRoot(globalDataPath, projectPath || ''), {
    operation: 'read_analysis_state', input: { ...(projectPath ? { root: projectPath } : {}), namespace: 'sidebar', key }
  });
}

async function writeState<T>(globalDataPath: string, projectPath: string | null, key: string, value: T, expectedSourceRevision?: string): Promise<void> {
  const requestId = randomUUID();
  const attempts = expectedSourceRevision === undefined ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await readState<T>(globalDataPath, projectPath, key);
    try {
      await sendRuntimeDataRequest(dataRoot(globalDataPath, projectPath || ''), {
        operation: 'write_analysis_state', input: { ...(projectPath ? { root: projectPath } : {}), namespace: 'sidebar', key,
          expectedRevision: current.revision, value, idempotencyKey: `sidebar:${requestId}:${attempt}`,
          ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }) }
      });
      return;
    } catch (error) {
      if (!/revision_conflict/.test(String(error)) || attempt === attempts - 1) throw error;
    }
  }
}

export async function buildConversationDatabaseSignature(globalDataPath: string, projectPath: string): Promise<string> {
  const source = await sendRuntimeDataRequest<{ conversationRevision: string }>(dataRoot(globalDataPath, projectPath), {
    operation: 'read_project_analysis_source', input: { root: projectPath }
  });
  return source.conversationRevision;
}

export async function readSidebarCoreSnapshot(globalDataPath: string): Promise<SidebarCoreSnapshotCache | null> {
  if (!globalDataPath) return null;
  try {
    const state = await readState<SidebarCoreSnapshotCache>(globalDataPath, null, 'core');
    const parsed = state.value;
    if (!parsed || parsed.version !== cacheVersion || !Array.isArray(parsed.portfolio)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSidebarPortfolioSnapshot(globalDataPath: string, projectSignature: string, portfolio: ProjectPortfolioSummary[]): Promise<void> {
  if (!globalDataPath) return;
  const reservation = await reserveSidebarPortfolioSnapshot(globalDataPath);
  await commitSidebarPortfolioSnapshot(globalDataPath, reservation, projectSignature, portfolio);
}

export async function reserveSidebarPortfolioSnapshot(globalDataPath: string): Promise<SidebarCoreSnapshotReservation> {
  if (!globalDataPath) throw new Error('sidebar_data_root_missing');
  const requestId = randomUUID();
  return sendRuntimeDataRequest<SidebarCoreSnapshotReservation>(dataRoot(globalDataPath), {
    operation: 'reserve_sidebar_core_refresh', input: { requestId }
  });
}

export async function commitSidebarPortfolioSnapshot(
  globalDataPath: string,
  reservation: SidebarCoreSnapshotReservation,
  projectSignature: string,
  portfolio: ProjectPortfolioSummary[]
): Promise<boolean> {
  if (!globalDataPath) return false;
  const result = await sendRuntimeDataRequest<{ accepted: boolean }>(dataRoot(globalDataPath), {
    operation: 'commit_sidebar_core_refresh', input: {
      requestId: reservation.requestId,
      generation: reservation.generation,
      value: { version: cacheVersion, projectSignature, portfolio }
    }
  });
  return result.accepted;
}

export async function readCachedConversationSnapshot(globalDataPath: string, projectPath: string): Promise<SidebarConversationSnapshot | null> {
  if (!globalDataPath || !projectPath) return null;
  try {
    const [state, sourceRevision] = await Promise.all([
      readState<CachedConversationSnapshot>(globalDataPath, projectPath, 'conversation'),
      buildConversationDatabaseSignature(globalDataPath, projectPath)
    ]);
    const cached = state.value;
    if (!cached || cached.sourceRevision !== sourceRevision) return null;
    if (!Array.isArray(cached.snapshot?.solo) || !Array.isArray(cached.snapshot?.project)
      || !Array.isArray(cached.snapshot?.flow) || !Array.isArray(cached.snapshot?.revision)) return null;
    return cached.snapshot;
  } catch {
    return null;
  }
}

export async function writeCachedConversationSnapshot(globalDataPath: string, projectPath: string, sourceRevision: string, snapshot: SidebarConversationSnapshot): Promise<void> {
  if (!globalDataPath || !projectPath) return;
  await writeState(globalDataPath, projectPath, 'conversation', { sourceRevision, snapshot }, sourceRevision);
}
