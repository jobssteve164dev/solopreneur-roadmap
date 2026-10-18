import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  description?: string;
  notes?: string;
  pinnedAt?: string;
}

export interface ProjectRegistryFile {
  schemaVersion: number;
  updatedAt: string;
  projects: SolopreneurProject[];
  hiddenProjects: string[];
  selectedProjectPath?: string;
}

export interface ProjectRegistrySnapshot {
  legacyContextImported: boolean;
  objectId: string;
  revision: number;
  registry: ProjectRegistryFile;
}

export interface ProjectRegistryPatch {
  expectedRevision: number;
  idempotencyKey: string;
  projectPatches?: Array<{ path: string; fields?: Partial<Omit<SolopreneurProject, 'path'>>; remove?: boolean }>;
  hiddenPatches?: Array<{ path: string; hidden: boolean }>;
  selectedProjectPath?: string;
  autonomyMove?: {
    sourcePath: string;
    targetPath: string;
    enabled?: boolean;
    toolNetworkDisabled?: boolean;
  };
}

export interface ProjectRegistryBootstrap {
  legacyProjects?: SolopreneurProject[];
  legacyHiddenProjects?: string[];
  legacySelectedProjectPath?: string;
  workspaceRoot?: string;
}

type RegistryOperation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
const registrySnapshots = new Map<string, ProjectRegistrySnapshot>();
const registryReads = new Map<string, Promise<ProjectRegistrySnapshot>>();

function acceptRegistrySnapshot(root: string, snapshot: ProjectRegistrySnapshot): ProjectRegistrySnapshot {
  const previous = registrySnapshots.get(root);
  if (!previous || previous.objectId !== snapshot.objectId || previous.revision <= snapshot.revision) registrySnapshots.set(root, snapshot);
  return registrySnapshots.get(root)!;
}

async function registryOperation(root: string, operation?: RegistryOperation): Promise<RegistryOperation> {
  if (operation) return operation;
  const { sendRuntimeDataRequest } = await import('./autonomousRuntimeControl');
  return (name, input) => sendRuntimeDataRequest(root, { operation: name, input });
}

export async function refreshProjectRegistry(globalDataPath: string, bootstrap?: () => ProjectRegistryBootstrap, operation?: RegistryOperation): Promise<ProjectRegistrySnapshot> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const pending = registryReads.get(root);
  if (pending) {
    const snapshot = await pending;
    if (!bootstrap || snapshot.legacyContextImported) return snapshot;
  }
  const flight = (async () => {
    const call = await registryOperation(root, operation);
    const previous = registrySnapshots.get(root);
    let result = await call('read_project_registry', previous ? { knownRevision: previous.revision, knownObjectId: previous.objectId } : {}) as ProjectRegistrySnapshot | { objectId: string; revision: number; unchanged: true; legacyContextImported: boolean } | null;
    if (!result || bootstrap && !result.legacyContextImported) result = await call('initialize_project_registry', { ...(bootstrap?.() || {}) }) as ProjectRegistrySnapshot;
    if ('unchanged' in result) {
      const current = registrySnapshots.get(root);
      if (!current || current.objectId !== result.objectId) throw new Error('project_registry_snapshot_missing');
      return current;
    }
    return acceptRegistrySnapshot(root, result);
  })();
  registryReads.set(root, flight);
  try { return await flight; }
  finally { if (registryReads.get(root) === flight) registryReads.delete(root); }
}

export async function patchProjectRegistry(globalDataPath: string, changes: Omit<ProjectRegistryPatch, 'expectedRevision' | 'idempotencyKey'>, idempotencyKey = `project-registry:${crypto.randomUUID()}`, operation?: RegistryOperation, isCurrent?: () => boolean): Promise<ProjectRegistrySnapshot> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const call = await registryOperation(root, operation);
  let snapshot = registrySnapshots.get(root) || await refreshProjectRegistry(root, undefined, call);
  for (;;) {
    try {
      const accepted = await call('patch_project_registry', { ...changes, expectedRevision: snapshot.revision, idempotencyKey }) as ProjectRegistrySnapshot;
      acceptRegistrySnapshot(root, accepted);
      return accepted;
    } catch (error) {
      if ((error as Error).message !== 'revision_conflict') throw error;
      snapshot = await refreshProjectRegistry(root, undefined, call);
      if (isCurrent && !isCurrent()) return snapshot;
    }
  }
}

export function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

export function normalizeGlobalDataPathForExtension(rawPath: string, workspaceRoot = ''): string {
  const trimmed = String(rawPath || '').trim();
  if (trimmed) {
    const absolute = path.resolve(trimmed);
    return absolute.endsWith('.solomap-global') ? absolute : path.join(absolute, '.solomap-global');
  }
  return path.join(getDefaultSolomapGlobalParent(workspaceRoot), '.solomap-global');
}

export function getDefaultSolomapGlobalParent(workspaceRoot = ''): string {
  const candidateRoot = path.resolve(String(workspaceRoot || '').trim() || process.cwd());
  const parent = path.dirname(candidateRoot);
  if (parent && parent !== path.parse(parent).root) {
    return parent;
  }
  const home = os.homedir();
  if (home && home !== path.parse(home).root) {
    return home;
  }
  return os.tmpdir();
}

export function normalizeProjectsForStorage(projects: SolopreneurProject[]): SolopreneurProject[] {
  const seen = new Set<string>();
  return (projects || [])
    .map((project) => ({
      name: String(project.name || projectName(project.path || '')).trim(),
      path: String(project.path || '').trim(),
      ...(project.type ? { type: String(project.type) } : {}),
      ...(project.priority ? { priority: String(project.priority) } : {}),
      ...(project.description ? { description: String(project.description) } : {}),
      ...(project.notes ? { notes: String(project.notes) } : {}),
      ...(project.pinnedAt ? { pinnedAt: String(project.pinnedAt) } : {})
    }))
    .filter((project) => {
      if (!project.path || seen.has(project.path)) {
        return false;
      }
      seen.add(project.path);
      return true;
    });
}

