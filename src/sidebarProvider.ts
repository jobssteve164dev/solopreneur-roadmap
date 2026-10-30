import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { desktopSessionEnvironment } from './desktopSessionEnvironment';
import { disposeAutomationSoundView } from './automationSound.js';
import { SyncEngine } from './db/syncEngine';
import { AgentConversation } from './db/types';
import { SolopreneurSettings } from './pluginContracts';
import { getSidebarFallbackHtml, getSidebarWebviewHtml } from './sidebarWebview';
import { createLocalDiagnosticTrace, LocalDiagnosticTrace, observeLocalDiagnosticStage, recordLocalDiagnosticError, withLocalDiagnosticTrace } from './localDiagnostics';

async function runTracedSidebarAction(trace: LocalDiagnosticTrace, stage: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    trace.record(stage, 'ok');
    return true;
  } catch (error) {
    trace.record(stage, 'error', 0, error);
    return false;
  }
}

function getDiagnosticDataPath(getSettings: () => SolopreneurSettings): string {
  try {
    return getSettings().globalDataPath;
  } catch {
    return '';
  }
}
import { SidebarProjectLoader } from './sidebarProjectLoader';
import { createGlobalEngineeringSnapshotPlaceholder, ensureGlobalEngineeringStore } from './globalEngineeringStore';
import { readTodayReviewFromDatabase, startDailyReviewAgent } from './dailyReview';
import {
  buildAgentAutomationWrapper,
  buildAgentInstallCommand,
  getDependencyStatus
} from './sidebarDependencies';
import {
  applyProjectRegistryToPortfolio,
  buildProjectPortfolioSummary,
  normalizeGlobalDataPath,
  ProjectPortfolioSummary,
  SolopreneurProject
} from './projectPortfolio';
import {
  buildSidebarProjectSignature,
  buildConversationDatabaseSignature,
  readSidebarCoreSnapshot,
  readCachedConversationSnapshot,
  reserveSidebarPortfolioSnapshot,
  commitSidebarPortfolioSnapshot,
  SidebarConversationSnapshot,
  writeCachedConversationSnapshot
} from './sidebarSnapshotCache';
import {
  resolveAgentCli,
  shellQuote
} from './agentCli';
import { ensureSolomapMaintenanceWorkspace } from './solomapGlobal';
import { sendTextWhenTerminalReady } from './terminalCompatibility';
import { recordShadowDecisionFeedback, refreshShadowRuntimeState } from './autonomousRuntime';
import { IntelligenceConversation, IntelligenceConversationStore } from './intelligenceChat';
import { readAgentAccountStatuses } from './agentAccountStatus';
import { postWebviewMessage } from './panelMessages';
import {
  createEmptyDeliverySummary,
  createEmptyIssueSummary,
  createEmptyPullRequestSummary,
  createEmptySecuritySummary
} from './projectExternalSignals';

interface SidebarProviderDependencies {
  getSettings: () => SolopreneurSettings;
  updateSettings: (settings: Partial<SolopreneurSettings>) => Promise<void>;
  getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string; projectGeneration?: number };
  getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  getStepConversationHistory?: (projectPath: string, nodeId: string) => Promise<AgentConversation[]>;
  getProjectConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  getProjectConversationSnapshot?: (projectPath: string) => Promise<SidebarConversationSnapshot>;
  dispatchSharedAction?: (message: any, target: vscode.Webview) => Promise<boolean>;
  onInitialDataReady?: () => void;
  listIntelligenceConversations?: () => ReturnType<IntelligenceConversationStore['list']>;
  getIntelligenceConversation?: (id: string) => ReturnType<IntelligenceConversationStore['get']>;
  sendIntelligenceMessage?: (text: string, id?: string) => Promise<IntelligenceConversation>;
  readAgentAccountStatuses?: typeof readAgentAccountStatuses;
}

