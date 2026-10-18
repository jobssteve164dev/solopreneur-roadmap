import {
  loadExternalDeliverySummary,
  loadExternalIssueSummary,
  loadExternalPullRequestSummary,
  loadExternalSecuritySummary,
  readCachedExternalSignals,
  resolveGithubRepoSlug
} from './projectExternalSignals';
import { buildProjectPortfolioSummary, ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';
import { readProjectInvestmentStatsFromDatabase } from './projectAnalytics';
import { readLearningOverview } from './learningLedger';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import type { DocumentationManifest } from './documentationManifest';

interface SidebarProjectLoaderOptions {
  isAvailable: () => boolean;
  postMessage: (message: any) => void;
  getGlobalDataPath: () => string;
  getExtensionPath: () => string;
  buildGlobalStore: (dataPath: string, portfolio: ProjectPortfolioSummary[]) => any;
  buildGlobalStorePlaceholder: (dataPath: string, portfolio: ProjectPortfolioSummary[]) => any;
}

export class SidebarProjectLoader {
  private portfolioRequest = 0;
  private issueRequest = 0;
  private pullRequestRequest = 0;
  private deliveryRequest = 0;
  private securityRequest = 0;
  private cachedSignalRequest = 0;
  private repositoryRequest = 0;
  private activeSignalLoads = 0;
  private readonly signalLoadWaiters: Array<() => void> = [];
  private readonly portfolioProjectRequests = new Map<string, number>();
  private readonly latestEnrichedPortfolio = new Map<string, ProjectPortfolioSummary>();
  private readonly signalRequests = new Map<string, number>();

  constructor(private readonly options: SidebarProjectLoaderOptions) {}

  public cancelExternalLoads(): void {
    this.portfolioRequest += 1;
    this.issueRequest += 1;
    this.pullRequestRequest += 1;
    this.deliveryRequest += 1;
    this.securityRequest += 1;
    this.cachedSignalRequest += 1;
    this.repositoryRequest += 1;
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

  public scheduleAll(projects: SolopreneurProject[], selectedProjectPath: string, basePortfolio: ProjectPortfolioSummary[] = []): void {
    this.schedulePortfolioEnrichment(projects, selectedProjectPath, basePortfolio);
    this.scheduleExternalSignals(projects, selectedProjectPath);
  }

  public scheduleExternalSignals(projects: SolopreneurProject[], selectedProjectPath: string, scoped = false): void {
    const globalDataPath = this.options.getGlobalDataPath();
    const isCurrentRoot = () => globalDataPath === this.options.getGlobalDataPath();
    const requestId = scoped ? this.repositoryRequest : ++this.repositoryRequest;
    const repos = new Map<string, Promise<string | null>>();
    const resolveRepo = (project: SolopreneurProject) => {
      let pending = repos.get(project.path);
      if (!pending) {
        pending = resolveGithubRepoSlug(project.path).then(repo => {
          if (repo !== null && isCurrentRoot() && this.options.isAvailable() && requestId === this.repositoryRequest) {
            this.options.postMessage({ command: 'projectRepositoryResolved', projectPath: project.path, repo });
          }
          return repo;
        });
        repos.set(project.path, pending);
      }
      return pending;
    };
    this.publishSelectedCachedSignals(projects, selectedProjectPath, resolveRepo, globalDataPath, isCurrentRoot);
    this.scheduleIssueLoads(projects, selectedProjectPath, resolveRepo, scoped, globalDataPath, isCurrentRoot);
    this.schedulePullRequestLoads(projects, selectedProjectPath, resolveRepo, scoped, globalDataPath, isCurrentRoot);
    this.scheduleDeliveryLoads(projects, selectedProjectPath, resolveRepo, scoped, globalDataPath, isCurrentRoot);
    this.scheduleSecurityLoads(projects, selectedProjectPath, resolveRepo, scoped, globalDataPath, isCurrentRoot);
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
    const repo = await resolveGithubRepoSlug(projectPath);
    if (repo === null || globalDataPath !== this.options.getGlobalDataPath()) {
      return { issues: null, pullRequests: null, delivery: null, security: null };
    }
    if (this.options.isAvailable()) {
      this.options.postMessage({ command: 'projectRepositoryResolved', projectPath, repo });
    }
    const options = { force: true, globalDataPath, resolvedRepo: repo };
    const loadSignal = async (load: () => Promise<any>, label: string) => {
      try {
        return await this.withSignalSlot(load, true);
      } catch (error) {
        console.error(`SoloMap sidebar failed to refresh ${label}:`, error);
        return null;
      }
    };
    const [issues, pullRequests, delivery, security] = await Promise.all([
      loadSignal(() => loadExternalIssueSummary(projectPath, options), 'issue summary'),
      loadSignal(() => loadExternalPullRequestSummary(projectPath, options), 'pull request summary'),
      loadSignal(() => loadExternalDeliverySummary(projectPath, options), 'delivery summary'),
      loadSignal(() => loadExternalSecuritySummary(projectPath, options), 'security summary')
    ]);
    return { issues, pullRequests, delivery, security };
  }

  public async refreshProjectSignal(
    projectPath: string,
    kind: 'issues' | 'pullRequests' | 'delivery' | 'security',
    globalDataPath = this.options.getGlobalDataPath()
  ): Promise<any> {
    if (globalDataPath !== this.options.getGlobalDataPath()) return null;
    const repo = await resolveGithubRepoSlug(projectPath);
    if (repo === null || globalDataPath !== this.options.getGlobalDataPath()) return null;
    if (this.options.isAvailable()) {
      this.options.postMessage({ command: 'projectRepositoryResolved', projectPath, repo });
    }
    const options = { force: true, globalDataPath, resolvedRepo: repo };
    const loaders: Record<'issues' | 'pullRequests' | 'delivery' | 'security', () => Promise<any>> = {
      issues: () => loadExternalIssueSummary(projectPath, options),
      pullRequests: () => loadExternalPullRequestSummary(projectPath, options),
      delivery: () => loadExternalDeliverySummary(projectPath, options),
      security: () => loadExternalSecuritySummary(projectPath, options)
    };
    try {
      return await this.withSignalSlot(loaders[kind], true);
    } catch (error) {
      console.error(`SoloMap sidebar failed to refresh ${kind}:`, error);
      return null;
    }
  }

  private publishSelectedCachedSignals(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    resolveRepo: (project: SolopreneurProject) => Promise<string | null>,
    globalDataPath: string,
    isCurrentRoot: () => boolean
  ): void {
    const selected = projects.find(project => project.path === selectedProjectPath) || projects[0];
    if (!selected) return;
    const requestId = ++this.cachedSignalRequest;
    void resolveRepo(selected).then(repo => repo === null || !isCurrentRoot() ? null : readCachedExternalSignals(selected.path, globalDataPath, repo)).then((cached) => {
      if (!cached || !isCurrentRoot() || !this.options.isAvailable() || requestId !== this.cachedSignalRequest) return;
      if (cached.issues) this.options.postMessage({ command: 'projectIssuesLoaded', projectPath: selected.path, issues: cached.issues });
      if (cached.pullRequests) this.options.postMessage({ command: 'projectPullRequestsLoaded', projectPath: selected.path, pullRequests: cached.pullRequests });
      if (cached.delivery) this.options.postMessage({ command: 'projectDeliveryLoaded', projectPath: selected.path, delivery: cached.delivery });
      if (cached.security) this.options.postMessage({ command: 'projectSecurityLoaded', projectPath: selected.path, security: cached.security });
    }).catch(error => console.error('SoloMap sidebar failed to read cached external signals:', error));
  }

  public schedulePortfolioEnrichment(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    basePortfolio: ProjectPortfolioSummary[] = [],
    projectPaths: string[] = []
  ): void {
    const scoped = projectPaths.length > 0;
    const requestId = scoped ? this.portfolioRequest : ++this.portfolioRequest;
    if (!scoped) this.latestEnrichedPortfolio.clear();
    const requestedPaths = new Set(projectPaths.filter(Boolean));
    const ordered = this.orderedProjects(projects, selectedProjectPath)
      .filter((project) => requestedPaths.size === 0 || requestedPaths.has(project.path));
    const projectRequests = new Map(ordered.map(project => {
      const next = (this.portfolioProjectRequests.get(project.path) || 0) + 1;
      this.portfolioProjectRequests.set(project.path, next);
      return [project.path, next] as const;
    }));
    setTimeout(() => {
      void (async () => {
        try {
          const globalDataPath = this.options.getGlobalDataPath();
          const learningOverview = await readLearningOverview(ordered[0]?.path || process.cwd(), globalDataPath);
          const summaries = new Map<string, ProjectPortfolioSummary>(basePortfolio.map((summary) => [summary.path, summary]));
          for (const project of ordered) {
            if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
            if (projectRequests.get(project.path) !== this.portfolioProjectRequests.get(project.path)) {
              continue;
            }
            try {
              const [investment, sourceCount, documentationManifest, analysisSource] = await Promise.all([
                readProjectInvestmentStatsFromDatabase(project.path, this.options.getExtensionPath(), new Date(), globalDataPath),
                sendRuntimeDataRequest<number>(normalizeGlobalDataPathForExtension(globalDataPath, project.path), { operation: 'read_project_reusable_source_count', input: { root: project.path } }),
                sendRuntimeDataRequest<DocumentationManifest>(normalizeGlobalDataPathForExtension(globalDataPath, project.path), { operation: 'read_documentation_manifest', input: { root: project.path } }),
                sendRuntimeDataRequest<{ recentActivityAt: string }>(normalizeGlobalDataPathForExtension(globalDataPath, project.path), { operation: 'read_project_analysis_source', input: { root: project.path } })
              ]);
              if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
              if (projectRequests.get(project.path) !== this.portfolioProjectRequests.get(project.path)) {
                continue;
              }
              summaries.set(project.path, buildProjectPortfolioSummary(project, {
                includeReusableSignals: true,
                globalDataPath,
                learningOverview,
                documentationManifestsByProjectPath: new Map([[project.path, documentationManifest]]),
                reusableSourceCountsByProjectPath: new Map([[project.path, sourceCount]]),
                investmentStatsByProjectPath: { [project.path]: investment },
                recentActivityAtByProjectPath: new Map([[project.path, analysisSource.recentActivityAt]]),
                externalSignalsByProjectPath: summaries.get(project.path) ? new Map([[project.path, summaries.get(project.path)!]]) : undefined
              }));
              this.latestEnrichedPortfolio.set(project.path, summaries.get(project.path)!);
              const portfolio = projects.map((item) => summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[];
              this.options.postMessage({
                command: 'projectsLoaded',
                projects: {
                  projects,
                  selectedProjectPath,
                  portfolio,
                  updatedProjectPaths: [project.path]
                }
              });
            } catch (error) {
              console.error(`SoloMap sidebar failed to enrich project ${project.path}:`, error);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
          const portfolio = projects.map((item) => this.latestEnrichedPortfolio.get(item.path) || summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[];
          let globalStore: any;
          try {
            globalStore = this.options.buildGlobalStore(globalDataPath, portfolio);
          } catch {
            globalStore = this.options.buildGlobalStorePlaceholder(globalDataPath, portfolio);
          }
          this.options.postMessage({
            command: 'projectsLoaded',
            projects: {
              projects,
              selectedProjectPath,
              portfolio,
              globalStore,
              updatedProjectPaths: []
            }
          });
        } catch (error) {
          console.error('SoloMap sidebar failed to enrich portfolio:', error);
        }
      })();
    }, 1000);
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
    resolveRepo: (project: SolopreneurProject) => Promise<string | null> = project => resolveGithubRepoSlug(project.path),
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.issueRequest : ++this.issueRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('issues', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1200, 80,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.issueRequest && projectRequests.get(project.path) === this.signalRequest('issues', project.path),
      async project => {
        const repo = await resolveRepo(project);
        return repo === null ? undefined : loadExternalIssueSummary(project.path, { globalDataPath, resolvedRepo: repo });
      },
      (project, issues) => this.options.postMessage({ command: 'projectIssuesLoaded', projectPath: project.path, issues }),
      'SoloMap sidebar failed to refresh issue summary:');
  }

  private schedulePullRequestLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    resolveRepo: (project: SolopreneurProject) => Promise<string | null> = project => resolveGithubRepoSlug(project.path),
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.pullRequestRequest : ++this.pullRequestRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('pullRequests', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1300, 100,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.pullRequestRequest && projectRequests.get(project.path) === this.signalRequest('pullRequests', project.path),
      async project => {
        const repo = await resolveRepo(project);
        return repo === null ? undefined : loadExternalPullRequestSummary(project.path, { globalDataPath, resolvedRepo: repo });
      },
      (project, pullRequests) => this.options.postMessage({ command: 'projectPullRequestsLoaded', projectPath: project.path, pullRequests }),
      'SoloMap sidebar failed to refresh pull request summary:');
  }

  private scheduleDeliveryLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    resolveRepo: (project: SolopreneurProject) => Promise<string | null> = project => resolveGithubRepoSlug(project.path),
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.deliveryRequest : ++this.deliveryRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('delivery', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1400, 120,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.deliveryRequest && projectRequests.get(project.path) === this.signalRequest('delivery', project.path),
      async project => {
        const repo = await resolveRepo(project);
        return repo === null ? undefined : loadExternalDeliverySummary(project.path, { globalDataPath, resolvedRepo: repo });
      },
      (project, delivery) => this.options.postMessage({ command: 'projectDeliveryLoaded', projectPath: project.path, delivery }),
      'SoloMap sidebar failed to refresh delivery summary:');
  }

  private scheduleSecurityLoads(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    resolveRepo: (project: SolopreneurProject) => Promise<string | null> = project => resolveGithubRepoSlug(project.path),
    scoped = false,
    globalDataPath = this.options.getGlobalDataPath(),
    isCurrentRoot: () => boolean = () => globalDataPath === this.options.getGlobalDataPath()
  ): void {
    const requestId = scoped ? this.securityRequest : ++this.securityRequest;
    const projectRequests = new Map(projects.map(project => [project.path, this.signalRequest('security', project.path)]));
    this.scheduleSignalQueue(projects, selectedProjectPath, 1600, 140,
      project => isCurrentRoot() && this.options.isAvailable() && requestId === this.securityRequest && projectRequests.get(project.path) === this.signalRequest('security', project.path),
      async project => {
        const repo = await resolveRepo(project);
        return repo === null ? undefined : loadExternalSecuritySummary(project.path, { globalDataPath, resolvedRepo: repo });
      },
      (project, security) => this.options.postMessage({ command: 'projectSecurityLoaded', projectPath: project.path, security }),
      'SoloMap sidebar failed to refresh security summary:');
  }
}
