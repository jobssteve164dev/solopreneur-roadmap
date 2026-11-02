import { randomUUID } from 'crypto';
import { AgentConversation } from './db/types';
import { ProjectPortfolioSummary } from './projectPortfolio';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

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

export async function readSidebarCoreProjections(globalDataPath: string, projectPaths: string[] = []): Promise<ProjectPortfolioSummary[]> {
  if (!globalDataPath) return [];
  const records = await sendRuntimeDataRequest<Array<{ summary: ProjectPortfolioSummary }>>(dataRoot(globalDataPath), {
    operation: 'read_sidebar_core_projections',
    input: projectPaths.length ? { projectPaths } : {},
    supersedesKey: `sidebar-core:${projectPaths.length ? [...projectPaths].sort().join('|') : 'all'}`
  });
  return records.map(record => record.summary).filter(summary => Boolean(summary?.path));
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
