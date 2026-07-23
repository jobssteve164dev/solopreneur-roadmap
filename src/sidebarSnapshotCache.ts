import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentConversation } from './db/types';
import { ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';

const cacheVersion = 1;
const cacheFileName = 'sidebar-core-snapshot-v1.json';

export interface SidebarConversationSnapshot {
  solo: AgentConversation[];
  project: AgentConversation[];
  flow: AgentConversation[];
}

interface CachedConversationSnapshot {
  signature: string;
  snapshot: SidebarConversationSnapshot;
}

export interface SidebarCoreSnapshotCache {
  version: number;
  projectSignature: string;
  portfolio: ProjectPortfolioSummary[];
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

export function buildConversationDatabaseSignature(projectPath: string): string {
  return statSignature(path.join(projectPath, '.solopreneur', 'project_journal.db'));
}

function cachePath(globalDataPath: string): string {
  return path.join(globalDataPath, cacheFileName);
}

function conversationCachePath(globalDataPath: string, projectPath: string): string {
  const projectKey = createHash('sha1').update(projectPath).digest('hex');
  return path.join(globalDataPath, `sidebar-conversation-${projectKey}-v1.json`);
}

export function readSidebarCoreSnapshot(globalDataPath: string): SidebarCoreSnapshotCache | null {
  if (!globalDataPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(globalDataPath), 'utf8')) as SidebarCoreSnapshotCache;
    if (parsed.version !== cacheVersion || !Array.isArray(parsed.portfolio)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSidebarCoreSnapshot(globalDataPath: string, cache: SidebarCoreSnapshotCache): void {
  if (!globalDataPath) return;
  try {
    fs.mkdirSync(globalDataPath, { recursive: true });
    fs.writeFileSync(cachePath(globalDataPath), JSON.stringify(cache), 'utf8');
  } catch (error) {
    console.error('SoloMap failed to persist sidebar core snapshot:', error);
  }
}

export function writeSidebarPortfolioSnapshot(
  globalDataPath: string,
  projectSignature: string,
  portfolio: ProjectPortfolioSummary[]
): void {
  writeSidebarCoreSnapshot(globalDataPath, {
    version: cacheVersion,
    projectSignature,
    portfolio
  });
}

export function readCachedConversationSnapshot(globalDataPath: string, projectPath: string): SidebarConversationSnapshot | null {
  if (!globalDataPath || !projectPath) return null;
  let cached: CachedConversationSnapshot;
  try {
    cached = JSON.parse(fs.readFileSync(conversationCachePath(globalDataPath, projectPath), 'utf8')) as CachedConversationSnapshot;
  } catch {
    return null;
  }
  if (!cached || cached.signature !== buildConversationDatabaseSignature(projectPath)) return null;
  if (!Array.isArray(cached.snapshot?.solo) || !Array.isArray(cached.snapshot?.project) || !Array.isArray(cached.snapshot?.flow)) return null;
  return cached.snapshot;
}

export function writeCachedConversationSnapshot(
  globalDataPath: string,
  projectPath: string,
  snapshot: SidebarConversationSnapshot
): void {
  if (!globalDataPath || !projectPath) return;
  try {
    fs.mkdirSync(globalDataPath, { recursive: true });
    fs.writeFileSync(conversationCachePath(globalDataPath, projectPath), JSON.stringify({
      signature: buildConversationDatabaseSignature(projectPath),
      snapshot
    }), 'utf8');
  } catch (error) {
    console.error('SoloMap failed to persist conversation snapshot:', error);
  }
}
