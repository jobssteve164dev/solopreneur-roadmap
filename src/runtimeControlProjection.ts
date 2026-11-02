import type { ProjectRegistrySnapshot } from './projectRegistry';

export type ProjectRegistryReadInput = {
  revision?: number;
  knownRevision?: number;
  knownObjectId?: string;
};

export type ProjectRegistryReadResult = ProjectRegistrySnapshot | {
  objectId: string;
  revision: number;
  unchanged: true;
  legacyContextImported: boolean;
} | null;

/** Versioned control-plane projections fed by the database Writer after commit. */
export class RuntimeControlProjection {
  private projectRegistry: ProjectRegistrySnapshot | null | undefined;

  hydrateProjectRegistry(snapshot: ProjectRegistrySnapshot | null): void {
    if (snapshot === null) {
      if (this.projectRegistry === undefined) this.projectRegistry = null;
      return;
    }
    const previous = this.projectRegistry;
    if (previous && previous.objectId === snapshot.objectId && previous.revision > snapshot.revision) return;
    this.projectRegistry = structuredClone(snapshot);
  }

  canServeProjectRegistry(input: ProjectRegistryReadInput): boolean {
    if (this.projectRegistry === undefined) return false;
    if (input.revision === undefined) return true;
    return this.projectRegistry !== null && this.projectRegistry.revision === input.revision;
  }

  readProjectRegistry(input: ProjectRegistryReadInput): ProjectRegistryReadResult {
    if (this.projectRegistry === undefined) throw new Error('runtime_project_registry_projection_not_ready');
    if (input.revision !== undefined && (this.projectRegistry === null || this.projectRegistry.revision !== input.revision)) {
      throw new Error('runtime_project_registry_projection_revision_unavailable');
    }
    if (this.projectRegistry === null) return null;
    if (input.revision === undefined && input.knownRevision === this.projectRegistry.revision
      && (!input.knownObjectId || input.knownObjectId === this.projectRegistry.objectId)) {
      return {
        objectId: this.projectRegistry.objectId,
        revision: this.projectRegistry.revision,
        unchanged: true,
        legacyContextImported: this.projectRegistry.legacyContextImported
      };
    }
    return structuredClone(this.projectRegistry);
  }

  readProjectRegistryWithFallback(
    input: ProjectRegistryReadInput,
    fallback: (input: ProjectRegistryReadInput) => Promise<ProjectRegistryReadResult>
  ): Promise<ProjectRegistryReadResult> {
    if (this.canServeProjectRegistry(input)) return Promise.resolve(this.readProjectRegistry(input));
    return fallback(input);
  }
}
