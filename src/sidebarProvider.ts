import * as vscode from 'vscode';
import { SyncEngine } from './db/syncEngine';
import { AgentConversation } from './db/types';
import { SolopreneurSettings } from './pluginContracts';
import { getSidebarFallbackHtml, getSidebarWebviewHtml } from './sidebarWebview';
import { recordLocalDiagnosticError } from './localDiagnostics';

function getDiagnosticDataPath(getSettings: () => SolopreneurSettings): string {
  try {
    return getSettings().globalDataPath;
  } catch {
    return '';
  }
}
import { SidebarProjectLoader } from './sidebarProjectLoader';
import { createGlobalEngineeringSnapshotPlaceholder, ensureGlobalEngineeringStore } from './globalEngineeringStore';
import { readTodayReview, startDailyReviewAgent } from './dailyReview';
import {
  buildAgentAutomationWrapper,
  buildAgentInstallCommand,
  getDependencyStatus,
  getSupportedAgentStatuses
} from './sidebarDependencies';
import {
  buildProjectPortfolioSummary,
  ProjectPortfolioSummary,
  SolopreneurProject
} from './projectPortfolio';
import {
  buildSidebarProjectSignature,
  readCachedConversationSnapshot,
  readSidebarCoreSnapshot,
  writeCachedConversationSnapshot,
  writeSidebarPortfolioSnapshot
} from './sidebarSnapshotCache';
import {
  resolveAgentCli,
  shellQuote
} from './agentCli';

interface SidebarProviderDependencies {
  getSettings: () => SolopreneurSettings;
  updateSettings: (settings: SolopreneurSettings) => Promise<void>;
  getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string };
  getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  getStepConversationHistory?: (projectPath: string, nodeId: string) => Promise<AgentConversation[]>;
  getProjectConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  getProjectConversationSnapshot?: (projectPath: string) => Promise<{ solo: AgentConversation[]; project: AgentConversation[] }>;
  dispatchSharedAction?: (message: any, target: vscode.Webview) => Promise<boolean>;
}

