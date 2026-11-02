import { SolopreneurProject } from './projectPortfolio';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

interface SidebarProjectLoaderOptions {
  isAvailable: () => boolean;
  postMessage: (message: any) => void;
  getGlobalDataPath: () => string;
}

export class SidebarProjectLoader {
  private issueRequest = 0;
  private pullRequestRequest = 0;
  private deliveryRequest = 0;
  private securityRequest = 0;
  private repositoryRequest = 0;
  private activeSignalLoads = 0;
  private readonly signalLoadWaiters: Array<() => void> = [];
  private readonly signalRequests = new Map<string, number>();
  private readonly repositoryLoads = new Map<string, Promise<string | null>>();

  constructor(private readonly options: SidebarProjectLoaderOptions) {}

  public cancelExternalLoads(): void {
    this.issueRequest += 1;
    this.pullRequestRequest += 1;
    this.deliveryRequest += 1;
    this.securityRequest += 1;
    this.repositoryRequest += 1;
    this.repositoryLoads.clear();
  }

  public invalidateProjectSignals(projectPath: string, kinds: Array<'issues' | 'pullRequests' | 'delivery' | 'security'>): void {
    for (const kind of kinds) {
      const key = `${kind}:${projectPath}`;
      this.signalRequests.set(key, (this.signalRequests.get(key) || 0) + 1);
    }
  }

  private signalRequest(kind: string, projectPath: string): number {
    return this.signalRequests.get(`${kind}:${projectPath}`) || 0;
  }

  public scheduleExternalSignals(projects: SolopreneurProject[], selectedProjectPath: string, scoped = false): void {
    const globalDataPath = this.options.getGlobalDataPath();
    const isCurrentRoot = () => globalDataPath === this.options.getGlobalDataPath();
    if (!scoped) {
      this.repositoryRequest += 1;
      this.repositoryLoads.clear();
    }
    this.scheduleIssueLoads(projects, selectedProjectPath, scoped, globalDataPath, isCurrentRoot);
    this.schedulePullRequestLoads(projects, selectedProjectPath, scoped, globalDataPath, isCurrentRoot);
    this.scheduleDeliveryLoads(projects, selectedProjectPath, scoped, globalDataPath, isCurrentRoot);
    this.scheduleSecurityLoads(projects, selectedProjectPath, scoped, globalDataPath, isCurrentRoot);
  }

  public prioritizeProjectSignals(project: SolopreneurProject): void {
    this.invalidateProjectSignals(project.path, ['issues', 'pullRequests', 'delivery', 'security']);
    this.scheduleExternalSignals([project], project.path, true);
  }

  public async refreshProjectSignals(projectPath: string): Promise<{
    issues: any;
    pullRequests: any;
    delivery: any;
    security: any;
  }> {
    const globalDataPath = this.options.getGlobalDataPath();
    const loadSignal = async (kind: 'issues' | 'pullRequests' | 'delivery' | 'security', label: string) => {
      try {
        return await this.withSignalSlot(() => this.loadRuntimeSignal(projectPath, kind, true, globalDataPath), true);
      } catch (error) {
        console.error(`SoloMap sidebar failed to refresh ${label}:`, error);
        return null;
      }
    };
    const [issues, pullRequests, delivery, security] = await Promise.all([
      loadSignal('issues', 'issue summary'),
      loadSignal('pullRequests', 'pull request summary'),
      loadSignal('delivery', 'delivery summary'),
      loadSignal('security', 'security summary')
    ]);
    return { issues, pullRequests, delivery, security };
  }

  public async refreshProjectSignal(
    projectPath: string,
    kind: 'issues' | 'pullRequests' | 'delivery' | 'security',
    globalDataPath = this.options.getGlobalDataPath()
  ): Promise<any> {
    if (globalDataPath !== this.options.getGlobalDataPath()) return null;
    try {
      return await this.withSignalSlot(() => this.loadRuntimeSignal(projectPath, kind, true, globalDataPath), true);
    } catch (error) {
      console.error(`SoloMap sidebar failed to refresh ${kind}:`, error);
      return null;
    }
  }

