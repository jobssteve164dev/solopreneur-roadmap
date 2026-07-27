import {
  loadExternalDeliverySummary,
  loadExternalIssueSummary,
  loadExternalPullRequestSummary,
  loadExternalSecuritySummary
} from './projectExternalSignals';
import { buildProjectPortfolioSummary, ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';
import { readProjectInvestmentStatsFromDatabase } from './projectAnalytics';

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

  constructor(private readonly options: SidebarProjectLoaderOptions) {}

  public cancelExternalLoads(): void {
    this.portfolioRequest += 1;
    this.issueRequest += 1;
    this.pullRequestRequest += 1;
    this.deliveryRequest += 1;
    this.securityRequest += 1;
  }

  public scheduleAll(projects: SolopreneurProject[], selectedProjectPath: string, basePortfolio: ProjectPortfolioSummary[] = []): void {
    this.schedulePortfolioEnrichment(projects, selectedProjectPath, basePortfolio);
    this.scheduleIssueLoads(projects, selectedProjectPath);
    this.schedulePullRequestLoads(projects, selectedProjectPath);
    this.scheduleDeliveryLoads(projects, selectedProjectPath);
    this.scheduleSecurityLoads(projects, selectedProjectPath);
  }

  public schedulePortfolioEnrichment(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    basePortfolio: ProjectPortfolioSummary[] = [],
    projectPaths: string[] = []
  ): void {
    const requestId = ++this.portfolioRequest;
    setTimeout(() => {
      void (async () => {
        try {
          const globalDataPath = this.options.getGlobalDataPath();
          const summaries = new Map<string, ProjectPortfolioSummary>(basePortfolio.map((summary) => [summary.path, summary]));
          const requestedPaths = new Set(projectPaths.filter(Boolean));
          const ordered = this.orderedProjects(projects, selectedProjectPath)
            .filter((project) => requestedPaths.size === 0 || requestedPaths.has(project.path));
          for (const project of ordered) {
            if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
            const investment = await readProjectInvestmentStatsFromDatabase(project.path, this.options.getExtensionPath());
            if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
            summaries.set(project.path, buildProjectPortfolioSummary(project, {
              includeReusableSignals: true,
              globalDataPath,
              investmentStatsByProjectPath: { [project.path]: investment }
            }));
            const portfolio = projects.map((item) => summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[];
            this.options.postMessage({
              command: 'projectsLoaded',
              projects: {
                projects,
                selectedProjectPath,
                portfolio,
                globalStore: this.options.buildGlobalStorePlaceholder(globalDataPath, portfolio),
                updatedProjectPaths: [project.path]
              }
            });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
          const portfolio = projects.map((item) => summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[];
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

  private scheduleIssueLoads(projects: SolopreneurProject[], selectedProjectPath: string): void {
    const requestId = ++this.issueRequest;
    this.orderedProjects(projects, selectedProjectPath).forEach((project, index) => {
      setTimeout(() => {
        if (!this.options.isAvailable() || requestId !== this.issueRequest) return;
        void loadExternalIssueSummary(project.path).then((issues) => {
          if (!this.options.isAvailable() || requestId !== this.issueRequest) return;
          this.options.postMessage({ command: 'projectIssuesLoaded', projectPath: project.path, issues });
        }).catch((error) => console.error('SoloMap sidebar failed to refresh issue summary:', error));
      }, 1200 + 80 * index);
    });
  }

  private schedulePullRequestLoads(projects: SolopreneurProject[], selectedProjectPath: string): void {
    const requestId = ++this.pullRequestRequest;
    this.orderedProjects(projects, selectedProjectPath).forEach((project, index) => {
      setTimeout(() => {
        if (!this.options.isAvailable() || requestId !== this.pullRequestRequest) return;
        void loadExternalPullRequestSummary(project.path).then((pullRequests) => {
          if (!this.options.isAvailable() || requestId !== this.pullRequestRequest) return;
          this.options.postMessage({ command: 'projectPullRequestsLoaded', projectPath: project.path, pullRequests });
        }).catch((error) => console.error('SoloMap sidebar failed to refresh pull request summary:', error));
      }, 1300 + 100 * index);
    });
  }

  private scheduleDeliveryLoads(projects: SolopreneurProject[], selectedProjectPath: string): void {
    const requestId = ++this.deliveryRequest;
    this.orderedProjects(projects, selectedProjectPath).forEach((project, index) => {
      setTimeout(() => {
        if (!this.options.isAvailable() || requestId !== this.deliveryRequest) return;
        void loadExternalDeliverySummary(project.path).then((delivery) => {
          if (!this.options.isAvailable() || requestId !== this.deliveryRequest) return;
          this.options.postMessage({ command: 'projectDeliveryLoaded', projectPath: project.path, delivery });
        }).catch((error) => console.error('SoloMap sidebar failed to refresh delivery summary:', error));
      }, 1400 + 120 * index);
    });
  }

  private scheduleSecurityLoads(projects: SolopreneurProject[], selectedProjectPath: string): void {
    const requestId = ++this.securityRequest;
    this.orderedProjects(projects, selectedProjectPath).forEach((project, index) => {
      setTimeout(() => {
        if (!this.options.isAvailable() || requestId !== this.securityRequest) return;
        void loadExternalSecuritySummary(project.path).then((security) => {
          if (!this.options.isAvailable() || requestId !== this.securityRequest) return;
          this.options.postMessage({ command: 'projectSecurityLoaded', projectPath: project.path, security });
        }).catch((error) => console.error('SoloMap sidebar failed to refresh security summary:', error));
      }, 1600 + 140 * index);
    });
  }
}