export function sortProjectsForDisplay(projects: SolopreneurProject[]): SolopreneurProject[] {
  return [...projects].sort((a, b) => {
    const pinnedA = a.pinnedAt ? 1 : 0;
    const pinnedB = b.pinnedAt ? 1 : 0;
    if (pinnedA !== pinnedB) {
      return pinnedB - pinnedA;
    }
    if (a.pinnedAt || b.pinnedAt) {
      return String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || ''));
    }
    return 0;
  });
}

export function readProjectRegistry(globalDataPath: string, projectRegistryFileName: string): ProjectRegistryFile | null {
  const snapshot = registrySnapshots.get(normalizeGlobalDataPathForExtension(globalDataPath));
  return snapshot ? structuredClone(snapshot.registry) : null;
}

export async function writeProjectRegistry(globalDataPath: string, projectRegistryFileName: string, projects: SolopreneurProject[], hiddenProjects: string[]): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const previous = registrySnapshots.get(root);
  const snapshot = previous || await refreshProjectRegistry(root);
  const projectPatches: NonNullable<ProjectRegistryPatch['projectPatches']> = [];
  for (const project of projects) {
    const old = previous?.registry.projects.find(candidate => candidate.path === project.path);
    const fields: Partial<Omit<SolopreneurProject, 'path'>> = {};
    for (const key of ['name', 'type', 'priority', 'description', 'notes', 'pinnedAt'] as const) if (project[key] !== undefined && project[key] !== old?.[key]) fields[key] = project[key];
    if (Object.keys(fields).length) projectPatches.push({ path: project.path, fields });
  }
  if (previous) for (const old of previous.registry.projects) if (!projects.some(project => project.path === old.path)) projectPatches.push({ path: old.path, remove: true });
  const hiddenPatches = [...new Set([...snapshot.registry.hiddenProjects, ...hiddenProjects])].filter(projectPath => snapshot.registry.hiddenProjects.includes(projectPath) !== hiddenProjects.includes(projectPath)).map(projectPath => ({ path: projectPath, hidden: hiddenProjects.includes(projectPath) }));
  if (projectPatches.length || hiddenPatches.length) await patchProjectRegistry(root, { projectPatches, hiddenPatches });
}

export function getHiddenProjects(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyHiddenProjects: string[];
}): string[] {
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  return registry ? registry.hiddenProjects : [];
}

export function getProjects(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyProjects: SolopreneurProject[];
  legacyHiddenProjects: string[];
  workspaceRoot?: string;
}): SolopreneurProject[] {
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  const savedProjects = registry ? registry.projects : [];
  const hiddenProjects = new Set(registry ? registry.hiddenProjects : []);
  const workspaceRoot = String(input.workspaceRoot || '').trim();
  const projects = normalizeProjectsForStorage(savedProjects);

  if (registry && workspaceRoot && !hiddenProjects.has(workspaceRoot) && !projects.some((project) => project.path === workspaceRoot)) {
    projects.unshift({
      name: projectName(workspaceRoot),
      path: workspaceRoot
    });
  }

  const normalizedProjects = normalizeProjectsForStorage(projects);
  return sortProjectsForDisplay(normalizedProjects);
}

export function getProjectsSnapshot(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyProjects: SolopreneurProject[];
  legacyHiddenProjects: string[];
  workspaceRoot?: string;
}): SolopreneurProject[] {
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  const savedProjects = registry ? registry.projects : [];
  const hiddenProjects = new Set(registry ? registry.hiddenProjects : []);
  const workspaceRoot = String(input.workspaceRoot || '').trim();
  const projects = normalizeProjectsForStorage(savedProjects);
  if (registry && workspaceRoot && !hiddenProjects.has(workspaceRoot) && !projects.some(project => project.path === workspaceRoot)) {
    projects.unshift({ name: projectName(workspaceRoot), path: workspaceRoot });
  }
  return sortProjectsForDisplay(normalizeProjectsForStorage(projects));
}

export function getProjectsReadOnly(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyProjects: SolopreneurProject[];
  legacyHiddenProjects: string[];
  workspaceRoot?: string;
}): SolopreneurProject[] {
  const readableProjectDirectory = (projectPath: string): boolean => {
    if (!path.isAbsolute(projectPath)) return false;
    try {
      fs.accessSync(projectPath, fs.constants.R_OK);
      return fs.statSync(projectPath).isDirectory();
    } catch {
      return false;
    }
  };
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  const savedProjects = registry ? registry.projects : [];
  const hiddenProjects = new Set(registry ? registry.hiddenProjects : []);
  const workspaceRoot = String(input.workspaceRoot || '').trim();
  const projects = normalizeProjectsForStorage(savedProjects)
    .filter(project => !hiddenProjects.has(project.path) && readableProjectDirectory(project.path));

  if (registry && workspaceRoot && readableProjectDirectory(workspaceRoot) && !hiddenProjects.has(workspaceRoot) && !projects.some((project) => project.path === workspaceRoot)) {
    projects.unshift({
      name: projectName(workspaceRoot),
      path: workspaceRoot
    });
  }

  return sortProjectsForDisplay(normalizeProjectsForStorage(projects));
}

export function getSelectedProjectPath(projects: SolopreneurProject[], savedSelected: string): string {
  if (savedSelected && projects.some((project) => project.path === savedSelected)) {
    return savedSelected;
  }
  return projects[0]?.path || '';
}