  private async loadRuntimeSignal(projectPath: string, kind: 'issues' | 'pullRequests' | 'delivery' | 'security', force: boolean, globalDataPath: string): Promise<any> {
    const dataRoot = normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
    let repository = this.repositoryLoads.get(projectPath);
    if (!repository) {
      const generation = this.repositoryRequest;
      repository = sendRuntimeDataRequest<{ repo: string | null }>(dataRoot, {
        operation: 'resolve_project_repository',
        input: { root: projectPath },
        supersedesKey: `project-repository:${projectPath}`
      }).then(result => generation === this.repositoryRequest ? result.repo : null);
      this.repositoryLoads.set(projectPath, repository);
      void repository.catch(() => {
        if (this.repositoryLoads.get(projectPath) === repository) this.repositoryLoads.delete(projectPath);
      });
    }
    const repo = await repository;
    if (globalDataPath !== this.options.getGlobalDataPath()) return null;
    if (repo === null) return undefined;
    if (this.options.isAvailable() && globalDataPath === this.options.getGlobalDataPath()) {
      this.options.postMessage({ command: 'projectRepositoryResolved', projectPath, repo });
    }
    if (!repo) return undefined;
    const result = await sendRuntimeDataRequest<{ repo: string | null; value: any }>(
      dataRoot,
      {
        operation: 'refresh_project_signal',
        input: { root: projectPath, repo, kind, force },
        ...(force ? {} : { supersedesKey: `project-signal:${kind}:${projectPath}` })
      }
    );
    return result.value === null ? undefined : result.value;
  }

  private orderedProjects(projects: SolopreneurProject[], selectedProjectPath: string): SolopreneurProject[] {
    return [
      ...projects.filter((project) => project.path === selectedProjectPath),
      ...projects.filter((project) => project.path !== selectedProjectPath)
    ];
  }

  private scheduleSignalQueue(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    initialDelayMs: number,
    staggerMs: number,
    isCurrent: (project: SolopreneurProject) => boolean,
    load: (project: SolopreneurProject) => Promise<any>,
    deliver: (project: SolopreneurProject, value: any) => void,
    errorMessage: string
  ): void {
    const ordered = this.orderedProjects(projects, selectedProjectPath);
    let cursor = 0;
    const runWorker = async (workerIndex: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, initialDelayMs + staggerMs * workerIndex));
      while (cursor < ordered.length) {
        const project = ordered[cursor++];
        if (!isCurrent(project)) continue;
        try {
          const value = await this.withSignalSlot(
            async () => isCurrent(project) ? load(project) : undefined,
            project.path === selectedProjectPath
          );
          if (value !== undefined && isCurrent(project)) deliver(project, value);
        } catch (error) {
          console.error(errorMessage, error);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };
    for (let worker = 0; worker < Math.min(2, ordered.length); worker += 1) void runWorker(worker);
  }

  private async withSignalSlot<T>(load: () => Promise<T>, priority = false): Promise<T> {
    if (this.activeSignalLoads >= 2) {
      await new Promise<void>(resolve => priority
        ? this.signalLoadWaiters.unshift(resolve)
        : this.signalLoadWaiters.push(resolve));
    }
    this.activeSignalLoads += 1;
    try {
      return await load();
    } finally {
      this.activeSignalLoads -= 1;
      this.signalLoadWaiters.shift()?.();
    }
  }

  private scheduleIssueLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.issueRequest : ++this.issueRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('issues', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1200, 80,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.issueRequest && projectRequests.get(project.path) === this.signalRequest('issues', project.path),
      project => this.loadRuntimeSignal(project.path, 'issues', false, globalDataPath),
      (project, issues) => this.options.postMessage({ command: 'projectIssuesLoaded', projectPath: project.path, issues }),
      'SoloMap sidebar failed to refresh issue summary:');
  }

  private schedulePullRequestLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.pullRequestRequest : ++this.pullRequestRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('pullRequests', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1300, 100,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.pullRequestRequest && projectRequests.get(project.path) === this.signalRequest('pullRequests', project.path),
      project => this.loadRuntimeSignal(project.path, 'pullRequests', false, globalDataPath),
      (project, pullRequests) => this.options.postMessage({ command: 'projectPullRequestsLoaded', projectPath: project.path, pullRequests }),
      'SoloMap sidebar failed to refresh pull request summary:');
  }

  private scheduleDeliveryLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.deliveryRequest : ++this.deliveryRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('delivery', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1400, 120,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.deliveryRequest && projectRequests.get(project.path) === this.signalRequest('delivery', project.path),
      project => this.loadRuntimeSignal(project.path, 'delivery', false, globalDataPath),
      (project, delivery) => this.options.postMessage({ command: 'projectDeliveryLoaded', projectPath: project.path, delivery }),
      'SoloMap sidebar failed to refresh delivery summary:');
  }

  private scheduleSecurityLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.securityRequest : ++this.securityRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('security', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1600, 140,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.securityRequest && projectRequests.get(project.path) === this.signalRequest('security', project.path),
      project => this.loadRuntimeSignal(project.path, 'security', false, globalDataPath),
      (project, security) => this.options.postMessage({ command: 'projectSecurityLoaded', projectPath: project.path, security }),
      'SoloMap sidebar failed to refresh security summary:');
  }
}
