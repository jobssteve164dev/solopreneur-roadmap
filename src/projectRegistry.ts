import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}

export function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

export function normalizeGlobalDataPathForExtension(rawPath: string, workspaceRoot = ''): string {
  const trimmed = String(rawPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  return path.join(getDefaultSolomapGlobalParent(workspaceRoot), '.solomap-global');
}

export function getDefaultSolomapGlobalParent(workspaceRoot = ''): string {
  const candidateRoot = String(workspaceRoot || '').trim() || process.cwd();
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

function getProjectRegistryPath(globalDataPath: string, projectRegistryFileName: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), projectRegistryFileName);
}

export function readProjectRegistry(globalDataPath: string, projectRegistryFileName: string): ProjectRegistryFile | null {
  const registryPath = getProjectRegistryPath(globalDataPath, projectRegistryFileName);
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      schemaVersion: 1,
      updatedAt: String(parsed.updatedAt || ''),
      projects: normalizeProjectsForStorage(Array.isArray(parsed.projects) ? parsed.projects : []),
      hiddenProjects: Array.isArray(parsed.hiddenProjects)
        ? parsed.hiddenProjects.map((item: unknown) => String(item || '').trim()).filter(Boolean)
        : []
    };
  } catch (error) {
    console.error('SoloMap failed to read global project registry:', error);
    return null;
  }
}

export function writeProjectRegistry(globalDataPath: string, projectRegistryFileName: string, projects: SolopreneurProject[], hiddenProjects: string[]): void {
  const registryPath = getProjectRegistryPath(globalDataPath, projectRegistryFileName);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const payload: ProjectRegistryFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    projects: normalizeProjectsForStorage(projects),
    hiddenProjects: [...new Set((hiddenProjects || []).map((item) => String(item || '').trim()).filter(Boolean))]
  };
  fs.writeFileSync(registryPath, JSON.stringify(payload, null, 2), 'utf8');
}

export function getHiddenProjects(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyHiddenProjects: string[];
}): string[] {
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  return registry ? registry.hiddenProjects : input.legacyHiddenProjects;
}

export function getProjects(input: {
  globalDataPath: string;
  projectRegistryFileName: string;
  legacyProjects: SolopreneurProject[];
  legacyHiddenProjects: string[];
  workspaceRoot?: string;
}): SolopreneurProject[] {
  const registry = readProjectRegistry(input.globalDataPath, input.projectRegistryFileName);
  const savedProjects = registry ? registry.projects : input.legacyProjects;
  const hiddenProjects = new Set(registry ? registry.hiddenProjects : input.legacyHiddenProjects);
  const workspaceRoot = String(input.workspaceRoot || '').trim();
  const projects = normalizeProjectsForStorage(savedProjects);

  if (workspaceRoot && !hiddenProjects.has(workspaceRoot) && !projects.some((project) => project.path === workspaceRoot)) {
    projects.unshift({
      name: projectName(workspaceRoot),
      path: workspaceRoot
    });
  }

  const normalizedProjects = normalizeProjectsForStorage(projects);
  if (!registry) {
    writeProjectRegistry(input.globalDataPath, input.projectRegistryFileName, normalizedProjects, [...hiddenProjects]);
  }
  return sortProjectsForDisplay(normalizedProjects);
}

export function getSelectedProjectPath(projects: SolopreneurProject[], savedSelected: string): string {
  if (savedSelected && projects.some((project) => project.path === savedSelected)) {
    return savedSelected;
  }
  return projects[0]?.path || '';
}
