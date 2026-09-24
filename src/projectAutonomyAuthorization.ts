import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectAutonomyAuthorization {
  projectId: string;
  projectPath: string;
  enabled: boolean;
  toolNetworkDisabled: boolean;
  epoch: number;
  updatedAt: string;
}

export interface ProjectAutonomyPolicy {
  enabled: boolean;
  toolNetworkDisabled: boolean;
}

interface LegacyAuthorizationFile {
  schemaVersion: 1;
  projects: Record<string, ProjectAutonomyAuthorization>;
}

function canonicalPath(value: string): string {
  return fs.realpathSync(String(value || '').trim());
}

function projectId(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath).digest('hex');
}

function emptyFile(): LegacyAuthorizationFile {
  return { schemaVersion: 1, projects: {} };
}

function readLegacyFile(filePath: string): LegacyAuthorizationFile {
  if (!fs.existsSync(filePath)) return emptyFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      schemaVersion: 1,
      projects: parsed && typeof parsed.projects === 'object' ? parsed.projects : {}
    };
  } catch (error) {
    throw new Error(`Unable to read project autonomy authorization: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function normalizeAuthorization(value: Partial<ProjectAutonomyAuthorization>, id: string, resolved: string): ProjectAutonomyAuthorization {
  return {
    projectId: String(value.projectId || id),
    projectPath: String(value.projectPath || resolved),
    enabled: Boolean(value.enabled),
    toolNetworkDisabled: Boolean(value.toolNetworkDisabled),
    epoch: Math.max(0, Number(value.epoch || 0)),
    updatedAt: String(value.updatedAt || '')
  };
}

export class ProjectAutonomyAuthorizationStore {
  public readonly filePath: string;
  private readonly legacyFilePath: string;

  constructor(options: { globalDataPath: string }) {
    this.filePath = path.join(options.globalDataPath, 'runtime', 'project-autonomy-authorizations');
    this.legacyFilePath = `${this.filePath}.json`;
  }

  public get(projectPathValue: string): ProjectAutonomyAuthorization {
    let resolved = String(projectPathValue || '').trim();
    try { resolved = canonicalPath(resolved); } catch { /* A missing project has no grant. */ }
    const id = projectId(resolved);
    const recordPath = path.join(this.filePath, `${id}.json`);
    if (fs.existsSync(recordPath)) {
      try { return normalizeAuthorization(JSON.parse(fs.readFileSync(recordPath, 'utf8')), id, resolved); }
      catch (error) { throw new Error(`Unable to read project autonomy authorization: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return normalizeAuthorization(readLegacyFile(this.legacyFilePath).projects[id] || {
      projectId: id,
      projectPath: resolved,
      enabled: false,
      toolNetworkDisabled: false,
      epoch: 0,
      updatedAt: ''
    }, id, resolved);
  }

  public setEnabled(projectPathValue: string, enabled: boolean, registeredProjectPaths: string[]): ProjectAutonomyAuthorization {
    const previous = this.get(projectPathValue);
    return this.setPolicy(projectPathValue, { enabled, toolNetworkDisabled: previous.toolNetworkDisabled }, registeredProjectPaths);
  }

  public setPolicy(projectPathValue: string, policy: ProjectAutonomyPolicy, registeredProjectPaths: string[]): ProjectAutonomyAuthorization {
    const resolved = canonicalPath(projectPathValue);
    const registered = new Set(registeredProjectPaths.map(candidate => {
      try { return canonicalPath(candidate); } catch { return ''; }
    }).filter(Boolean));
    if (!registered.has(resolved)) {
      throw new Error(`Project folder is not registered: ${projectPathValue}`);
    }
    const id = projectId(resolved);
    const previous = this.get(resolved);
    const enabled = Boolean(policy.enabled);
    const toolNetworkDisabled = Boolean(policy.toolNetworkDisabled);
    if (previous.enabled === enabled && previous.toolNetworkDisabled === toolNetworkDisabled) return previous;
    const next: ProjectAutonomyAuthorization = {
      projectId: id,
      projectPath: resolved,
      enabled,
      toolNetworkDisabled,
      epoch: Math.max(0, Number(previous?.epoch || 0)) + 1,
      updatedAt: new Date().toISOString()
    };
    writeFile(path.join(this.filePath, `${id}.json`), next);
    return next;
  }

  public isCurrent(projectPathValue: string, epoch: number): boolean {
    const current = this.get(projectPathValue);
    return current.enabled && current.epoch === epoch;
  }
}

export function revokeAllProjectAutonomyAuthorizations(globalDataPath: string): void {
  const authorizationRoot = path.join(globalDataPath, 'runtime', 'project-autonomy-authorizations');
  const records = new Map<string, ProjectAutonomyAuthorization>();
  const remember = (id: string, value: Partial<ProjectAutonomyAuthorization>) => {
    const normalized = normalizeAuthorization(value, id, String(value.projectPath || ''));
    const previous = records.get(id);
    if (!previous || normalized.epoch >= previous.epoch) records.set(id, normalized);
  };

  for (const [id, value] of Object.entries(readLegacyFile(`${authorizationRoot}.json`).projects)) {
    remember(id, value);
  }
  if (fs.existsSync(authorizationRoot)) {
    for (const name of fs.readdirSync(authorizationRoot)) {
      if (!name.endsWith('.json')) continue;
      const recordPath = path.join(authorizationRoot, name);
      if (!fs.statSync(recordPath).isFile()) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        remember(id, JSON.parse(fs.readFileSync(recordPath, 'utf8')));
      } catch (error) {
        throw new Error(`Unable to revoke project autonomy authorization: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const updatedAt = new Date().toISOString();
  for (const [id, previous] of records) {
    writeFile(path.join(authorizationRoot, `${id}.json`), {
      ...previous,
      projectId: id,
      enabled: false,
      epoch: previous.epoch + 1,
      updatedAt
    } satisfies ProjectAutonomyAuthorization);
  }
}

export function readProjectAutonomyAuthorization(filePath: string, projectPathValue: string): ProjectAutonomyAuthorization {
  let resolved = String(projectPathValue || '').trim();
  try { resolved = canonicalPath(resolved); } catch { /* Preserve identity for a removed project. */ }
  const id = projectId(resolved);
  const recordPath = path.join(filePath, `${id}.json`);
  if (fs.existsSync(recordPath)) {
    try { return normalizeAuthorization(JSON.parse(fs.readFileSync(recordPath, 'utf8')), id, resolved); }
    catch (error) { throw new Error(`Unable to read project autonomy authorization: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return normalizeAuthorization(readLegacyFile(`${filePath}.json`).projects[id] || {
    projectId: id,
    projectPath: resolved,
    enabled: false,
    toolNetworkDisabled: false,
    epoch: 0,
    updatedAt: ''
  }, id, resolved);
}
