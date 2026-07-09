import {
  loadExternalDeliverySummary,
  loadExternalIssueSummary,
  loadExternalPullRequestSummary,
  loadExternalSecuritySummary
} from './projectExternalSignals';
import { buildProjectPortfolioSummariesFromDatabase, ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';

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

  public scheduleAll(projects: SolopreneurProject[], selectedProjectPath: string): void {
    this.schedulePortfolioEnrichment(projects, selectedProjectPath);
    this.scheduleIssueLoads(projects, selectedProjectPath);
    this.schedulePullRequestLoads(projects, selectedProjectPath);
    this.scheduleDeliveryLoads(projects, selectedProjectPath);
    this.scheduleSecurityLoads(projects, selectedProjectPath);
  }

  public schedulePortfolioEnrichment(projects: SolopreneurProject[], selectedProjectPath: string): void {
    const requestId = ++this.portfolioRequest;
    setTimeout(() => {
      void (async () => {
      try {
        if (!this.options.isAvailable() || requestId !== this.portfolioRequest) return;
        const globalDataPath = this.options.getGlobalDataPath();
        const portfolio = await buildProjectPortfolioSummariesFromDatabase(projects, this.options.getExtensionPath(), {
          includeReusableSignals: true,
          globalDataPath
        });
        let globalStore: any;
        try {
          globalStore = this.options.buildGlobalStore(globalDataPath, portfolio);
        } catch {
          globalStore = this.options.buildGlobalStorePlaceholder(globalDataPath, portfolio);
        }
        this.options.postMessage({
          command: 'projectsLoaded',
          projects: { projects, selectedProjectPath, portfolio, globalStore }
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