export class SolopreneurSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'solopreneur.sidebar';
  private _view?: vscode.WebviewView;
  private readonly _projectLoader: SidebarProjectLoader;
  private readonly _getSettings: () => SolopreneurSettings;
  private readonly _updateSettings: (settings: SolopreneurSettings) => Promise<void>;
  private readonly _getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string };
  private readonly _getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  private readonly _getStepConversationHistory?: (projectPath: string, nodeId: string) => Promise<AgentConversation[]>;
  private readonly _getProjectConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  private readonly _getProjectConversationSnapshot?: (projectPath: string) => Promise<{ solo: AgentConversation[]; project: AgentConversation[] }>;
  private readonly _dispatchSharedAction?: (message: any, target: vscode.Webview) => Promise<boolean>;
  private readonly _conversationSnapshotLoads = new Map<string, Promise<{ solo: AgentConversation[]; project: AgentConversation[] }>>();
  private _corePortfolioRequest = 0;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _syncEngine: SyncEngine,
    dependenciesOrLegacyRunAgent: SidebarProviderDependencies | ((...args: any[]) => Promise<void>),
    ...legacyDependencies: any[]
  ) {
    const dependencies: SidebarProviderDependencies = typeof dependenciesOrLegacyRunAgent === 'object'
      ? dependenciesOrLegacyRunAgent
      : {
        getSettings: legacyDependencies[0],
        updateSettings: legacyDependencies[1],
        getProjects: legacyDependencies[2],
        getSoloConversationHistory: legacyDependencies[9],
        getStepConversationHistory: legacyDependencies[12],
        getProjectConversationHistory: legacyDependencies[13],
        dispatchSharedAction: legacyDependencies[29]
      };
    this._getSettings = dependencies.getSettings;
    this._updateSettings = dependencies.updateSettings;
    this._getProjects = dependencies.getProjects;
    this._getSoloConversationHistory = dependencies.getSoloConversationHistory;
    this._getStepConversationHistory = dependencies.getStepConversationHistory;
    this._getProjectConversationHistory = dependencies.getProjectConversationHistory;
    this._getProjectConversationSnapshot = dependencies.getProjectConversationSnapshot;
    this._dispatchSharedAction = dependencies.dispatchSharedAction;
    this._projectLoader = new SidebarProjectLoader({
      isAvailable: () => Boolean(this._view),
      postMessage: (message) => { this._view?.webview.postMessage(message); },
      getGlobalDataPath: () => this._getSettings().globalDataPath,
      getExtensionPath: () => this._extensionUri.fsPath,
      buildGlobalStore: ensureGlobalEngineeringStore,
      buildGlobalStorePlaceholder: createGlobalEngineeringSnapshotPlaceholder
    });
  }

  public postMessage(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    try {
      // Allow scripts and configure local resource roots
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri]
      };

      webviewView.webview.html = getSidebarWebviewHtml(webviewView.webview, this._extensionUri);
    } catch (error) {
      recordLocalDiagnosticError(getDiagnosticDataPath(this._getSettings), 'sidebar.render', error);
      console.error('SoloMap sidebar failed to render initial HTML:', error);
      webviewView.webview.html = getSidebarFallbackHtml('SoloMap sidebar could not render. Open the command palette and run "Developer: Reload Window".');
    }

    // Listen to messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      try {
        if (this._dispatchSharedAction && await this._dispatchSharedAction(data, webviewView.webview)) {
          return;
        }
        switch (data.command) {
          case 'getNodes':
            this.sendNodesToWebview();
            break;
          case 'showStrategyPyramid':
            await vscode.commands.executeCommand('solopreneur.showStrategyPyramid');
            break;
          case 'showFullRoadmap':
            await vscode.commands.executeCommand('solopreneur.showRoadmap');
            break;
          case 'showFlowView':
            await vscode.commands.executeCommand('solopreneur.showFlow');
            break;
          case 'checkDependencies':
            this._view?.webview.postMessage({
              command: 'dependenciesChecked',
              status: getDependencyStatus(data.cliPath || this._getSettings().cliPath || 'agy')
            });
            break;
          case 'agent.setDefault': {
            const settings = this._getSettings();
            const cliPath = String(data.cliPath || '').trim();
            if (!cliPath) {
              vscode.window.showErrorMessage('Agent CLI path is missing.');
              break;
            }
            await this._updateSettings({
              ...settings,
              cliPath
            });
            this.sendSettings();
            this._view?.webview.postMessage({
              command: 'dependenciesChecked',
              status: getDependencyStatus(cliPath)
            });
            vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            vscode.window.showInformationMessage(`Default Agent set to ${cliPath}.`);
            break;
          }
          case 'prepareAgentAutomation': {
            const settings = this._getSettings();
            const projectState = this._getProjects();
            const prepared = buildAgentAutomationWrapper(data.cliPath || settings.cliPath || 'agy', settings.globalDataPath, projectState.projects || []);
            if (prepared.ok && prepared.wrapperPath) {
              await this._updateSettings({
                ...settings,
                cliPath: prepared.wrapperPath,
                taskPermissionMode: 'auto'
              });
              this.sendSettings();
              vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            }
            this._view?.webview.postMessage({
              command: 'dependenciesChecked',
              status: getDependencyStatus(prepared.wrapperPath || data.cliPath || settings.cliPath || 'agy')
            });
            if (prepared.ok) {
              vscode.window.showInformationMessage(prepared.message);
            } else {
              vscode.window.showErrorMessage(prepared.message);
            }
            break;
          }
          case 'getDailyReview':
            this.sendDailyReview();
            break;
          case 'runDailyReview': {
            const review = startDailyReviewAgent(this._getSettings(), this._getProjects().projects, this._extensionUri);
            this._view?.webview.postMessage({ command: 'dailyReviewLoaded', review });
            break;
          }
          case 'openDependencyAction':
            this.openDependencyAction(data.action || '', data.cliPath || this._getSettings().cliPath || 'agy');
            break;
        }
      } catch (error) {
        recordLocalDiagnosticError(getDiagnosticDataPath(this._getSettings), `sidebar.action.${String(data?.command || 'unknown')}`, error);
        console.error('SoloMap sidebar message failed:', data?.command, error);
        this._view?.webview.postMessage({
          command: 'sidebarActionFailed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // The Webview owns the single cold-start request. Pushing the same payload
    // here as well causes duplicate settings, portfolio and SQLite loads.
  }

  /**
   * Refreshes the sidebar view with updated node states.
   */
  public sendNodesToWebview() {
    try {
      if (!this._view || !this._syncEngine) {
        return;
      }
      const nodes = this._syncEngine.getNodes();
      this._view.webview.postMessage({
        command: 'nodesUpdated',
        nodes: nodes,
        projectPath: this._getProjects().selectedProjectPath
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send nodes:', error);
    }
  }

  /**
   * Reads and pushes active configuration settings to the sidebar.
   */
  public sendSettings() {
    try {
      if (!this._view) {
        return;
      }
      this._view.webview.postMessage({
        command: 'settingsLoaded',
        settings: this._getSettings(),
        supportedAgents: getSupportedAgentStatuses(this._getSettings().cliPath || 'agy')
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send settings:', error);
    }
  }

  public postSkillInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'skillInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public postMcpInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'mcpInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public postEnhancementInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'enhancementInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public postAgentCliUpgradeResult(success: boolean, message: string, pending = false) {
    this._view?.webview.postMessage({ command: 'agentCliUpgradeResult', success, message, pending });
  }

  public sendProjects() {
    try {
      if (!this._view) {
        return;
      }
      const projectState = this._getProjects();
      const globalDataPath = this._getSettings().globalDataPath;
      const projectSignature = buildSidebarProjectSignature(projectState.projects);
      const cached = readSidebarCoreSnapshot(globalDataPath);
      if (cached?.projectSignature === projectSignature) {
        this.postCorePortfolio(projectState.projects, projectState.selectedProjectPath, cached.portfolio, globalDataPath);
        this._projectLoader.scheduleAll(projectState.projects, projectState.selectedProjectPath, cached.portfolio);
      } else {
        this.scheduleCorePortfolio(projectState.projects, projectState.selectedProjectPath, globalDataPath, []);
      }
      void this.sendProjectConversationSnapshot(projectState.selectedProjectPath);
      this.sendDailyReview();
    } catch (error) {
      console.error('SoloMap sidebar failed to send projects:', error);
      this._view?.webview.postMessage({
        command: 'projectsLoaded',
        projects: {
          projects: [],
          selectedProjectPath: '',
          portfolio: [],
          globalStore: {
            dataPath: '',
            portfolio: [],
            dependencies: [],
            learningCandidateCount: 0
          }
        }
      });
    }
  }

  public sendLocalProjects() {
    try {
      if (!this._view) {
        return;
      }
      this._projectLoader.cancelExternalLoads();
      const projectState = this._getProjects();
      this.scheduleCorePortfolio(
        projectState.projects,
        projectState.selectedProjectPath,
        this._getSettings().globalDataPath,
        []
      );
    } catch (error) {
      console.error('SoloMap sidebar failed to send local projects:', error);
    }
  }

  private postCorePortfolio(projects: SolopreneurProject[], selectedProjectPath: string, portfolio: ProjectPortfolioSummary[], globalDataPath: string): void {
    const globalStore = createGlobalEngineeringSnapshotPlaceholder(globalDataPath, portfolio);
    this._view?.webview.postMessage({
      command: 'projectsLoaded',
      projects: { projects, selectedProjectPath, portfolio, globalStore }
    });
  }

  private scheduleCorePortfolio(projects: SolopreneurProject[], selectedProjectPath: string, globalDataPath: string, stalePortfolio: ProjectPortfolioSummary[]): void {
    const requestId = ++this._corePortfolioRequest;
    const ordered = [
      ...projects.filter((project) => project.path === selectedProjectPath),
      ...projects.filter((project) => project.path !== selectedProjectPath)
    ];
    const summaries = new Map(stalePortfolio.map((summary) => [summary.path, summary]));
    const loadNext = (index: number) => {
      if (!this._view || requestId !== this._corePortfolioRequest) return;
      if (index >= ordered.length) {
        const portfolio = projects.map((project) => summaries.get(project.path)).filter(Boolean) as ProjectPortfolioSummary[];
        writeSidebarPortfolioSnapshot(globalDataPath, buildSidebarProjectSignature(projects), portfolio);
        this._projectLoader.scheduleAll(projects, selectedProjectPath, portfolio);
        return;
      }
      const project = ordered[index];
      summaries.set(project.path, buildProjectPortfolioSummary(project, { coreOnly: true }));
      const portfolio = projects.map((item) => summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[];
      this.postCorePortfolio(projects, selectedProjectPath, portfolio, globalDataPath);
      setTimeout(() => loadNext(index + 1), 0);
    };
    setTimeout(() => loadNext(0), 0);
  }

  public async sendSoloConversationHistory(projectPath: string) {
    try {
      if (!this._view || !this._getSoloConversationHistory || !projectPath) {
        return;
      }
      const conversations = await this._getSoloConversationHistory(projectPath);
      this._view.webview.postMessage({
        command: 'sidebarSoloConversationLoaded',
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send solo conversation history:', error);
    }
  }

  public async sendStepConversationHistory(projectPath: string, nodeId: string) {
    try {
      if (!this._view || !this._getStepConversationHistory || !projectPath || !nodeId) {
        return;
      }
      const conversations = await this._getStepConversationHistory(projectPath, nodeId);
      this._view.webview.postMessage({
        command: 'sidebarStepConversationLoaded',
        projectPath,
        nodeId,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send step conversation history:', error);
    }
  }

  public async sendProjectConversationHistory(projectPath: string) {
    try {
      if (!this._view || !this._getProjectConversationHistory || !projectPath) {
        return;
      }
      const conversations = await this._getProjectConversationHistory(projectPath);
      this._view.webview.postMessage({
        command: 'sidebarProjectConversationLoaded',
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send project conversation history:', error);
    }
  }

  public async sendProjectConversationSnapshot(projectPath: string) {
    try {
      if (!this._view || !this._getProjectConversationSnapshot || !projectPath) return;
      const globalDataPath = this._getSettings().globalDataPath;
      const cached = readCachedConversationSnapshot(globalDataPath, projectPath);
      if (cached) {
        this.postProjectConversationSnapshot(projectPath, cached);
        return;
      }
      let snapshotLoad = this._conversationSnapshotLoads.get(projectPath);
      if (!snapshotLoad) {
        snapshotLoad = this._getProjectConversationSnapshot(projectPath);
        this._conversationSnapshotLoads.set(projectPath, snapshotLoad);
      }
      const snapshot = await snapshotLoad;
      writeCachedConversationSnapshot(globalDataPath, projectPath, snapshot);
      this.postProjectConversationSnapshot(projectPath, snapshot);
    } catch (error) {
      console.error('SoloMap sidebar failed to send project conversation snapshot:', error);
    } finally {
      this._conversationSnapshotLoads.delete(projectPath);
    }
  }

  private postProjectConversationSnapshot(projectPath: string, snapshot: { solo: AgentConversation[]; project: AgentConversation[] }): void {
    this._view?.webview.postMessage({
      command: 'sidebarProjectConversationSnapshotLoaded',
      projectPath,
      soloConversations: snapshot.solo,
      projectConversations: snapshot.project
    });
  }

  public sendDailyReview() {
    try {
      if (!this._view) {
        return;
      }
      const projectState = this._getProjects();
      this._view.webview.postMessage({
        command: 'dailyReviewLoaded',
        review: readTodayReview(this._getSettings().globalDataPath, projectState.projects)
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send daily review:', error);
    }
  }

  private openDependencyAction(action: string, cliPath: string) {
    const terminal = vscode.window.createTerminal({
      name: 'Setup',
      iconPath: vscode.Uri.joinPath(this._extensionUri, 'resources', 'logo.svg'),
    });
    terminal.show(true);
    if (action === 'github-auth') {
      terminal.sendText('gh auth login');
      return;
    }
    if (action === 'github-install') {
      terminal.sendText('gh --version || echo "Install GitHub CLI from https://cli.github.com/"');
      return;
    }
    if (action === 'agent-install') {
      terminal.sendText(buildAgentInstallCommand(cliPath || 'agy'));
      return;
    }
    if (action === 'agent-check') {
      const command = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
      terminal.sendText(`${shellQuote(command)} --version`);
    }
  }


}