export class SolopreneurSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'solopreneur.sidebar';
  private _view?: vscode.WebviewView;
  private readonly _projectLoader: SidebarProjectLoader;
  private readonly _getSettings: () => SolopreneurSettings;
  private readonly _updateSettings: (settings: Partial<SolopreneurSettings>) => Promise<void>;
  private readonly _getProjects: SidebarProviderDependencies['getProjects'];
  private _projectSelectionGeneration = 0;
  private readonly _getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  private readonly _getStepConversationHistory?: (projectPath: string, nodeId: string) => Promise<AgentConversation[]>;
  private readonly _getProjectConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>;
  private readonly _getProjectConversationSnapshot?: (projectPath: string) => Promise<SidebarConversationSnapshot>;
  private readonly _dispatchSharedAction?: (message: any, target: vscode.Webview) => Promise<boolean>;
  private readonly _onInitialDataReady?: () => void;
  private readonly _listIntelligenceConversations?: SidebarProviderDependencies['listIntelligenceConversations'];
  private readonly _getIntelligenceConversation?: SidebarProviderDependencies['getIntelligenceConversation'];
  private readonly _sendIntelligenceMessage?: SidebarProviderDependencies['sendIntelligenceMessage'];
  private readonly _readAgentAccountStatuses: typeof readAgentAccountStatuses;
  private _initialDataReady = false;
  private _startupTrace?: ReturnType<typeof createLocalDiagnosticTrace>;
  private _coreReady = false;
  private _startupSettingsSent = false;
  private readonly _navigationTraces = new Map<string, ReturnType<typeof createLocalDiagnosticTrace>>();
  private readonly _conversationSnapshotLoads = new Map<string, {
    promise: Promise<SidebarConversationSnapshot>;
    startedAt: number;
    sourceSignature: string;
  }>();
  private readonly _latestConversationSnapshotRequest = new Map<string, number>();
  private _latestPortfolio: ProjectPortfolioSummary[] = [];
  private readonly _latestProjectSignals = new Map<string, Partial<Pick<ProjectPortfolioSummary, 'issues' | 'pullRequests' | 'delivery' | 'security'>>>();
  private _projectLoadRequest = 0;
  private _corePortfolioRequest = 0;
  private _dailyReviewRequest = 0;
  private _conversationSnapshotRequest = 0;
  private _conversationHistoryRequest = 0;
  private readonly _latestConversationHistoryRequest = new Map<string, number>();
  private _activeDataRoot = '';
  private _dataRootGeneration = 0;
  private readonly _conversationLedgerRevisions = new Map<string, number>();
  private _localRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _refreshAllLocalProjects = false;
  private readonly _pendingLocalProjectPaths = new Set<string>();
  private _externalRefreshPending = false;
  private _agentAccountStatusRequest = 0;
  private _intelligenceListRequest = 0;
  private _intelligenceGetRequest = 0;
  private readonly _intelligenceConversationVersions = new Map<string, number>();

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
    this._onInitialDataReady = dependencies.onInitialDataReady;
    this._listIntelligenceConversations = dependencies.listIntelligenceConversations;
    this._getIntelligenceConversation = dependencies.getIntelligenceConversation;
    this._sendIntelligenceMessage = dependencies.sendIntelligenceMessage;
    this._readAgentAccountStatuses = dependencies.readAgentAccountStatuses || readAgentAccountStatuses;
    this._projectLoader = new SidebarProjectLoader({
      isAvailable: () => Boolean(this._view),
      postMessage: (message) => {
        const reconciled = this.reconcileProjectMessage(message);
        if (reconciled) void this.postMessage(reconciled);
      },
      getGlobalDataPath: () => this._getSettings().globalDataPath,
      getExtensionPath: () => this._extensionUri.fsPath,
      buildGlobalStore: ensureGlobalEngineeringStore,
      buildGlobalStorePlaceholder: createGlobalEngineeringSnapshotPlaceholder
    });
  }

  public reconcileProjectMessage(message: any, expectedDataRoot = ''): any {
    const projectPath = String(message?.projectPath || '');
    const signalField = message?.command === 'projectIssuesLoaded'
      ? 'issues'
      : message?.command === 'projectPullRequestsLoaded'
        ? 'pullRequests'
        : message?.command === 'projectDeliveryLoaded'
          ? 'delivery'
          : message?.command === 'projectSecurityLoaded'
            ? 'security'
            : '';
    const isPortfolioMessage = message?.command === 'projectsLoaded' && Array.isArray(message?.projects?.portfolio);
    if (expectedDataRoot && (projectPath || isPortfolioMessage)) {
      const projectState = this._getProjects();
      const currentDataRoot = normalizeGlobalDataPath(this._getSettings().globalDataPath, projectState.projects);
      if (expectedDataRoot !== this._activeDataRoot || expectedDataRoot !== currentDataRoot) {
        return null;
      }
    }
    if (projectPath && message?.command === 'projectRepositoryResolved') {
      const repo = String(message.repo || '');
      const emptySignals = {
        issues: createEmptyIssueSummary(),
        pullRequests: createEmptyPullRequestSummary(),
        delivery: createEmptyDeliverySummary(),
        security: createEmptySecuritySummary()
      };
      let changed = false;
      const currentSignals = this._latestProjectSignals.get(projectPath) || {};
      const nextSignals = { ...currentSignals };
      for (const field of ['issues', 'pullRequests', 'delivery', 'security'] as const) {
        const currentRepo = String(currentSignals[field]?.repo || this._latestPortfolio.find(project => project.path === projectPath)?.[field]?.repo || '');
        if (currentRepo && currentRepo !== repo) {
          (nextSignals as any)[field] = emptySignals[field];
          changed = true;
        }
      }
      if (!changed) return null;
      this._latestProjectSignals.set(projectPath, nextSignals);
      this._latestPortfolio = this.preserveCurrentExternalSignals(this._latestPortfolio.map(project => project.path === projectPath
        ? { ...project, ...nextSignals }
        : project));
      const projectState = this._getProjects();
      return {
        command: 'projectsLoaded',
        projects: {
          ...projectState,
          portfolio: this._latestPortfolio,
          globalStore: createGlobalEngineeringSnapshotPlaceholder(this._getSettings().globalDataPath, this._latestPortfolio),
          updatedProjectPaths: [projectPath]
        }
      };
    }
    if (projectPath && signalField && message[signalField]) {
      const currentProject = this._latestProjectSignals.get(projectPath)
        || this._latestPortfolio.find(project => project.path === projectPath);
      const currentSignal = currentProject?.[signalField];
      const incomingSignal = message[signalField];
      const currentSyncedAt = Date.parse(String(currentSignal?.syncedAt || ''));
      const incomingSyncedAt = Date.parse(String(incomingSignal?.syncedAt || ''));
      if ((currentSignal?.available && currentSignal.stale === false && incomingSignal.stale === true)
        || (Number.isFinite(currentSyncedAt) && Number.isFinite(incomingSyncedAt) && incomingSyncedAt < currentSyncedAt)) {
        return null;
      }
      this._latestProjectSignals.set(projectPath, {
        ...(this._latestProjectSignals.get(projectPath) || {}),
        [signalField]: message[signalField]
      });
      this._latestPortfolio = this._latestPortfolio.map(project => project.path === projectPath
        ? { ...project, [signalField]: message[signalField] }
        : project);
    } else if (isPortfolioMessage) {
      const portfolio = this.preserveCurrentExternalSignals(message.projects.portfolio);
      this._latestPortfolio = portfolio;
      message = {
        ...message,
        projects: { ...message.projects, selectedProjectPath: this._getProjects().selectedProjectPath,
          projectGeneration: this.currentProjectGeneration(), portfolio }
      };
    }
    return message;
  }

  private preserveCurrentExternalSignals(portfolio: ProjectPortfolioSummary[]): ProjectPortfolioSummary[] {
    const currentByPath = new Map(this._latestPortfolio.map(project => [project.path, project]));
    return portfolio.map(project => {
      const current = currentByPath.get(project.path);
      const latest = this._latestProjectSignals.get(project.path);
      return current || latest ? {
        ...project,
        issues: latest?.issues || current?.issues || project.issues,
        pullRequests: latest?.pullRequests || current?.pullRequests || project.pullRequests,
        delivery: latest?.delivery || current?.delivery || project.delivery,
        security: latest?.security || current?.security || project.security
      } : project;
    });
  }

  public postMessage(message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> {
    try {
      if (this._startupTrace && !this._coreReady && !this._startupSettingsSent && message.command === 'settingsLoaded') {
        this._startupSettingsSent = true;
        this._startupTrace.record('sidebar.settings.sent', 'ok');
      }
      return postWebviewMessage(this._view?.webview, message);
    } catch {
      return Promise.resolve(false);
    }
  }

  public hasWebview(): boolean {
    return Boolean(this._view);
  }

  public getWebview(): vscode.Webview | undefined {
    try { return this._view?.webview; }
    catch { return undefined; }
  }

  private beginDailyReviewRequest() {
    if (!this._view) return null;
    const view = this._view;
    const requestId = ++this._dailyReviewRequest;
    const projectState = this._getProjects();
    const globalDataPath = normalizeGlobalDataPath(this._getSettings().globalDataPath, projectState.projects);
    const projectSignature = buildSidebarProjectSignature(projectState.projects);
    return {
      projectState,
      globalDataPath,
      isCurrent: () => {
        if (!this._view || this._view !== view || requestId !== this._dailyReviewRequest) return false;
        const currentProjectState = this._getProjects();
        return normalizeGlobalDataPath(this._getSettings().globalDataPath, currentProjectState.projects) === globalDataPath
          && buildSidebarProjectSignature(currentProjectState.projects) === projectSignature;
      }
    };
  }

  private async refreshDependencyStatus(webviewView: vscode.WebviewView, cliPath: string): Promise<void> {
    const accountRequest = ++this._agentAccountStatusRequest;
    const dependencyStatus = await observeLocalDiagnosticStage('sidebar.dependencies', () => getDependencyStatus(cliPath));
    if (accountRequest !== this._agentAccountStatusRequest || this._view !== webviewView) return;
    void this.postMessage({ command: 'dependenciesChecked', status: dependencyStatus });
    const accountByFamily = new Map();
    const publish = () => {
      if (accountRequest !== this._agentAccountStatusRequest || this._view !== webviewView) return;
      void this.postMessage({
        command: 'dependenciesChecked',
        status: {
          ...dependencyStatus,
          supportedAgents: dependencyStatus.supportedAgents.map((agent) => ({
            ...agent,
            account: accountByFamily.get(agent.family)
          }))
        }
      });
    };
    void this._readAgentAccountStatuses(dependencyStatus.supportedAgents, {
      onStatus: (account) => {
        accountByFamily.set(account.family, account);
        publish();
      }
    }).then((accounts) => {
      for (const account of accounts) accountByFamily.set(account.family, account);
      publish();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._startupTrace = createLocalDiagnosticTrace(getDiagnosticDataPath(this._getSettings), 'sidebar.resolve', { targetId: 'sidebar', budgetMs: 15_000 });
    this._coreReady = false; this._startupSettingsSent = false;
    this._view = webviewView;
    const webview = webviewView.webview;
    webviewView.onDidDispose?.(() => {
      if (this._view === webviewView) this._view = undefined;
      disposeAutomationSoundView(webview);
    });
    webviewView.onDidChangeVisibility?.(() => {
      if (!webviewView.visible) disposeAutomationSoundView(webviewView.webview);
    });

    try {
      // Allow scripts and configure local resource roots
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri]
      };

      webviewView.webview.html = getSidebarWebviewHtml(webviewView.webview, this._extensionUri);
      this._startupTrace.record('sidebar.html.sent', 'ok');
    } catch (error) {
      recordLocalDiagnosticError(getDiagnosticDataPath(this._getSettings), 'sidebar.render', error);
      console.error('SoloMap sidebar failed to render initial HTML:', error);
      webviewView.webview.html = getSidebarFallbackHtml('SoloMap sidebar could not render. Open the command palette and run "Developer: Reload Window".');
    }

    const postIntelligenceList = async () => {
      const request = ++this._intelligenceListRequest;
      const conversations = await this._listIntelligenceConversations?.() || [];
      if (this._view !== webviewView || request !== this._intelligenceListRequest) return;
      void this.postMessage({ command: 'intelligenceConversationsLoaded', conversations });
    };
    // Listen to messages from the webview
    const handleMessage = async (data: any) => {
      try {
        if (this._dispatchSharedAction && await this._dispatchSharedAction(data, webviewView.webview)) {
          return;
        }
        switch (data.command) {
          case 'intelligence.list':
            await postIntelligenceList();
            break;
          case 'intelligence.get': {
            const id = String(data.conversationId || '');
            const request = ++this._intelligenceGetRequest;
            const version = this._intelligenceConversationVersions.get(id) || 0;
            try {
              const conversation = await this._getIntelligenceConversation?.(id) || null;
              if (this._view !== webviewView || request !== this._intelligenceGetRequest || version !== (this._intelligenceConversationVersions.get(id) || 0)) break;
              void this.postMessage({
                command: 'intelligenceConversationLoaded',
                conversation,
                conversationId: id
              });
            } catch (error) {
              void this.postMessage({ command: 'intelligenceLoadFailed', message: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case 'intelligence.send': {
            const requestId = String(data.requestId || '');
            try {
              if (!this._sendIntelligenceMessage) throw new Error('Intelligence chat is unavailable.');
              const conversation = await this._sendIntelligenceMessage(String(data.text || ''), String(data.conversationId || ''));
              if (this._view !== webviewView) break;
              this._intelligenceConversationVersions.set(conversation.id, (this._intelligenceConversationVersions.get(conversation.id) || 0) + 1);
              void this.postMessage({ command: 'intelligenceReplyLoaded', requestId, conversation });
              await postIntelligenceList();
            } catch (error) {
              if (this._view !== webviewView) break;
              void this.postMessage({ command: 'intelligenceReplyFailed', requestId, message: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case 'sidebarInitialDataReady':
            if (!this._initialDataReady) {
              this._initialDataReady = true;
              this._onInitialDataReady?.();
            }
            break;
          case 'sidebarCoreDataReady':
            if (!this._coreReady && data.traceId === this._startupTrace?.id && this._view === webviewView) {
              this._coreReady = true;
              this._startupTrace?.record('sidebar.browser.core.ready', 'ok');
            }
            break;
          case 'interactionCompleted': {
            const trace = this._navigationTraces.get(String(data.interactionId || ''));
            if (trace && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 && data.elapsedMs < 3_600_000) {
              trace.record('sidebar.navigation.browser.ready', 'ok', data.elapsedMs);
              this._navigationTraces.delete(String(data.interactionId));
            }
            break;
          }
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
          case 'checkDependencies': {
            await this.refreshDependencyStatus(webviewView, data.cliPath || this._getSettings().cliPath || 'agy');
            break;
          }
          case 'agent.setDefault': {
            const settings = this._getSettings();
            const cliPath = String(data.cliPath || '').trim();
            if (!cliPath) {
              vscode.window.showErrorMessage('Agent CLI path is missing.');
              break;
            }
            await this._updateSettings({ cliPath });
            await this.refreshDependencyStatus(webviewView, cliPath);
            vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            vscode.window.showInformationMessage(`Default Agent set to ${cliPath}.`);
            break;
          }
          case 'prepareAgentAutomation': {
            const settings = this._getSettings();
            const projectState = this._getProjects();
            const prepared = buildAgentAutomationWrapper(data.cliPath || settings.cliPath || 'agy', settings.globalDataPath, projectState.projects || []);
            if (prepared.ok && prepared.wrapperPath) {
              await this._updateSettings({ cliPath: prepared.wrapperPath });
              vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            }
            await this.refreshDependencyStatus(webviewView, prepared.wrapperPath || data.cliPath || settings.cliPath || 'agy');
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
            const request = this.beginDailyReviewRequest();
            if (!request) break;
            const review = await startDailyReviewAgent(
              { ...this._getSettings(), globalDataPath: request.globalDataPath },
              request.projectState.projects,
              this._extensionUri
            );
            if (!request.isCurrent()) break;
            void this.postMessage({ command: 'dailyReviewLoaded', review });
            break;
          }
          case 'recordTodayShadowFeedback': {
            const outcome = String(data.outcome || '');
            if (!['accepted', 'overridden', 'ignored'].includes(outcome)) {
              throw new Error('Today arrangement feedback outcome is invalid.');
            }
            const request = this.beginDailyReviewRequest();
            if (!request || !request.isCurrent()) break;
            const currentReview = await readTodayReviewFromDatabase(request.globalDataPath, request.projectState.projects);
            if (!request.isCurrent()) break;
            if (!currentReview || currentReview.stale || currentReview.decisionId !== String(data.decisionId || '')) {
              this.sendDailyReview();
              break;
            }
            await recordShadowDecisionFeedback(request.globalDataPath, {
              operationId: String(data.operationId || ''),
              decisionId: String(data.decisionId || ''),
              recommendedProjectPath: String(data.recommendedProjectPath || ''),
              selectedProjectPath: String(data.selectedProjectPath || ''),
              outcome: outcome as 'accepted' | 'overridden' | 'ignored',
              recordedAt: new Date().toISOString()
            });
            break;
          }
          case 'openDependencyAction':
            this.openDependencyAction(data.action || '', data.cliPath || this._getSettings().cliPath || 'agy');
            break;
        }
      } catch (error) {
        recordLocalDiagnosticError(getDiagnosticDataPath(this._getSettings), `sidebar.action.${String(data?.command || 'unknown')}`, error);
        console.error('SoloMap sidebar message failed:', data?.command, error);
        void this.postMessage({
          command: 'sidebarActionFailed',
          message: error instanceof Error ? error.message : String(error),
          action: String(data?.command || ''),
          projectPath: String(data?.projectPath || ''),
          conversationId: Number(data?.conversationId || 0)
        });
        throw error;
      }
    };
    const pendingUiStatePatches = new Map<string, {
      latest: any;
      patches: Map<string, unknown>;
      requestIds: string[];
    }>();
    let uiStatePatchFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const queueUiStatePatch = (data: any): void => {
      const requested = Array.isArray(data?.patches) ? data.patches : [{ key: data?.key, value: data?.value }];
      if (requested.length < 1 || requested.length > 4096
        || requested.some((patch: any) => !String(patch?.key || '') || patch?.value === undefined)) {
        void handleMessage(data).catch(() => undefined);
        return;
      }
      const scopeKey = String(data.scopeKey || 'global').slice(0, 1024);
      const pending = pendingUiStatePatches.get(scopeKey) || { latest: data, patches: new Map<string, unknown>(), requestIds: [] };
      pending.latest = data;
      for (const patch of requested) pending.patches.set(String(patch.key).slice(0, 1024), patch.value);
      const requestId = String(data.requestId || '');
      if (requestId) pending.requestIds.push(requestId);
      pendingUiStatePatches.set(scopeKey, pending);
      if (uiStatePatchFlushTimer) return;
      uiStatePatchFlushTimer = setTimeout(() => {
        uiStatePatchFlushTimer = undefined;
        const batches = [...pendingUiStatePatches.entries()];
        pendingUiStatePatches.clear();
        void (async () => {
          for (const [scope, batch] of batches) {
            const patches = [...batch.patches].map(([key, value]) => ({ key, value }));
            for (let offset = 0; offset < patches.length; offset += 4096) {
              const isFinalChunk = offset + 4096 >= patches.length;
              await handleMessage({
                ...batch.latest,
                command: 'uiState.patch',
                scopeKey: scope,
                patches: patches.slice(offset, offset + 4096),
                requestIds: isFinalChunk ? batch.requestIds : [],
                requestId: isFinalChunk ? (batch.requestIds.at(-1) || String(batch.latest.requestId || '')) : ''
              });
            }
          }
        })().catch(() => undefined);
      }, 25);
    };
    webviewView.webview.onDidReceiveMessage((data) => {
      const command = String(data?.command || '');
      if (command === 'uiState.patch') return queueUiStatePatch(data);
      if (!/^(?:getNodes|getSettings|getProjects|bootstrap\.get|settings\.get|databaseOverview\.get|agentImpact\.get|checkDependencies|conversation\.runSolo|conversation\.continue|project\.select|showStrategyPyramid|showFullRoadmap)$/.test(command)) return handleMessage(data).catch(() => undefined);
      const trace = createLocalDiagnosticTrace(getDiagnosticDataPath(this._getSettings), `sidebar.action.${command}`, { interactionId: data.interactionId, targetId: 'sidebar' });
      if (command === 'showStrategyPyramid') {
        this._navigationTraces.set(trace.interactionId!, trace);
        if (this._navigationTraces.size > 16) this._navigationTraces.delete(this._navigationTraces.keys().next().value!);
      }
      return withLocalDiagnosticTrace(trace, () => runTracedSidebarAction(trace, `sidebar.action.${command}`, () => handleMessage(data)));
    });

    // The Webview owns the single cold-start request. Pushing the same payload
    // here as well causes duplicate settings, portfolio and SQLite loads.
  }

  /**
   * Refreshes the sidebar view with updated node states.
   */
  public sendNodesToWebview(): Thenable<boolean> | Promise<boolean> {
    try {
      if (!this._view || !this._syncEngine) {
        return Promise.resolve(false);
      }
      const nodes = this._syncEngine.getNodes();
      return postWebviewMessage(this._view.webview, {
        command: 'nodesUpdated',
        nodes: nodes,
        projectGeneration: this.currentProjectGeneration(),
        projectPath: this._getProjects().selectedProjectPath
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send nodes:', error);
      return Promise.resolve(false);
    }
  }

  /**
   * Reads and pushes active configuration settings to the sidebar.
   */
  public sendSettings(settings = this._getSettings()) {
    try {
      if (!this._view) {
        return;
      }
      void this.postMessage({
        command: 'settingsLoaded',
        settings,
        projectRoot: this._getProjects().selectedProjectPath || ''
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send settings:', error);
    }
  }

  public sendProjectSelection(projectRoot: string, generation: number, interactionId = '', accepted = true) {
    this._projectSelectionGeneration = generation;
    this._latestConversationSnapshotRequest.clear();
    this._latestConversationHistoryRequest.clear();
    void this.postMessage({ command: 'projectSelectionChanged', projectRoot, generation, interactionId, accepted });
  }

  private currentProjectGeneration(): number {
    return this._getProjects().projectGeneration ?? this._projectSelectionGeneration;
  }

  public postSkillInstallResult(success: boolean, message: string) {
    void this.postMessage({
      command: 'skillInstallResult',
      success,
      message
    });
  }

  public postMcpInstallResult(success: boolean, message: string) {
    void this.postMessage({
      command: 'mcpInstallResult',
      success,
      message
    });
  }

  public postAgentCliUpgradeResult(success: boolean, message: string, pending = false) {
    void this.postMessage({ command: 'agentCliUpgradeResult', success, message, pending });
  }

  public async sendProjects() {
    try {
      if (!this._view) {
        return;
      }
      if (this._localRefreshTimer) {
        clearTimeout(this._localRefreshTimer);
        this._localRefreshTimer = null;
      }
      this._refreshAllLocalProjects = false;
      this._pendingLocalProjectPaths.clear();
      const requestId = ++this._projectLoadRequest;
      this._corePortfolioRequest += 1;
      this._projectLoader.cancelExternalLoads();
      const projectState = this._getProjects();
      const conversationGeneration = this.currentProjectGeneration();
      const conversationLedgerRevision = this._conversationLedgerRevisions.get(projectState.selectedProjectPath) || 0;
      const globalDataPath = normalizeGlobalDataPath(this._getSettings().globalDataPath, projectState.projects);
      const rootState = this.captureDataRoot(globalDataPath, projectState.selectedProjectPath);
      if (projectState.projects.length === 0) {
        this.postCorePortfolio([], projectState.selectedProjectPath, [], globalDataPath, null, true);
        this.sendDailyReview();
        return;
      }
      const cachedConversationRead = readCachedConversationSnapshot(globalDataPath, projectState.selectedProjectPath).catch(error => {
        console.error('SoloMap sidebar failed to read the cached conversation snapshot:', error);
        return null;
      });
      const availablePaths = new Set(projectState.projects.map((project) => project.path));
      const localPortfolio = this._latestPortfolio.filter((summary) => availablePaths.has(summary.path));
      if (localPortfolio.length) {
        this.postCorePortfolio(projectState.projects, projectState.selectedProjectPath, localPortfolio, globalDataPath);
      } else {
        const cachedCoreRead = readSidebarCoreSnapshot(globalDataPath).catch(error => {
          console.error('SoloMap sidebar failed to read the cached core snapshot:', error);
          return null;
        });
        let cachedCoreTimeout: ReturnType<typeof setTimeout> | undefined;
        const cachedCore = await Promise.race([
          cachedCoreRead,
          new Promise<null>((resolve) => { cachedCoreTimeout = setTimeout(() => resolve(null), 250); })
        ]).finally(() => {
          if (cachedCoreTimeout) clearTimeout(cachedCoreTimeout);
        });
        if (!this._view
          || requestId !== this._projectLoadRequest
          || !this.isCurrentDataRoot(rootState.root, rootState.generation)) return;
        if (cachedCore?.projectSignature === buildSidebarProjectSignature(projectState.projects)) {
          this.postCorePortfolio(projectState.projects, projectState.selectedProjectPath, cachedCore.portfolio, globalDataPath);
        }
      }
      this.scheduleCorePortfolio(projectState.projects, projectState.selectedProjectPath, globalDataPath, localPortfolio, {
        includeExternal: true
      });
      this.sendDailyReview();

      const cachedConversation = await cachedConversationRead;
      if (!this._view
        || requestId !== this._projectLoadRequest
        || !this.isCurrentDataRoot(rootState.root, rootState.generation)) return;
      if (conversationGeneration !== this.currentProjectGeneration()) return;
      if (cachedConversation && conversationLedgerRevision === (this._conversationLedgerRevisions.get(projectState.selectedProjectPath) || 0)) {
        this.postProjectConversationSnapshot(projectState.selectedProjectPath, cachedConversation, conversationGeneration);
      }
      if (!cachedConversation) {
        void this.sendProjectConversationSnapshot(projectState.selectedProjectPath);
      }
      void this.sendRemainingConversationSnapshots(projectState.projects, projectState.selectedProjectPath, globalDataPath, requestId, rootState);
    } catch (error) {
      console.error('SoloMap sidebar failed to send projects:', error);
      void this.postMessage({
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

  public sendLocalProjects(projectPath = '') {
    if (!this._view) return;
    if (projectPath) {
      this._pendingLocalProjectPaths.add(projectPath);
    } else {
      this._refreshAllLocalProjects = true;
      this._pendingLocalProjectPaths.clear();
    }
    if (this._localRefreshTimer) return;
    this._projectLoadRequest += 1;
    this._corePortfolioRequest += 1;
    this._localRefreshTimer = setTimeout(() => void (async () => {
      this._localRefreshTimer = null;
      try {
        if (!this._view) return;
        const projectState = this._getProjects();
        const globalDataPath = normalizeGlobalDataPath(this._getSettings().globalDataPath, projectState.projects);
        const rootState = this.captureDataRoot(globalDataPath, projectState.selectedProjectPath);
        const availablePaths = new Set(projectState.projects.map((project) => project.path));
        const stalePortfolio = this._latestPortfolio.filter((summary) => availablePaths.has(summary.path));
        const requestedPaths = this._refreshAllLocalProjects
          ? []
          : [...this._pendingLocalProjectPaths].filter((candidate) => availablePaths.has(candidate));
        this._refreshAllLocalProjects = false;
        this._pendingLocalProjectPaths.clear();
        this.scheduleCorePortfolio(
          projectState.projects,
          projectState.selectedProjectPath,
          globalDataPath,
          stalePortfolio,
          { includeExternal: false, projectPaths: requestedPaths }
        );
      } catch (error) {
        console.error('SoloMap sidebar failed to send local projects:', error);
      }
    })(), 20);
  }

  private async sendRemainingConversationSnapshots(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    globalDataPath: string,
    requestId: number,
    rootState: { root: string; generation: number }
  ): Promise<void> {
    for (const project of projects) {
      if (!project.path || project.path === selectedProjectPath) continue;
      const projectGeneration = this.currentProjectGeneration();
      const ledgerRevision = this._conversationLedgerRevisions.get(project.path) || 0;
      const projectConversation = await readCachedConversationSnapshot(globalDataPath, project.path);
      if (!this._view || requestId !== this._projectLoadRequest || !this.isCurrentDataRoot(rootState.root, rootState.generation)) return;
      if (projectGeneration !== this.currentProjectGeneration()) return;
      if (ledgerRevision !== (this._conversationLedgerRevisions.get(project.path) || 0)) continue;
      if (projectConversation) this.postProjectConversationSnapshot(project.path, projectConversation, projectGeneration);
      else void this.sendProjectConversationSnapshot(project.path);
    }
  }

  public invalidateProjectSignals(projectPath: string, kinds: Array<'issues' | 'pullRequests' | 'delivery' | 'security'>): void {
    this._projectLoader.invalidateProjectSignals(projectPath, kinds);
  }

  public prioritizeProjectSignals(projectPath: string): void {
    const project = this._getProjects().projects.find(candidate => candidate.path === projectPath);
    if (project) this._projectLoader.prioritizeProjectSignals(project);
  }

  public refreshProjectSignals(projectPath: string) {
    return this._projectLoader.refreshProjectSignals(projectPath);
  }

  public refreshProjectSignal(
    projectPath: string,
    kind: 'issues' | 'pullRequests' | 'delivery' | 'security',
    globalDataPath?: string
  ) {
    return this._projectLoader.refreshProjectSignal(projectPath, kind, globalDataPath);
  }

  private postCorePortfolio(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    portfolio: ProjectPortfolioSummary[],
    globalDataPath: string,
    recentConversationSnapshot: SidebarConversationSnapshot | null = null,
    coreLoaded = false
  ): void {
    const previousDataRoot = this._activeDataRoot;
    const rootState = this.captureDataRoot(globalDataPath, selectedProjectPath);
    const corePortfolio = applyProjectRegistryToPortfolio(projects, portfolio);
    const currentPortfolio = previousDataRoot && previousDataRoot === rootState.root
      ? this.preserveCurrentExternalSignals(corePortfolio)
      : corePortfolio;
    this._latestPortfolio = currentPortfolio;
    const globalStore = createGlobalEngineeringSnapshotPlaceholder(globalDataPath, currentPortfolio);
    void this.postMessage({
      command: 'projectsLoaded',
      projects: { projects, selectedProjectPath: this._getProjects().selectedProjectPath, projectGeneration: this.currentProjectGeneration(), portfolio: currentPortfolio, globalStore, recentConversationSnapshot, coreLoaded, diagnosticTraceId: this._startupTrace?.id }
    });
  }

  private captureDataRoot(globalDataPath: string, _projectPath = ''): { root: string; generation: number } {
    const root = normalizeGlobalDataPath(globalDataPath, this._getProjects().projects);
    if (root !== this._activeDataRoot) {
      this._activeDataRoot = root;
      this._dataRootGeneration += 1;
      this._latestPortfolio = [];
      this._latestProjectSignals.clear();
      this._projectLoader.cancelExternalLoads();
    }
    return { root, generation: this._dataRootGeneration };
  }

  private isCurrentDataRoot(root: string, generation: number, _projectPath = ''): boolean {
    return generation === this._dataRootGeneration
      && root === this._activeDataRoot
      && root === normalizeGlobalDataPath(this._getSettings().globalDataPath, this._getProjects().projects);
  }

  private scheduleCorePortfolio(
    projects: SolopreneurProject[],
    selectedProjectPath: string,
    globalDataPath: string,
    stalePortfolio: ProjectPortfolioSummary[],
    options: { includeExternal: boolean; projectPaths?: string[] }
  ): void {
    if (options.includeExternal) this._externalRefreshPending = true;
    const requestId = ++this._corePortfolioRequest;
    const rootState = this.captureDataRoot(globalDataPath, selectedProjectPath);
    const reservation = reserveSidebarPortfolioSnapshot(globalDataPath)
      .catch(error => {
        console.error('SoloMap sidebar failed to reserve core snapshot:', error);
        return null;
      });
    const sourceProjectSignature = buildSidebarProjectSignature(projects);
    const requestedPaths = new Set((options.projectPaths || []).filter(Boolean));
    const needsCompletePortfolio = stalePortfolio.length < projects.length;
    const ordered = [
      ...projects.filter((project) => project.path === selectedProjectPath),
      ...projects.filter((project) => project.path !== selectedProjectPath)
    ].filter((project) => needsCompletePortfolio || requestedPaths.size === 0 || requestedPaths.has(project.path));
    const currentStalePortfolio = applyProjectRegistryToPortfolio(projects, stalePortfolio);
    const summaries = new Map(currentStalePortfolio.map((summary) => [summary.path, summary]));
    const loadNext = (index: number) => {
      if (!this._view || requestId !== this._corePortfolioRequest || !this.isCurrentDataRoot(rootState.root, rootState.generation, selectedProjectPath)) return;
      const currentProjectState = this._getProjects();
      const currentProjectSignature = buildSidebarProjectSignature(currentProjectState.projects);
      if (currentProjectSignature !== sourceProjectSignature) {
        console.warn('SoloMap sidebar project sources changed during core snapshot collection; rebuilding the snapshot.');
        this.scheduleCorePortfolio(
          currentProjectState.projects,
          currentProjectState.selectedProjectPath,
          this._getSettings().globalDataPath,
          this._latestPortfolio,
          { includeExternal: options.includeExternal, projectPaths: [] }
        );
        return;
      }
      if (index >= ordered.length) {
        const portfolio = this.preserveCurrentExternalSignals(
          projects.map((project) => summaries.get(project.path)).filter(Boolean) as ProjectPortfolioSummary[]
        );
        this._latestPortfolio = portfolio;
        if (ordered.length === 0) this.postCorePortfolio(projects, selectedProjectPath, portfolio, globalDataPath, null, true);
        if (portfolio.length === projects.length && this.isCurrentDataRoot(rootState.root, rootState.generation, selectedProjectPath)) {
          void reservation.then(value => value
            && requestId === this._corePortfolioRequest
            && this.isCurrentDataRoot(rootState.root, rootState.generation, selectedProjectPath)
            && buildSidebarProjectSignature(this._getProjects().projects) === sourceProjectSignature
            ? commitSidebarPortfolioSnapshot(globalDataPath, value, sourceProjectSignature, portfolio)
            : false).catch(error => console.error('SoloMap sidebar failed to persist core snapshot:', error));
        }
        if (options.includeExternal || this._externalRefreshPending) {
          this._externalRefreshPending = false;
          this._projectLoader.scheduleAll(projects, selectedProjectPath, portfolio);
        } else {
          this._projectLoader.schedulePortfolioEnrichment(
            projects,
            selectedProjectPath,
            portfolio,
            options.projectPaths || []
          );
        }
        return;
      }
      const project = ordered[index];
      const previous = summaries.get(project.path);
      const core = buildProjectPortfolioSummary(project, { coreOnly: true });
      summaries.set(project.path, previous ? {
        ...previous,
        ...core,
        recentActivityAt: previous.recentActivityAt,
        issues: previous.issues,
        pullRequests: previous.pullRequests,
        delivery: previous.delivery,
        security: previous.security,
        foundation: previous.foundation,
        reusableSignals: previous.reusableSignals,
        investment: previous.investment
      } : core);
      const portfolio = this.preserveCurrentExternalSignals(
        applyProjectRegistryToPortfolio(
          projects,
          projects.map((item) => summaries.get(item.path)).filter(Boolean) as ProjectPortfolioSummary[]
        )
      );
      this._latestPortfolio = portfolio;
      const globalStore = createGlobalEngineeringSnapshotPlaceholder(globalDataPath, portfolio);
      void this.postMessage({
        command: 'projectsLoaded',
        projects: {
          projects,
          selectedProjectPath: currentProjectState.selectedProjectPath,
          projectGeneration: this.currentProjectGeneration(),
          portfolio,
          globalStore,
          coreLoaded: index === ordered.length - 1,
          diagnosticTraceId: this._startupTrace?.id,
          updatedProjectPaths: [project.path]
        }
      });
      setTimeout(() => loadNext(index + 1), 0);
    };
    setTimeout(() => loadNext(0), 0);
  }

  public async sendSoloConversationHistory(projectPath: string) {
    const projectGeneration = this.currentProjectGeneration();
    const ledgerRevision = this._conversationLedgerRevisions.get(projectPath) || 0;
    try {
      if (!this._view || !this._getSoloConversationHistory || !projectPath) {
        return;
      }
      const rootState = this.captureDataRoot(this._getSettings().globalDataPath, projectPath);
      const requestKey = `solo\0${projectPath}`;
      const requestId = ++this._conversationHistoryRequest;
      this._latestConversationHistoryRequest.set(requestKey, requestId);
      const conversations = await this._getSoloConversationHistory(projectPath);
      if (projectGeneration !== this.currentProjectGeneration() || ledgerRevision !== (this._conversationLedgerRevisions.get(projectPath) || 0)
        || this._latestConversationHistoryRequest.get(requestKey) !== requestId
        || !this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
      void this.postMessage({
        command: 'sidebarSoloConversationLoaded',
        projectGeneration,
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send solo conversation history:', error);
    }
  }

  public async sendStepConversationHistory(projectPath: string, nodeId: string) {
    const projectGeneration = this.currentProjectGeneration();
    const ledgerRevision = this._conversationLedgerRevisions.get(projectPath) || 0;
    try {
      if (!this._view || !this._getStepConversationHistory || !projectPath || !nodeId) {
        return;
      }
      const rootState = this.captureDataRoot(this._getSettings().globalDataPath, projectPath);
      const requestKey = `step\0${projectPath}\0${nodeId}`;
      const requestId = ++this._conversationHistoryRequest;
      this._latestConversationHistoryRequest.set(requestKey, requestId);
      const conversations = await this._getStepConversationHistory(projectPath, nodeId);
      if (projectGeneration !== this.currentProjectGeneration() || ledgerRevision !== (this._conversationLedgerRevisions.get(projectPath) || 0)
        || this._latestConversationHistoryRequest.get(requestKey) !== requestId
        || !this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
      void this.postMessage({
        command: 'sidebarStepConversationLoaded',
        projectGeneration,
        projectPath,
        nodeId,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send step conversation history:', error);
    }
  }

  public async sendProjectConversationHistory(projectPath: string) {
    const projectGeneration = this.currentProjectGeneration();
    const ledgerRevision = this._conversationLedgerRevisions.get(projectPath) || 0;
    try {
      if (!this._view || !this._getProjectConversationHistory || !projectPath) {
        return;
      }
      const rootState = this.captureDataRoot(this._getSettings().globalDataPath, projectPath);
      const requestKey = `project\0${projectPath}`;
      const requestId = ++this._conversationHistoryRequest;
      this._latestConversationHistoryRequest.set(requestKey, requestId);
      const conversations = await this._getProjectConversationHistory(projectPath);
      if (projectGeneration !== this.currentProjectGeneration() || ledgerRevision !== (this._conversationLedgerRevisions.get(projectPath) || 0)
        || this._latestConversationHistoryRequest.get(requestKey) !== requestId
        || !this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
      void this.postMessage({
        command: 'sidebarProjectConversationLoaded',
        projectGeneration,
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send project conversation history:', error);
    }
  }

  public async sendProjectConversationSnapshot(projectPath: string, force = false, supersedeInFlight = false) {
    const projectGeneration = this.currentProjectGeneration();
    const requestId = ++this._conversationSnapshotRequest;
    let claimedSnapshotLoad: Promise<SidebarConversationSnapshot> | null = null;
    let requestKey = '';
    try {
      if (!this._view || !this._getProjectConversationSnapshot || !projectPath) return;
      const globalDataPath = this._getSettings().globalDataPath;
      const rootState = this.captureDataRoot(globalDataPath, projectPath);
      requestKey = `${rootState.root}\0${projectPath}`;
      this._latestConversationSnapshotRequest.set(requestKey, requestId);
      const ledgerRevision = this._conversationLedgerRevisions.get(projectPath) || 0;
      const isCurrent = () => this._latestConversationSnapshotRequest.get(requestKey) === requestId
        && projectGeneration === this.currentProjectGeneration()
        && ledgerRevision === (this._conversationLedgerRevisions.get(projectPath) || 0)
        && this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath);
      const cached = supersedeInFlight ? null : await readCachedConversationSnapshot(rootState.root, projectPath);
      if (!isCurrent()) return;
      if (cached) {
        if (this._latestConversationSnapshotRequest.get(requestKey) === requestId && this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) {
          this.postProjectConversationSnapshot(projectPath, cached, projectGeneration);
        }
        if (!force || !this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
      }
      if (!this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
      let snapshotLoad = this._conversationSnapshotLoads.get(requestKey);
      if (!snapshotLoad || supersedeInFlight) {
        const sourceSignature = await buildConversationDatabaseSignature(rootState.root, projectPath);
        if (!isCurrent()) return;
        if (!supersedeInFlight) snapshotLoad = this._conversationSnapshotLoads.get(requestKey);
        if (!snapshotLoad || supersedeInFlight) {
          snapshotLoad = {
            sourceSignature,
            promise: this._getProjectConversationSnapshot(projectPath),
            startedAt: Date.now()
          };
          this._conversationSnapshotLoads.set(requestKey, snapshotLoad);
        }
      }
      claimedSnapshotLoad = snapshotLoad.promise;
      const snapshot = await snapshotLoad.promise;
      if (isCurrent()) {
        const sourceSignature = await buildConversationDatabaseSignature(rootState.root, projectPath);
        if (!isCurrent()) return;
        if (snapshotLoad.sourceSignature !== sourceSignature) {
          await this.sendProjectConversationSnapshot(projectPath, true, true);
          return;
        }
        if (!this.isCurrentDataRoot(rootState.root, rootState.generation, projectPath)) return;
        await writeCachedConversationSnapshot(rootState.root, projectPath, snapshotLoad.sourceSignature, snapshot);
        if (!isCurrent()) return;
        this.postProjectConversationSnapshot(projectPath, snapshot, projectGeneration);
      }
    } catch (error) {
      console.error('SoloMap sidebar failed to send project conversation snapshot:', error);
    } finally {
      const snapshotLoad = requestKey ? this._conversationSnapshotLoads.get(requestKey) : undefined;
      if (snapshotLoad && snapshotLoad.promise === claimedSnapshotLoad) {
        this._conversationSnapshotLoads.delete(requestKey);
      }
    }
  }

  public async refreshProjectConversationSnapshotAfterStatusChange(projectPath: string): Promise<void> {
    this._conversationLedgerRevisions.set(
      projectPath,
      (this._conversationLedgerRevisions.get(projectPath) || 0) + 1
    );
    await this.sendProjectConversationSnapshot(projectPath, true, true);
  }

  private postProjectConversationSnapshot(projectPath: string, snapshot: SidebarConversationSnapshot, projectGeneration: number): void {
    void this.postMessage({
      command: 'sidebarProjectConversationSnapshotLoaded',
      projectGeneration,
      projectPath,
      soloConversations: snapshot.solo,
      projectConversations: snapshot.project,
      flowConversations: snapshot.flow,
      revisionConversations: snapshot.revision
    });
  }

  public async sendDailyReview() {
    try {
      const request = this.beginDailyReviewRequest();
      if (!request) return;
      await refreshShadowRuntimeState(request.globalDataPath);
      if (!request.isCurrent()) return;
      const review = await readTodayReviewFromDatabase(request.globalDataPath, request.projectState.projects);
      if (!request.isCurrent()) return;
      void this.postMessage({
        command: 'dailyReviewLoaded',
        review
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send daily review:', error);
    }
  }

  private openDependencyAction(action: string, cliPath: string) {
    const workspaceRoot = this._getProjects().selectedProjectPath
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || process.cwd();
    const { maintenanceRoot } = ensureSolomapMaintenanceWorkspace(workspaceRoot, this._getSettings().globalDataPath);
    const terminal = vscode.window.createTerminal({
      name: 'Setup',
      iconPath: vscode.Uri.joinPath(this._extensionUri, 'resources', 'logo.png'),
      cwd: maintenanceRoot,
      env: desktopSessionEnvironment(),
    });
    terminal.show(true);
    if (action === 'github-auth') {
      void sendTextWhenTerminalReady(terminal, 'gh auth login');
      return;
    }
    if (action === 'github-install') {
      void sendTextWhenTerminalReady(terminal, 'gh --version || echo "Install GitHub CLI from https://cli.github.com/"');
      return;
    }
    if (action === 'agent-install') {
      void sendTextWhenTerminalReady(terminal, buildAgentInstallCommand(cliPath || 'agy'));
      return;
    }
    if (action === 'agent-check') {
      const command = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
      void sendTextWhenTerminalReady(terminal, `${shellQuote(command)} --version`);
    }
  }


}
