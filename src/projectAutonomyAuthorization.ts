import * as crypto from 'crypto';
import * as fs from 'fs';
import { UnifiedDataStore } from './db/unifiedDataStore';

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

function canonicalPath(value: string): string {
  return fs.realpathSync(String(value || '').trim());
}

export class ProjectAutonomyAuthorizationStore {
  public readonly globalDataPath: string;
  private readonly dataStore: UnifiedDataStore;

  constructor(options: { globalDataPath: string; dataStore: UnifiedDataStore }) {
    this.globalDataPath = options.globalDataPath;
    this.dataStore = options.dataStore;
  }

  public get(projectPathValue: string): ProjectAutonomyAuthorization {
    let resolved = String(projectPathValue || '').trim();
    try { resolved = canonicalPath(resolved); } catch { /* A missing project has no grant. */ }
    return this.dataStore.readProjectAutonomyAuthorization({ projectPath: resolved }) as unknown as ProjectAutonomyAuthorization;
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const previous = this.get(resolved);
      try {
        return this.dataStore.patchProjectAutonomyAuthorization({ projectPath: resolved,
          registeredProjectPaths: [...registered], enabled: Boolean(policy.enabled), toolNetworkDisabled: Boolean(policy.toolNetworkDisabled),
          expectedEpoch: previous.epoch,
          idempotencyKey: `project-autonomy:${previous.projectId}:${previous.epoch}:${Boolean(policy.enabled)}:${Boolean(policy.toolNetworkDisabled)}` }) as unknown as ProjectAutonomyAuthorization;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'revision_conflict' || attempt === 3) throw error;
      }
    }
    throw new Error('project_autonomy_revision_conflict');
  }

  public isCurrent(projectPathValue: string, epoch: number): boolean {
    const current = this.get(projectPathValue);
    return current.enabled && current.epoch === epoch;
  }
}

export function revokeAllProjectAutonomyAuthorizations(store: UnifiedDataStore, idempotencyKey = `project-autonomy-revoke:${crypto.randomUUID()}`): void {
  store.revokeProjectAutonomyAuthorizations({ idempotencyKey });
}
