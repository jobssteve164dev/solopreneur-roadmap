import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';
import { SqliteStore } from './db/sqliteStore';
import { AgentConversation, RoadmapNode } from './db/types';
import { buildFlowStatePayload, createFlowLoop, createFlowTrace, FlowLoopScoring, FlowLoopStatus, FlowRole, FlowTrace, readFlowTrace, saveFlowTrace, updateFlowTrace } from './flowStore';
import { SolopreneurSidebarProvider } from './sidebarProvider';
import { getAgentImpactStatusFromDatabase, buildAgentImpactSummary } from './agentImpact';
import { auditDocumentationAfterRun, buildDocumentationPromptContext, ensureDocumentationManifest } from './documentationManifest';
import { appendLearningEvent, buildLearningRetrievalContext, readLearningSummary, LearningEvidenceRef } from './learningLedger';
import { buildFeedbackIssueUrl, buildGithubDeliveryContext, buildGithubIssueContext, buildGithubSecurityContext } from './projectSignals';
import {
  closeProjectIssue,
  closeProjectPullRequest,
  createProjectIssue,
  loadExternalDeliverySummary,
  loadExternalIssueSummary,
  loadExternalPullRequestSummary,
  loadExternalSecuritySummary,
  readCachedIssueDetails,
  readProjectIssueDetails
} from './projectExternalSignals';
import { getWebviewHtml } from './roadmapWebview';
import { buildLocalDataStatusHtml, formatLocalDataError, postLocalDataLoad } from './localDataLoader';
import { backfillRunIndexFromDigests } from './runIndexMaintenance';
import { refreshProjectGrowthSnapshot } from './projectGrowth';
import { buildStrategyPyramidSnapshotData, saveProjectStrategyData } from './strategyPyramid';
import { ensureProjectFoundation } from './projectFoundation';
import { getStrategyPyramidWebviewHtml } from './strategyPyramidWebview';
import {
  buildCrossAgentHandoffInstructions,
  buildExecutionExperiencePrompt,
  buildRunDigest,
  buildRunHandoffEntry,
  buildStepHandoffSummary,
  compactLine,
  extractFailureSignals,
  extractVerificationSignals,
  getLegacyStepMemoryFilePath,
  parseFileSummaryLines,
  parseStepHandoffEntries,
  readStepHandoffSummary,
  updateStepHandoffSummary,
  writeExecutionGraph,
  writeRunDigest
} from './runDigest';
import {
  buildEnhancementInstallPrompt,
  buildEnhancementUninstallPrompt,
  buildSolomapEnhancementCandidateInstructions,
  buildSolomapEnhancementContextPreflight,
  buildSolomapEnhancementRuntimeInstructions,
  buildSolomapLearningContext,
  buildSolomapMcpCandidateInstructions,
  buildSolomapStartupPackInstructions,
  buildMcpInstallPrompt,
  buildSkillInstallPrompt,
  checkAndRegisterEnhancement,
  ensureSolomapEnhancementRuntime,
  ensureSolomapEnhancementStore,
  ensureSolomapMemoryStore,
  ensureSolomapMcpStore,
  ensureSolomapSkillStore,
  getEnabledEnhancementMap,
  getBuiltinEnhancementDefinition,
  getSolomapMcpRoot,
  getSolomapSkillsRoot,
  readSolomapMcpRegistry,
  readSolomapSkillRegistry,
  recordSolomapLearningCycle,
  refreshSolomapEnhancementStatusSummaries,
  setSolomapEnhancementEnabled,
  uninstallSolomapEnhancement,
  upsertEnhancementRegistryEntry,
  validateAndRegisterEnhancementInstall,
  validateAndRegisterEnhancementUninstall,
  validateAndRegisterMcpInstall,
  validateAndRegisterSkillInstall,
  writeSolomapMcpRegistry,
  writeSolomapSkillRegistry
} from './solomapGlobal';
import {
  buildAgentCommand,
  buildAgentCommandForPromptFile,
  buildAgentCommandFromShellVar,
  buildNativeContinueCommand,
  buildSdkSentinelCommandLabel,
  commandExists,
  ensureAgentTaskAutomation,
  formatCliTestMessage,
  getAgentCliCandidates,
  getAgentCliFamily,
  getAgentProvider,
  getCliVersionArgs,
  getTaskPermissionArgs,
  resolveAgentCli,
  resolveExecutablePath,
  shellQuote,
  supportsSdkContinuation
} from './agentCli';
import { SolomapAutomationSettings, SolomapAutomationTrigger, SolomapScheduledAutomationTask, SolopreneurSettings } from './pluginContracts';
import { buildConversationPresentations, selectLatestConversationRoots } from './conversationPresentation';
import { dispatchPluginAction, PluginActionRequest, PluginSurface } from './pluginActions';
import {
  buildAgentModelsLoadedMessage,
  mergeAgentModelPreferences,
  normalizeAgentModelPreferences,
} from './agentModelSelection';
import {
  chooseSupplementFilesForProject,
  filterProjectRelativeFiles,
  normalizeSupplementFiles,
  sanitizeAttachmentScope,
  savePastedImageAttachments
} from './attachments';
import {
  getHiddenProjects as getHiddenProjectsFromRegistry,
  getProjects as getProjectsFromRegistry,
  getSelectedProjectPath as getSelectedProjectPathFromRegistry,
  normalizeGlobalDataPathForExtension as normalizeGlobalDataPathForRegistry,
  normalizeProjectsForStorage as normalizeProjectsForRegistryStorage,
  projectName as registryProjectName,
  readProjectRegistry as readProjectRegistryFile,
  writeProjectRegistry as writeProjectRegistryFile
} from './projectRegistry';
import {
  buildFeedbackUsageSummary as buildFeedbackUsageSummaryFromStats,
  LocalUsageEvent,
  LocalUsageStats,
  recordLocalUsageEvent as recordLocalUsageEventInStats
} from './localUsageStats';
import { clearProjectInvestmentCache } from './projectAnalytics';
import {
  buildPassportProUrl,
  buildProAccountStatus,
  clearProEntitlements,
  createPassportAuthNonce,
  flowModeFeature,
  grantContainsFeature,
  hasProEntitlement as hasProEntitlementForSettings,
  normalizeProAccountStatus,
  passportGrantOfflineGraceMs,
  PassportGrantCache,
  PassportVerifyResult,
  readLocalProEntitlements,
  strategyPyramidFeature,
  verifyPassportGrant as verifyPassportGrantWithFetch
} from './proAccount';
import {
  postAgentModelsLoaded,
  postFlowStateLoaded,
  postProjectsLoaded,
  postSettingsLoaded,
  postWebviewMessage
} from './panelMessages';
import {
  clearStoredAgentSession,
  extractCodexSessionIdFromOutputText,
  extractContinuationParentConversationId,
  extractContinuationSessionIdFromExecutionOutput,
  extractFirstCodexUserMessageAfter,
  extractNativeSessionIdFromExecutionOutput,
  extractSavedNativeSessionIdFromExecutionOutput,
  findCodexTranscriptFile,
  getAgentSessionKey,
  getStepSessionFilePath,
  getStoredAgentSession,
  readRunSessionId,
  readRunTextFile,
  readStepSessionState,
  resolveContinuationLeafConversationFromList,
  resolveContinuationRootConversationFromList,
  resolveContinuationSessionConversationFromList,
  resolveNativeSessionIdForConversation as resolveNativeSessionIdForConversationFromWorkspace,
  stripAnsiControlCodes,
  updateStoredAgentSession
} from './continuation';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let activeStrategyPyramidPanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;
let statusPoller: NodeJS.Timeout | null = null;
let sidebarProvider: SolopreneurSidebarProvider | null = null;
let extensionContextRef: vscode.ExtensionContext | null = null;
let activeProjectRoot: string | null = null;
let syncEngineReady = false;
let pendingPassportAuthNonce: string | null = null;
let syncEngineInitPromise: Promise<boolean> | null = null;
let syncEngineInitProjectRoot = '';
const SOLOMAP_GIT_DIFF_SCHEME = 'solomap-git-diff';
const solomapGitDiffContent = new Map<string, string>();

const hasProEntitlement = hasProEntitlementForSettings;

interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  description?: string;
  notes?: string;
  pinnedAt?: string;
}

interface ProjectRegistryFile {
  schemaVersion: number;
  updatedAt: string;
  projects: SolopreneurProject[];
  hiddenProjects: string[];
}

const settingsKey = 'solopreneur.settings';
const projectsKey = 'solopreneur.projects';
const selectedProjectKey = 'solopreneur.selectedProjectPath';
const hiddenProjectsKey = 'solopreneur.hiddenProjects';
const passportGrantSecretKey = 'solopreneur.passportGrant';
const projectRegistryFileName = 'projects.json';
const usageStatsFileName = 'solomap-usage.json';
const roadmapRevisionId = '__roadmap_revision__';
const soloConversationId = '__solo__';
const sidebarProjectConversationHistoryLimit = 10;
const agentTerminalBaseName = 'solomap';
const agentStatusDirName = 'agent-status';
const automationRetryConversationIds = new Set<number>();
const automationPromptConversationIds = new Set<string>();
let activeAgentTerminalName = '';
let agentTerminalCounter = 0;
let focusReminderTimer: NodeJS.Timeout | null = null;
let focusReminderNextAt = '';
let scheduledAutomationTimer: NodeJS.Timeout | null = null;
let scheduledAutomationNextAt = '';
const scheduledAutomationRunKeys = new Set<string>();
const agentTerminalNamesByConversationId = new Map<number, string>();
const agentTerminalProjectRootsByConversationId = new Map<number, string>();

export async function activate(context: vscode.ExtensionContext) {
  console.log('SoloMap extension is now active!');
  extensionContextRef = context;
  recordLocalUsageEvent(context, 'activation');
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SOLOMAP_GIT_DIFF_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri) {
      return solomapGitDiffContent.get(uri.toString()) || '';
    }
  }));

  // Register command to show roadmap webview
  const showRoadmapDisposable = vscode.commands.registerCommand(
    'solopreneur.showRoadmap',
    async () => {
      await openRoadmapPanel(context, 'roadmap');
    }
  );
  context.subscriptions.push(showRoadmapDisposable);

  const showFlowDisposable = vscode.commands.registerCommand(
    'solopreneur.showFlow',
    async () => {
      await openRoadmapPanel(context, 'flow');
    }
  );
  context.subscriptions.push(showFlowDisposable);

  const showStrategyPyramidDisposable = vscode.commands.registerCommand(
    'solopreneur.showStrategyPyramid',
    async () => {
      await handleOpenStrategyPyramid(context);
    }
  );
  context.subscriptions.push(showStrategyPyramidDisposable);

  const manageProAuthorizationDisposable = vscode.commands.registerCommand(
    'solopreneur.manageProAuthorization',
    async (action?: string) => {
      await handleManageProAuthorization(context, action);
    }
  );
  context.subscriptions.push(manageProAuthorizationDisposable);

  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      await handlePassportUri(context, uri);
    }
  }));
  if (typeof vscode.window.onDidCloseTerminal === 'function') {
    context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
      void handleAgentTerminalClosed(terminal.name);
    }));
  }

  // Register settings saved broadcast command to keep Sidebar and Webview synced
  const settingsSavedDisposable = vscode.commands.registerCommand(
    'solopreneur.settingsSavedBroadcast',
    () => {
      if (sidebarProvider) {
        sidebarProvider.sendSettings();
        sidebarProvider.sendProjects();
      }
      if (activePanel) {
        postSettingsLoaded(activePanel.webview, getSettingsWithRuntimeState(context));
        postProjectsLoaded(activePanel.webview, getProjectState(context));
      }
    }
  );
  context.subscriptions.push(settingsSavedDisposable);

  // Setup wrapper for SyncEngine to allow safe initialization later
  const syncEngineWrapper = {
    getNodes: () => {
      return syncEngine ? syncEngine.getNodes() : [];
    }
  } as any;

  // Register Sidebar Webview View Provider
  sidebarProvider = new SolopreneurSidebarProvider(
    context.extensionUri,
    syncEngineWrapper,
    {
      getSettings: () => getSettingsWithRuntimeState(context),
      updateSettings: async (settings) => updatePersistedSettings(context, settings),
      getProjects: () => getProjectState(context),
      getSoloConversationHistory: async (projectPath) => getSoloConversationHistoryForProject(context, projectPath),
      getStepConversationHistory: async (projectPath, nodeId) => getStepConversationHistoryForProject(context, projectPath, nodeId),
      getProjectConversationHistory: async (projectPath) => getProjectConversationHistoryForProject(context, projectPath),
      dispatchSharedAction: async (message, target) => handleSharedWebviewAction(context, message, 'sidebar', target)
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SolopreneurSidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Initialize storage in the background after the UI provider is registered.
  void ensureSyncEngine(context);
  scheduleFocusReminder(context);
  scheduleTimedAutomationTask(context);
}

async function ensureActionProject(context: vscode.ExtensionContext, projectPath: string): Promise<string> {
  const requestedPath = String(projectPath || getSelectedProjectPath(context) || '');
  if (!requestedPath || !getProjects(context).some((project) => project.path === requestedPath)) {
    return '';
  }
  if (getSelectedProjectPath(context) !== requestedPath) {
    await selectProject(context, requestedPath);
  }
  const ready = await ensureSyncEngine(context);
  return ready && activeProjectRoot === requestedPath ? requestedPath : '';
}

async function handleSharedWebviewAction(
  context: vscode.ExtensionContext,
  message: PluginActionRequest,
  surface: PluginSurface,
  target?: vscode.Webview
): Promise<boolean> {
  const respond = (payload: Record<string, unknown>) => postWebviewMessage(target, payload);
  const refreshConversation = (nodeId: string) => {
    if (nodeId) {
      postNodeConversations(nodeId);
    }
  };
  return dispatchPluginAction(message, surface, {
    'conversation.runStep': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleRunAgent(
        context,
        String(request.nodeId || ''),
        String(request.userMessage || ''),
        String(request.agentCli || ''),
        String(request.model || ''),
        normalizeSupplementFiles(request.supplementFiles)
      );
    },
    'conversation.runSolo': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleRunSoloConversation(
        context,
        String(request.userMessage || ''),
        String(request.agentCli || ''),
        String(request.model || ''),
        normalizeSupplementFiles(request.supplementFiles)
      );
    },
    'conversation.runRoadmapRevision': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleRoadmapRevision(
        context,
        String(request.userMessage || ''),
        String(request.agentCli || ''),
        String(request.model || ''),
        normalizeSupplementFiles(request.supplementFiles)
      );
    },
    'flow.run': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleRunFlow(
        context,
        String(request.goal || ''),
        String(request.agentCli || ''),
        String(request.model || ''),
        normalizeSupplementFiles(request.supplementFiles)
      );
    },
    'flow.pause': async (request) => {
      if (!activeProjectRoot || !request.flowId) return;
      updateFlowTrace(activeProjectRoot, request.flowId, (trace) => {
        trace.status = 'paused';
        trace.latestSummary = 'Flow 已被用户手动暂停推进。';
        return trace;
      });
      await postFlowStateToWebview(context);
    },
    'flow.abandon': async (request) => {
      if (!activeProjectRoot || !request.flowId) return;
      updateFlowTrace(activeProjectRoot, request.flowId, (trace) => {
        trace.status = 'abandoned';
        trace.latestSummary = 'Flow 已被用户手动放弃。';
        if (trace.loops.length > 0) {
          trace.loops[trace.loops.length - 1].status = 'abandoned';
        }
        return trace;
      });
      await postFlowStateToWebview(context);
    },
    'conversation.getHistory': async (request) => {
      const projectPath = String(request.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '');
      const nodeId = String(request.nodeId || (request.originalCommand === 'getSoloConversationHistory' ? soloConversationId : ''));
      if (surface === 'sidebar' && sidebarProvider) {
        if (nodeId === soloConversationId) {
          await sidebarProvider.sendSoloConversationHistory(projectPath);
        } else {
          await sidebarProvider.sendStepConversationHistory(projectPath, nodeId);
        }
        return;
      }
      if (syncEngine && target && nodeId) {
        const conversations = buildConversationPresentations(activeProjectRoot || '', nodeId, syncEngine.getAgentExecutions(nodeId));
        await respond({ command: 'nodeConversationsLoaded', nodeId, conversations, projectPath: activeProjectRoot || '' });
      }
    },
    'conversation.getProjectHistory': async (request) => {
      if (sidebarProvider) {
        await sidebarProvider.sendProjectConversationHistory(String(request.projectPath || getSelectedProjectPath(context) || ''));
      }
    },
    'conversation.continue': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      const nodeId = String(request.nodeId || '');
      await handleContinueNativeConversation(context, nodeId, Number(request.conversationId || 0));
      refreshConversation(nodeId);
    },
    'conversation.stop': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      const nodeId = String(request.nodeId || '');
      await stopAgentRun(nodeId, Number(request.conversationId || 0));
      refreshConversation(nodeId);
    },
    'conversation.retry': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleRetryConversation(context, String(request.nodeId || ''), Number(request.conversationId || 0));
    },
    'conversation.continueTurn': async (request) => {
      const projectPath = await ensureActionProject(context, request.projectPath || '');
      if (!projectPath && request.projectPath) return;
      await handleContinueConversationTurn(
        context,
        String(request.nodeId || ''),
        Number(request.conversationId || 0),
        String(request.userMessage || ''),
        String(request.model || ''),
        normalizeSupplementFiles(request.supplementFiles)
      );
    },
    'conversation.linkToStep': async (request) => {
      linkSoloConversationToNode(Number(request.conversationId || 0), String(request.nodeId || ''));
    },
    'conversation.rollback': async (request) => {
      const projectPath = String(request.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '');
      await rollbackProjectToPreSessionGitHash(context, projectPath, String(request.gitHash || ''));
      refreshConversation(String(request.nodeId || ''));
    },
    'conversation.openTerminal': async (request) => {
      showAgentTerminal(Number(request.conversationId || 0));
    },
    'attachment.choose': async (request) => {
      const projectPath = String(request.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '');
      if (!projectPath || !getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage('Choose a project folder before attaching task files.');
        return;
      }
      const files = await chooseSupplementFilesForProject(projectPath);
      if (surface === 'sidebar') {
        await respond({ command: 'soloSupplementFilesSelected', targetId: request.targetId || '', files });
      } else {
        await respond({ command: 'supplementFilesSelected', nodeId: request.nodeId || request.targetId || '', files });
      }
    },
    'attachment.save': async (request) => {
      const projectPath = String(request.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '');
      if (!projectPath || !getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage('Choose a project folder before attaching images.');
        return;
      }
      const scope = String(request.scope || request.targetId || request.nodeId || 'conversation');
      const files = savePastedImageAttachments(projectPath, scope, request.attachments || []);
      if (surface === 'sidebar') {
        await respond({ command: 'pastedAttachmentsSaved', targetId: request.targetId || '', files });
      } else {
        await respond({ command: 'supplementFilesSelected', nodeId: request.nodeId || '', files });
      }
    },
    'agentModels.get': async (request) => {
      await postAgentModelsLoaded(target, buildAgentModelsLoadedMessage({
        requestId: request.requestId,
        targetId: request.targetId,
        agentCli: request.agentCli || '',
        configuredCliPath: getPersistedSettings(context).cliPath || 'agy'
      }));
    },
    'agent.testCli': async (request) => {
      const cliToTest = resolveAgentCli('antigravity-cli', request.cliPath || '');
      await new Promise<void>((resolve) => {
        childProcess.execFile(cliToTest, getCliVersionArgs(cliToTest), (error: any, stdout: string, stderr: string) => {
          const success = !error;
          const message = success
            ? formatCliTestMessage(cliToTest, stdout, stderr)
            : `Command not found or failed. Tried: ${getAgentCliCandidates('antigravity-cli', request.cliPath || '').join(', ')}`;
          void respond({ command: 'cliTestResult', success, message });
          resolve();
        });
      });
    },
    'agentImpact.get': async () => {
      await respond({ command: 'agentImpactLoaded', status: await getAgentImpactStatusFromDatabase(getProjects(context), context.extensionPath) });
    },
    'settings.get': async () => {
      await refreshProAccountStatus(context);
      await postSettingsLoaded(target, getSettingsWithRuntimeState(context));
    },
    'settings.update': async (request) => {
      await updatePersistedSettings(context, {
        cliPath: request.cliPath,
        agentModelPreferences: request.agentModelPreferences,
        language: request.language,
        globalPrompt: request.globalPrompt,
        globalDataPath: request.globalDataPath,
        reviewerCliPath: request.reviewerCliPath,
        collaborationReviewMode: request.collaborationReviewMode,
        automationTasks: request.automationTasks
      });
      vscode.window.showInformationMessage('SoloMap settings saved successfully!');
      await broadcastSettings(context);
    },
    'entitlement.login': async () => {
      await handleManageProAuthorization(context, 'login');
      await broadcastSettings(context);
    },
    'entitlement.paste': async () => {
      await handleManageProAuthorization(context, 'paste');
      await broadcastSettings(context);
    },
    'ability.installSkill': async (request) => handleInstallSolomapSkill(context, request.skillInput || ''),
    'ability.installMcp': async (request) => handleInstallSolomapMcp(context, request.mcpInput || ''),
    'ability.installEnhancement': async (request) => handleInstallSolomapEnhancement(context, request.enhancementId || ''),
    'ability.checkEnhancement': async (request) => handleCheckSolomapEnhancement(context, request.enhancementId || ''),
    'ability.setEnhancementEnabled': async (request) => handleSetSolomapEnhancementEnabled(context, request.enhancementId || '', Boolean(request.enabled)),
    'ability.uninstallEnhancement': async (request) => handleUninstallSolomapEnhancement(context, request.enhancementId || ''),
    'ability.uninstallSkill': async (request) => handleUninstallSolomapSkill(context, request.skillId || ''),
    'ability.uninstallMcp': async (request) => handleUninstallSolomapMcp(context, request.mcpId || ''),
    'project.getAll': async () => {
      if (surface === 'sidebar' && sidebarProvider) {
        sidebarProvider.sendProjects();
      } else {
        await postProjectsLoaded(target, getProjectState(context));
      }
    },
    'project.select': async (request) => selectProject(context, String(request.projectPath || '')),
    'project.add': async () => addProjectFromDialog(context),
    'project.remove': async (request) => removeProject(context, String(request.projectPath || '')),
    'project.updateMetadata': async (request) => updateProjectMetadata(context, String(request.projectPath || ''), {
      name: request.name,
      type: request.projectType,
      priority: request.priority,
      description: request.description,
      notes: request.notes
    }),
    'project.togglePinned': async (request) => toggleProjectPinned(context, String(request.projectPath || '')),
    'project.openRoadmap': async (request) => {
      await selectProject(context, String(request.projectPath || ''));
      await vscode.commands.executeCommand('solopreneur.showRoadmap');
    },
    'project.continue': async (request) => {
      const projectPath = await ensureActionProject(context, String(request.projectPath || ''));
      if (!projectPath) return;
      if (request.nodeId) {
        await handleRunAgent(context, String(request.nodeId), '', '');
      } else {
        await vscode.commands.executeCommand('solopreneur.showRoadmap');
      }
    },
    'issue.getDetails': async (request) => {
      const projectPath = String(request.projectPath || '');
      const issueNumber = Number(request.issueNumber || 0);
      const cached = readCachedIssueDetails(projectPath, issueNumber);
      if (cached) {
        await respond({ command: 'issueDetailsLoaded', projectPath, issueNumber, ...cached });
      }
      await respond({ command: 'issueDetailsLoaded', projectPath, issueNumber, ...readProjectIssueDetails(projectPath, issueNumber) });
    },
    'issue.create': async (request) => {
      const projectPath = String(request.projectPath || '');
      const result = createProjectIssue(
        projectPath,
        String(request.title || '').trim(),
        String(request.body || '').trim(),
        String(request.category || 'discussion'),
        String(request.priority || '')
      );
      await respond({ command: 'issueActionCompleted', projectPath, success: result.ok, message: result.message });
      sendProjectsToWebviews(context);
    },
    'issue.close': async (request) => {
      const projectPath = String(request.projectPath || '');
      const result = closeProjectIssue(projectPath, Number(request.issueNumber || 0));
      await respond({ command: 'issueActionCompleted', projectPath, success: result.ok, message: result.message });
      sendProjectsToWebviews(context);
    },
    'pullRequest.close': async (request) => {
      const projectPath = String(request.projectPath || '');
      const result = closeProjectPullRequest(projectPath, Number(request.pullRequestNumber || 0));
      await respond({ command: 'pullRequestActionCompleted', projectPath, success: result.ok, message: result.message });
      const pullRequests = await loadExternalPullRequestSummary(projectPath, { force: true }).catch(() => null);
      if (pullRequests) await respond({ command: 'projectPullRequestsLoaded', projectPath, pullRequests });
      sendProjectsToWebviews(context);
    },
    'project.refreshExternalData': async (request) => {
      const projectPath = String(request.projectPath || '');
      const [issues, pullRequests, delivery, security, runIndexHealth] = await Promise.all([
        loadExternalIssueSummary(projectPath, { force: true }).catch(() => null),
        loadExternalPullRequestSummary(projectPath, { force: true }).catch(() => null),
        loadExternalDeliverySummary(projectPath, { force: true }).catch(() => null),
        loadExternalSecuritySummary(projectPath, { force: true }).catch(() => null),
        backfillRunIndexFromDigests(projectPath, context.extensionPath).catch((error) => {
          console.error('SoloMap run index backfill failed during project refresh:', error);
          return null;
        })
      ]);
      if (issues) await respond({ command: 'projectIssuesLoaded', projectPath, issues });
      if (pullRequests) await respond({ command: 'projectPullRequestsLoaded', projectPath, pullRequests });
      if (delivery) await respond({ command: 'projectDeliveryLoaded', projectPath, delivery });
      if (security) await respond({ command: 'projectSecurityLoaded', projectPath, security });
      if (runIndexHealth?.backfilledCount) {
        sendLocalProjectsToWebviews(context);
      }
      await respond({
        command: 'projectRefreshCompleted',
        projectPath,
        success: Boolean(issues?.available || pullRequests?.available || delivery?.available || security?.available || runIndexHealth?.ok),
        message: issues?.message || pullRequests?.message || delivery?.message || security?.message || ''
      });
    },
    'project.openFile': async (request) => {
      const projectPath = String(request.projectPath || activeProjectRoot || getSelectedProjectPath(context) || '');
      const relativePath = String(request.relativePath || '');
      if (!projectPath || !relativePath) return;
      const candidatePath = path.resolve(projectPath, relativePath);
      const relativeToRoot = path.relative(projectPath, candidatePath);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return;
      const openedDiff = await openProjectFileDiff(projectPath, relativePath, String(request.gitHash || ''));
      if (openedDiff) return;
      if (fs.existsSync(candidatePath)) {
        const doc = await vscode.workspace.openTextDocument(candidatePath);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    },
    'external.open': async (request) => {
      if (request.url) {
        await vscode.env.openExternal(vscode.Uri.parse(String(request.url)));
      }
    },
    'feedback.open': async (request) => {
      await vscode.env.openExternal(vscode.Uri.parse(buildFeedbackIssueUrl(
        request.title || '',
        request.body || '',
        request.category || '',
        buildFeedbackUsageSummary(context)
      )));
    }
  });
}

function getPersistedSettings(context: vscode.ExtensionContext): SolopreneurSettings {
  const config = vscode.workspace.getConfiguration('solopreneur');
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  const settingsWorkspaceRoot = getSettingsEnhancementWorkspaceRoot();
  const baseSettings = {
    cliPath: saved.cliPath || config.get('cliPath') || 'agy',
    agentModelPreferences: normalizeAgentModelPreferences(saved.agentModelPreferences),
    language: saved.language || config.get('language') || 'zh',
    globalPrompt: saved.globalPrompt ?? config.get('globalPrompt') ?? '',
    globalDataPath: saved.globalDataPath ?? config.get('globalDataPath') ?? '',
    taskPermissionMode: 'auto',
    reviewerCliPath: saved.reviewerCliPath ?? config.get('reviewerCliPath') ?? '',
    collaborationReviewMode: normalizeCollaborationReviewMode(saved.collaborationReviewMode ?? config.get('collaborationReviewMode') ?? 'high_risk'),
    automationTasks: normalizeAutomationSettings(saved.automationTasks ?? config.get('automationTasks') ?? {}),
    proEntitlements: {
      ...(saved.proEntitlements || {}),
      ...readLocalProEntitlements()
    },
    proAccount: normalizeProAccountStatus(saved.proAccount),
    enabledEnhancements: {}
  };
  return {
    ...baseSettings,
    enhancementStatuses: refreshSolomapEnhancementStatusSummaries(settingsWorkspaceRoot, baseSettings.globalDataPath),
    enabledEnhancements: getEnabledEnhancementMap(settingsWorkspaceRoot, baseSettings.globalDataPath),
    skills: readSolomapSkillRegistry(settingsWorkspaceRoot, baseSettings.globalDataPath).skills || [],
    connectors: readSolomapMcpRegistry(settingsWorkspaceRoot, baseSettings.globalDataPath).connectors || []
  };
}

async function clearStoredProAccess(context: vscode.ExtensionContext): Promise<void> {
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  await context.globalState.update(settingsKey, {
    ...saved,
    proEntitlements: clearProEntitlements(saved.proEntitlements || {}),
    proAccount: {
      ...normalizeProAccountStatus(saved.proAccount),
      allowed: false
    }
  });
  await broadcastSettings(context);
}

async function broadcastSettings(context: vscode.ExtensionContext): Promise<void> {
  if (sidebarProvider) {
    sidebarProvider.sendSettings();
  }
  if (activePanel) {
    postSettingsLoaded(activePanel.webview, getSettingsWithRuntimeState(context));
    if (activeProjectRoot) {
      postFlowStateLoaded(activePanel.webview, buildFlowStatePayload(activeProjectRoot, await hasFlowModeAccess(context)));
    }
  }
}

async function postFlowStateToWebview(context: vscode.ExtensionContext): Promise<void> {
  if (!activePanel || !activeProjectRoot) {
    return;
  }
  postFlowStateLoaded(activePanel.webview, buildFlowStatePayload(activeProjectRoot, await hasFlowModeAccess(context)));
}

function buildPassportCallbackUri(): string {
  const scheme = vscode.env.uriScheme || 'vscode';
  return `${scheme}://SZLK.solopreneur-roadmap/passport/callback`;
}

function buildPassportStartUrl(callbackUri = buildPassportCallbackUri()): string {
  return buildPassportProUrl('callback', createPassportAuthNonce(), callbackUri);
}

function verifyPassportGrant(grant: string, options: { authNonce?: string | null; callbackUri?: string | null; deviceCode?: string | null } = {}): Promise<PassportVerifyResult> {
  return verifyPassportGrantWithFetch(grant, { ...options, fetcher: fetch });
}

async function readPassportGrant(context: vscode.ExtensionContext): Promise<PassportGrantCache | null> {
  try {
    const raw = await context.secrets.get(passportGrantSecretKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PassportGrantCache;
    if (!parsed || !parsed.grant) return null;
    return parsed;
  } catch (error) {
    console.warn('Failed to read SoloMap Pro grant:', error);
    return null;
  }
}

async function writePassportGrant(context: vscode.ExtensionContext, result: PassportVerifyResult, grant: string): Promise<void> {
  const payload: PassportGrantCache = {
    grant,
    email: String(result.email || ''),
    userId: String(result.userId || ''),
    entitlements: Array.isArray(result.entitlements) ? result.entitlements.map((item) => String(item || '')).filter(Boolean) : [],
    deviceLimit: Number(result.deviceLimit || 0) || undefined,
    expiresAt: String(result.expiresAt || new Date(Date.now() + passportGrantOfflineGraceMs).toISOString()),
    checkedAt: new Date().toISOString()
  };
  await context.secrets.store(passportGrantSecretKey, JSON.stringify(payload));
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  await context.globalState.update(settingsKey, {
    ...saved,
    proEntitlements: {
      ...(saved.proEntitlements || {}),
      pro: true,
      solomap_pro: true,
      [strategyPyramidFeature]: true
    },
    proAccount: buildProAccountStatus(result)
  });
  await broadcastSettings(context);
}

async function hasStrategyPyramidAccess(context: vscode.ExtensionContext): Promise<boolean> {
  const settings = getPersistedSettings(context);
  if (hasProEntitlement(settings, 'strategyPyramid')) {
    return true;
  }
  const cached = await readPassportGrant(context);
  if (!cached) {
    return false;
  }
  const verified = await verifyPassportGrant(cached.grant);
  if (verified.allowed) {
    await writePassportGrant(context, verified, cached.grant);
    return true;
  }
  if (grantContainsFeature(cached)) {
    return true;
  }
  await clearStoredProAccess(context);
  return false;
}

async function hasFlowModeAccess(context: vscode.ExtensionContext): Promise<boolean> {
  const settings = getPersistedSettings(context);
  if (hasProEntitlement(settings, flowModeFeature)) {
    return true;
  }
  const cached = await readPassportGrant(context);
  if (!cached) {
    return false;
  }
  const verified = await verifyPassportGrant(cached.grant);
  if (verified.allowed) {
    await writePassportGrant(context, verified, cached.grant);
    return true;
  }
  if (grantContainsFeature(cached)) {
    return true;
  }
  await clearStoredProAccess(context);
  return false;
}

async function refreshProAccountStatus(context: vscode.ExtensionContext): Promise<void> {
  if (Object.keys(readLocalProEntitlements()).length > 0) {
    await broadcastSettings(context);
    return;
  }
  const cached = await readPassportGrant(context);
  if (!cached) {
    if (!hasProEntitlement(getPersistedSettings(context), 'strategyPyramid')) {
      await clearStoredProAccess(context);
    }
    return;
  }
  const verified = await verifyPassportGrant(cached.grant);
  if (verified.allowed) {
    await writePassportGrant(context, verified, cached.grant);
    return;
  }
  if (!grantContainsFeature(cached)) {
    await clearStoredProAccess(context);
    return;
  }
  await broadcastSettings(context);
}

async function beginPassportAuthorization(): Promise<void> {
  const authNonce = createPassportAuthNonce();
  pendingPassportAuthNonce = authNonce;
  await vscode.env.openExternal(vscode.Uri.parse(buildPassportProUrl('callback', authNonce, buildPassportCallbackUri())));
}

async function beginPassportDeviceAuthorization(context: vscode.ExtensionContext): Promise<void> {
  const authNonce = createPassportAuthNonce();
  pendingPassportAuthNonce = authNonce;

  await vscode.env.openExternal(vscode.Uri.parse(buildPassportProUrl('device', authNonce)));
  const code = await vscode.window.showInputBox({
    title: 'SoloMap Pro',
    prompt: '登录完成后，粘贴网页上显示的授权码。',
    placeHolder: '粘贴授权码',
    ignoreFocusOut: true
  });
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return;
  }
  try {
    const result = await verifyPassportGrant(normalizedCode, { authNonce });
    if (!result.allowed) {
      vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
      return;
    }
    pendingPassportAuthNonce = null;
    await writePassportGrant(context, result, result.grant || normalizedCode);
    vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
    await openStrategyPyramidPanel(context);
  } catch (error) {
    console.warn('Failed to verify SoloMap Pro device authorization:', error);
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
  }
}

async function pastePassportAuthorizationCode(context: vscode.ExtensionContext): Promise<void> {
  const code = await vscode.window.showInputBox({
    title: 'SoloMap Pro',
    prompt: '粘贴网页上显示的授权码。',
    placeHolder: '授权码',
    ignoreFocusOut: true
  });
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return;
  }
  const result = await verifyPassportGrant(normalizedCode);
  if (!result.allowed) {
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
    return;
  }
  await writePassportGrant(context, result, result.grant || normalizedCode);
  vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
}

async function beginPassportAuthorizationFlow(context: vscode.ExtensionContext): Promise<void> {
  const isRemoteEnvironment = Boolean((vscode.env as any).remoteName);
  const callbackLabel = '浏览器回到 VS Code';
  const deviceLabel = '使用登录码';
  const message = isRemoteEnvironment
    ? '当前环境可能无法接收浏览器回调，请使用登录码完成 SoloMap Pro 登录。'
    : '选择 SoloMap Pro 登录方式。';
  const firstChoice = isRemoteEnvironment ? deviceLabel : callbackLabel;
  const secondChoice = isRemoteEnvironment ? callbackLabel : deviceLabel;
  const choice = await vscode.window.showInformationMessage(message, firstChoice, secondChoice);
  if (choice === deviceLabel) {
    await beginPassportDeviceAuthorization(context);
    return;
  }
  if (choice === callbackLabel) {
    await beginPassportAuthorization();
  }
}

async function handleManageProAuthorization(context: vscode.ExtensionContext, action?: string): Promise<void> {
  const normalizedAction = String(action || '').trim();
  if (normalizedAction === 'login') {
    await beginPassportAuthorizationFlow(context);
    return;
  }
  if (normalizedAction === 'paste') {
    await pastePassportAuthorizationCode(context);
    return;
  }
  const loginLabel = '登录 / 升级 Pro';
  const pasteLabel = '粘贴授权码';
  const choice = await vscode.window.showInformationMessage('管理 SoloMap Pro 授权。', loginLabel, pasteLabel);
  if (choice === loginLabel) {
    await beginPassportAuthorizationFlow(context);
    return;
  }
  if (choice === pasteLabel) {
    await pastePassportAuthorizationCode(context);
  }
}

async function handlePassportUri(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
  const pathValue = `${uri.authority || ''}${uri.path || ''}`;
  if (!pathValue.includes('passport/callback')) {
    return;
  }
  const params = new URLSearchParams(uri.query || '');
  const grant = String(params.get('code') || params.get('grant') || '').trim();
  if (!grant) {
    vscode.window.showWarningMessage('没有收到 SoloMap Pro 授权结果。');
    return;
  }
  const callbackUri = buildPassportCallbackUri();
  const result = await verifyPassportGrant(grant, {
    authNonce: pendingPassportAuthNonce,
    callbackUri
  });
  if (!result.allowed) {
    vscode.window.showWarningMessage('SoloMap Pro 授权未通过。');
    return;
  }
  pendingPassportAuthNonce = null;
  await writePassportGrant(context, result, result.grant || grant);
  vscode.window.showInformationMessage('SoloMap Pro 已解锁。');
  await openStrategyPyramidPanel(context);
}

function getSettingsEnhancementWorkspaceRoot(): string {
  return activeProjectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function normalizeCollaborationReviewMode(value: unknown): string {
  return ['off', 'high_risk', 'all'].includes(String(value || '')) ? String(value) : 'high_risk';
}

function normalizeEnabledEnhancements(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>((acc, [key, enabled]) => {
    const normalizedKey = String(key || '').trim();
    if (normalizedKey) {
      acc[normalizedKey] = Boolean(enabled);
    }
    return acc;
  }, {});
}

function normalizeAutomationTriggerSettings(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawTime = String(source.timeOfDay || '').trim();
  const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : '09:00';
  return {
    notify: Boolean(source.notify),
    sound: Boolean(source.sound),
    retry: Boolean(source.retry),
    prompt: String(source.prompt || '').trim(),
    timeOfDay
  };
}

function normalizeScheduledAutomationTask(value: unknown, index: number): SolomapScheduledAutomationTask | null {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = String(source.id || '').trim() || `scheduled-${index + 1}`;
  const rawTime = String(source.timeOfDay || '').trim();
  const prompt = String(source.prompt || '').trim();
  const title = String(source.title || '').trim();
  const projectPath = String(source.projectPath || '').trim();
  const projectName = String(source.projectName || '').trim();
  const enabled = Object.prototype.hasOwnProperty.call(source, 'enabled') ? Boolean(source.enabled) : Boolean(prompt);
  return {
    id,
    title,
    enabled,
    projectPath,
    projectName,
    timeOfDay: /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : '09:00',
    prompt
  };
}

function normalizeScheduledAutomationTasks(source: Record<string, unknown>, rawTriggers: Record<string, unknown>): SolomapScheduledAutomationTask[] {
  if (Array.isArray(source.scheduledTasks)) {
    return source.scheduledTasks
      .map((task, index) => normalizeScheduledAutomationTask(task, index))
      .filter((task): task is SolomapScheduledAutomationTask => Boolean(task));
  }
  const legacy = normalizeAutomationTriggerSettings(rawTriggers.scheduled_time);
  if (legacy.prompt) {
    return [{
      id: 'scheduled-default',
      title: '',
      enabled: true,
      timeOfDay: legacy.timeOfDay,
      prompt: legacy.prompt
    }];
  }
  return [];
}

function firstScheduledTaskAsTrigger(tasks: SolomapScheduledAutomationTask[], fallback: unknown) {
  const first = tasks[0];
  if (!first) {
    return normalizeAutomationTriggerSettings(fallback);
  }
  return normalizeAutomationTriggerSettings({
    notify: false,
    sound: false,
    retry: false,
    prompt: first.prompt || '',
    timeOfDay: first.timeOfDay || '09:00'
  });
}

function normalizeAutomationSettings(value: unknown): SolomapAutomationSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawTriggers = source.triggers && typeof source.triggers === 'object'
    ? source.triggers as Record<string, unknown>
    : {};
  const focusMinutes = Math.max(1, Math.min(240, Number(source.focusMinutes || 25) || 25));
  const scheduledTasks = normalizeScheduledAutomationTasks(source, rawTriggers);
  return {
    focusMinutes,
    scheduledTasks,
    triggers: {
      completed: normalizeAutomationTriggerSettings(rawTriggers.completed),
      failed: normalizeAutomationTriggerSettings(rawTriggers.failed),
      stopped: normalizeAutomationTriggerSettings(rawTriggers.stopped),
      focus_time: normalizeAutomationTriggerSettings(rawTriggers.focus_time),
      scheduled_time: firstScheduledTaskAsTrigger(scheduledTasks, rawTriggers.scheduled_time)
    }
  };
}

function mergeAutomationSettings(currentValue: unknown, nextValue: unknown): SolomapAutomationSettings {
  const current = normalizeAutomationSettings(currentValue);
  if (!nextValue || typeof nextValue !== 'object') {
    return current;
  }
  const currentTriggers = current.triggers || {};
  const source = nextValue as Record<string, unknown>;
  const nextTriggers = source.triggers && typeof source.triggers === 'object'
    ? source.triggers as Record<string, unknown>
    : {};
  const nextNormalized = normalizeAutomationSettings(source);
  const scheduledTasks = Object.prototype.hasOwnProperty.call(source, 'scheduledTasks')
    ? nextNormalized.scheduledTasks || []
    : Object.prototype.hasOwnProperty.call(nextTriggers, 'scheduled_time')
      ? nextNormalized.scheduledTasks || []
      : current.scheduledTasks || [];
  return {
    focusMinutes: Object.prototype.hasOwnProperty.call(source, 'focusMinutes')
      ? normalizeAutomationSettings(source).focusMinutes
      : current.focusMinutes,
    scheduledTasks,
    triggers: {
      completed: Object.prototype.hasOwnProperty.call(nextTriggers, 'completed') ? normalizeAutomationTriggerSettings(nextTriggers.completed) : normalizeAutomationTriggerSettings(currentTriggers.completed),
      failed: Object.prototype.hasOwnProperty.call(nextTriggers, 'failed') ? normalizeAutomationTriggerSettings(nextTriggers.failed) : normalizeAutomationTriggerSettings(currentTriggers.failed),
      stopped: Object.prototype.hasOwnProperty.call(nextTriggers, 'stopped') ? normalizeAutomationTriggerSettings(nextTriggers.stopped) : normalizeAutomationTriggerSettings(currentTriggers.stopped),
      focus_time: Object.prototype.hasOwnProperty.call(nextTriggers, 'focus_time') ? normalizeAutomationTriggerSettings(nextTriggers.focus_time) : normalizeAutomationTriggerSettings(currentTriggers.focus_time),
      scheduled_time: firstScheduledTaskAsTrigger(scheduledTasks, Object.prototype.hasOwnProperty.call(nextTriggers, 'scheduled_time') ? nextTriggers.scheduled_time : currentTriggers.scheduled_time)
    }
  };
}

function getSettingsWithRuntimeState(context: vscode.ExtensionContext): SolopreneurSettings {
  const settings = getPersistedSettings(context);
  const automationTasks = normalizeAutomationSettings(settings.automationTasks || {});
  return {
    ...settings,
    automationTasks: {
      ...automationTasks,
      nextFocusReminderAt: focusReminderNextAt,
      nextScheduledTaskAt: scheduledAutomationNextAt
    }
  };
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: Partial<SolopreneurSettings>): Promise<void> {
  const currentSettings = getPersistedSettings(context);
  const hasSetting = (key: keyof SolopreneurSettings) => (
    Object.prototype.hasOwnProperty.call(settings, key)
    && settings[key] !== undefined
  );
  const nextGlobalDataPath = hasSetting('globalDataPath')
    ? String(settings.globalDataPath ?? '').trim()
    : String(currentSettings.globalDataPath ?? '').trim();
  const nextSettings: SolopreneurSettings = {
    cliPath: hasSetting('cliPath') ? (String(settings.cliPath || '').trim() || 'agy') : (currentSettings.cliPath || 'agy'),
    agentModelPreferences: mergeAgentModelPreferences(currentSettings.agentModelPreferences, hasSetting('agentModelPreferences') ? settings.agentModelPreferences : undefined),
    language: hasSetting('language') ? (settings.language === 'en' ? 'en' : 'zh') : (currentSettings.language === 'en' ? 'en' : 'zh'),
    globalPrompt: hasSetting('globalPrompt') ? String(settings.globalPrompt ?? '').trim() : String(currentSettings.globalPrompt ?? '').trim(),
    globalDataPath: nextGlobalDataPath,
    taskPermissionMode: 'auto',
    reviewerCliPath: hasSetting('reviewerCliPath') ? String(settings.reviewerCliPath ?? '').trim() : String(currentSettings.reviewerCliPath ?? '').trim(),
    collaborationReviewMode: normalizeCollaborationReviewMode(hasSetting('collaborationReviewMode') ? settings.collaborationReviewMode : currentSettings.collaborationReviewMode),
    automationTasks: hasSetting('automationTasks')
      ? mergeAutomationSettings(currentSettings.automationTasks, settings.automationTasks)
      : normalizeAutomationSettings(currentSettings.automationTasks),
    proEntitlements: currentSettings.proEntitlements || {},
    proAccount: currentSettings.proAccount,
    enabledEnhancements: getEnabledEnhancementMap(getSettingsEnhancementWorkspaceRoot(), nextGlobalDataPath)
  };
  await context.globalState.update(settingsKey, nextSettings);

  const config = vscode.workspace.getConfiguration('solopreneur');
  await config.update('cliPath', nextSettings.cliPath, vscode.ConfigurationTarget.Global);
  await config.update('language', nextSettings.language, vscode.ConfigurationTarget.Global);
  await config.update('globalPrompt', nextSettings.globalPrompt, vscode.ConfigurationTarget.Global);
  await config.update('globalDataPath', nextSettings.globalDataPath, vscode.ConfigurationTarget.Global);
  await config.update('reviewerCliPath', nextSettings.reviewerCliPath, vscode.ConfigurationTarget.Global);
  await config.update('collaborationReviewMode', nextSettings.collaborationReviewMode, vscode.ConfigurationTarget.Global);
  await config.update('automationTasks', nextSettings.automationTasks, vscode.ConfigurationTarget.Global);
  scheduleFocusReminder(context);
  scheduleTimedAutomationTask(context);
}

function projectName(projectPath: string): string {
  return registryProjectName(projectPath);
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function normalizeGlobalDataPathForExtension(rawPath: string): string {
  return normalizeGlobalDataPathForRegistry(rawPath, getWorkspaceRoot());
}

function getProjectRegistryPath(context: vscode.ExtensionContext): string {
  return path.join(normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath), projectRegistryFileName);
}

function normalizeProjectsForStorage(projects: SolopreneurProject[]): SolopreneurProject[] {
  return normalizeProjectsForRegistryStorage(projects);
}

function readProjectRegistry(context: vscode.ExtensionContext): ProjectRegistryFile | null {
  return readProjectRegistryFile(getPersistedSettings(context).globalDataPath, projectRegistryFileName);
}

function writeProjectRegistry(context: vscode.ExtensionContext, projects: SolopreneurProject[], hiddenProjects: string[]): void {
  writeProjectRegistryFile(getPersistedSettings(context).globalDataPath, projectRegistryFileName, projects, hiddenProjects);
}

function getHiddenProjects(context: vscode.ExtensionContext): string[] {
  return getHiddenProjectsFromRegistry({
    globalDataPath: getPersistedSettings(context).globalDataPath,
    projectRegistryFileName,
    legacyHiddenProjects: context.globalState.get<string[]>(hiddenProjectsKey) || []
  });
}

function getProjects(context: vscode.ExtensionContext): SolopreneurProject[] {
  return getProjectsFromRegistry({
    globalDataPath: getPersistedSettings(context).globalDataPath,
    projectRegistryFileName,
    legacyProjects: context.globalState.get<SolopreneurProject[]>(projectsKey) || [],
    legacyHiddenProjects: context.globalState.get<string[]>(hiddenProjectsKey) || [],
    workspaceRoot: getWorkspaceRoot()
  });
}

function getSelectedProjectPath(context: vscode.ExtensionContext): string {
  return getSelectedProjectPathFromRegistry(
    getProjects(context),
    context.globalState.get<string>(selectedProjectKey) || ''
  );
}

function getProjectState(context: vscode.ExtensionContext): { projects: SolopreneurProject[]; selectedProjectPath: string } {
  const projects = getProjects(context);
  return {
    projects,
    selectedProjectPath: getSelectedProjectPathFromRegistry(projects, context.globalState.get<string>(selectedProjectKey) || '')
  };
}
function getLocalUsageStatsOptions(context: vscode.ExtensionContext) {
  return {
    globalDataPath: getPersistedSettings(context).globalDataPath,
    usageStatsFileName,
    projects: getProjects(context)
  };
}

function recordLocalUsageEvent(context: vscode.ExtensionContext, event: LocalUsageEvent): LocalUsageStats {
  return recordLocalUsageEventInStats(context, getLocalUsageStatsOptions(context), event);
}

function buildFeedbackUsageSummary(context: vscode.ExtensionContext): string {
  return buildFeedbackUsageSummaryFromStats(context, getLocalUsageStatsOptions(context));
}
async function saveProjects(context: vscode.ExtensionContext, projects: SolopreneurProject[]): Promise<void> {
  const normalizedProjects = normalizeProjectsForStorage(projects);
  writeProjectRegistry(context, normalizedProjects, getHiddenProjects(context));
  await context.globalState.update(projectsKey, normalizedProjects);
}

async function setProjectHidden(context: vscode.ExtensionContext, projectPath: string, hidden: boolean): Promise<void> {
  const hiddenProjects = new Set(getHiddenProjects(context));
  if (hidden) {
    hiddenProjects.add(projectPath);
  } else {
    hiddenProjects.delete(projectPath);
  }
  writeProjectRegistry(context, getProjects(context), [...hiddenProjects]);
  await context.globalState.update(hiddenProjectsKey, [...hiddenProjects]);
}

async function selectProject(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  if (!projects.some((project) => project.path === projectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }

  await context.globalState.update(selectedProjectKey, projectPath);
  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  syncEngineInitPromise = null;
  syncEngineInitProjectRoot = '';
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }
  sendLocalProjectsToWebviews(context);
  if (activePanel) {
    postWebviewMessage(activePanel.webview, { command: 'roadmapLoading', projectPath });
  }
  scheduleProjectRunIndexBackfill(context, projectPath);
  void ensureSyncEngine(context).then((ready) => {
    if (ready && getSelectedProjectPath(context) === projectPath && activeProjectRoot === projectPath) {
      sendNodesToWebview();
      void postFlowStateToWebview(context);
    }
  });
}

function scheduleProjectRunIndexBackfill(context: vscode.ExtensionContext, projectPath: string): void {
  if (!projectPath) {
    return;
  }
  setTimeout(() => {
    void (async () => {
      try {
        const health = await backfillRunIndexFromDigests(projectPath, context.extensionPath);
        if (health.backfilledCount > 0 && getSelectedProjectPath(context) === projectPath) {
          sendLocalProjectsToWebviews(context);
        }
      } catch (error) {
        console.error('SoloMap run index backfill failed for selected project:', error);
      }
    })();
  }, 0);
}

async function updateProjectMetadata(context: vscode.ExtensionContext, projectPath: string, updates: Partial<Pick<SolopreneurProject, 'name' | 'type' | 'priority' | 'description' | 'notes'>>): Promise<void> {
  const projects = getProjects(context);
  const nextProjects = projects.map((project) => {
    if (project.path !== projectPath) {
      return project;
    }
    return {
      ...project,
      ...(updates.name !== undefined ? { name: String(updates.name || projectName(project.path || '')) } : {}),
      ...(updates.type !== undefined ? { type: String(updates.type || '') } : {}),
      ...(updates.priority !== undefined ? { priority: String(updates.priority || '') } : {}),
      ...(updates.description !== undefined ? { description: String(updates.description || '') } : {}),
      ...(updates.notes !== undefined ? { notes: String(updates.notes || '') } : {})
    };
  });
  await saveProjects(context, nextProjects);
  sendLocalProjectsToWebviews(context);
}

async function toggleProjectPinned(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  if (!projects.some((project) => project.path === projectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }
  const nextProjects = projects.map((project) => {
    if (project.path !== projectPath) {
      return project;
    }
    const { pinnedAt, ...rest } = project;
    return pinnedAt ? rest : { ...project, pinnedAt: new Date().toISOString() };
  });
  await saveProjects(context, nextProjects);
  sendLocalProjectsToWebviews(context);
}

function buildSolopreneurDirectoryReadme(): string {
  return [
    '# SoloMap Project Data',
    '',
    '这个目录由 SoloMap 自动创建，用来保存当前项目的路线图、Agent 对话记录、执行日志和环节交接总结。',
    '',
    '## 为什么数据放在项目里',
    '',
    '- 项目数据跟随项目文件夹走，不依赖插件后端服务。',
    '- 换一台机器、换一个 IDE、重新安装插件后，只要项目文件还在，SoloMap 就能重新加载这些数据。',
    '- 这个目录可以交给 Git/GitHub 管理，让路线图、交接总结和执行记录成为项目历史的一部分。',
    '',
    '## 主要文件',
    '',
    '- `roadmap.csv`：路线图主数据，包括环节、依赖、状态和 Agent prompt。',
    '- `step-memory/`：每个路线图环节的 JSON 完成标准和交接总结。下一轮 Agent 对话会读取这里的结构化上下文。',
    '- `step-sessions/`：每个路线图环节按 Agent 保存原生会话 ID。后续对话会把这些会话 ID 作为可选参考交给 Agent，而不是强制续接。',
    '- `documentation.json`：项目解释性文档的索引与审计状态。它由 SoloMap 维护，用来帮助 Agent 优先更新正确文档并识别文档噪音。',
    '- `project_journal.db`：本地 SQLite 执行日志，保存更完整的 Agent 对话和历史记录。',
    '- `agent-runs/`：每次 Agent 调用的输出、文件变更摘要和完成判断。',
    '- `run-digests/`：每次 Agent 调用结束后的结构化执行摘要和跨 Agent 交接信号。下一轮相关任务会读取少量摘要来减少重复探索。',
    '- `execution-graph.json`：由 run digest 自动生成的轻量索引，按环节、Agent、文件、状态、失败和命令组织最近执行信号。',
    '- `.agent_status.json`：临时运行状态文件，通常会被插件自动清理。',
    '',
    '## 请不要随意删除',
    '',
    '删除这个目录会导致 SoloMap 无法恢复该项目的路线图、状态、对话历史和环节交接总结。需要清理体积时，优先只清理 `agent-runs/` 中很旧的运行记录，并保留 `roadmap.csv` 和 `step-memory/`。',
    '',
    '## Git 建议',
    '',
    '如果你希望项目在多台机器或多个 IDE 间保持一致，可以把 `.solopreneur/` 提交到 Git。这样 SoloMap 的项目上下文会跟项目代码一起迁移。'
  ].join('\n');
}

function buildBootstrapRoadmapInstructions(cliPath: string): string {
  return [
    '# Bootstrap Roadmap Instructions',
    '',
    '你当前的任务是为这个项目生成真正可执行的定制化路线图，并直接重写 `.solopreneur/roadmap.csv`。',
    '',
    '## 必做前置阅读',
    '- 阅读当前项目目录中的 README、docs、源码入口以及 `.solopreneur/README.md`（如果存在）。',
    '- 阅读 `.solopreneur/roadmap-methodology.md`，按项目真实目标选择适用的推进框架。',
    '- 理解这个项目当前要交付什么、服务谁、是否需要对外获客或销售，以及当前文件里已经有哪些线索。',
    '',
    '## 项目类别与路线图形态规范（核心精髓）',
    '你必须首先根据当前项目的文件和描述，准确判断项目属于以下 6 个类别中的哪一个，并严格按照该类别的推进精髓和完成标准生成定制路线图：',
    '',
    '1. **核心产品类 (Core Product)**',
    '   - 定义：面向外部用户、需获客和转化、强调商业化或影响力闭环。',
    '   - 初始阶段：`问题与客户发现` -> `产品与 MVP` -> `营销与销售` -> `反馈与规模化`。',
    '   - 核心任务：不可退化为纯工程任务，必须覆盖官网/定位/获客转化、反馈收集、以及 Build->Sell->Learn->Improve 的持续改进循环。',
    '',
    '2. **基础设施类 (Infrastructure)**',
    '   - 定义：被 3+ 个其他项目依赖的公共层，变更影响面大，稳定性与版本管理第一。',
    '   - 初始阶段：`能力设计` -> `核心实现` -> `标准化` -> `验证` -> `治理` -> `运维`。',
    '   - 核心任务：定义明确的接入规范与契约、编写接入文档与示例、找业务项目作为首个消费者进行真实验证、设计语义化版本管理和向后兼容迁移路径、部署运行监控。',
    '',
    '3. **内容产品类 (Content Product)**',
    '   - 定义：小说连载、周刊、定期报告、数据分析、视频系列等以内容为核心交付物的项目。',
    '   - 初始阶段：`内容规划` -> `工程化` -> `生产` -> `分发` -> `改进` -> `运维`。',
    '   - 核心任务：明确受众与周期性发布节奏、设计工程化与自动化生产工作流、建设 2+ 分发渠道、收集互动反馈。',
    '',
    '4. **试验和研究类 (Experiment & Research)**',
    '   - 定义：快速试错，验证新技术栈或想法假设，成功的定义是学到了什么、验证了什么。',
    '   - 初始阶段：`目标确认` -> `原型开发` -> `评估` -> `总结`。',
    '   - 核心任务：约束较短的时间点（通常 2-4 周）、明确需验证的假设或技术点、允许结果失败、最终必须将成功/失败的知识结论总结沉淀。',
    '',
    '5. **工具和脚手架类 (Tools & Scaffolding)**',
    '   - 定义：为了减少重复工作，提升自己或团队效率的工具、脚本、框架或模板。',
    '   - 初始阶段：`需求确认` -> `开发` -> `文档` -> `验证` -> `维护`。',
    '   - 核心任务：明确使用场景及价值、实现核心功能、编写极简的集成与使用指南（使接入成本 <30 分钟）、在 2+ 真实项目中测试验证。',
    '',
    '6. **归档和维护类 (Archive & Maintenance)**',
    '   - 定义：已上线、相对稳定、不需要频繁加功能、追求无人值守保持健康的项目。',
    '   - 初始阶段：`评估` -> `建设` -> `维护` -> `文档` -> `流程建设`。',
    '   - 核心任务：评估健康状况、补齐缺少的监控与告警体系、更新维护指南（确保新维护者快速上手）、升级依赖安全漏洞、设计自动化定期检查。',
    '',
    '## 你的唯一交付物',
    '- 直接重写 `.solopreneur/roadmap.csv`。',
    '- 不要只在终端输出路线图建议。',
    '- 不要把本文件内容、提示词模板或解释性说明写回 CSV。',
    '',
    '## CSV 硬约束',
    '1. 保留 CSV 表头，字段顺序必须严格是：`id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`。',
    '2. 生成 2 到 8 个环节，数量应服从上述选定类别的真实交付路径，不为套模板而虚构任务。',
    '3. 标题、描述、agentPrompt 全部使用中文。',
    '4. `stage` 填入上述相应类别中指定的推进阶段名称。',
    `5. 每一行 \`agentCli\` 都写 \`${cliPath}\`。`,
    '6. `dependencies` 必须反映真实前置关系；第一个环节留空，后续依赖前面环节的 id。',
    '7. `status` 全部写 `Pending`，`completedAt` 留空，`createdAt` 写当前 ISO 时间。',
    '8. 每个 `agentPrompt` 都必须具体且可落地，要求后续 Agent 创建或修改本地文件、页面或配置，并配置好最窄验证（例如测试/运行命令），禁止产出空泛务虚的规划或咨询报告任务。',
    '',
    '## 结束前自检',
    '- 重新读取 `.solopreneur/roadmap.csv`。',
    '- 必须运行 `node .solopreneur/validate-roadmap.cjs --mode bootstrap` 校验最终路线图。',
    '- 如果校验失败，按终端输出修正 `.solopreneur/roadmap.csv` 后重新运行，直到通过。',
    '- 只有校验通过后，才允许在最终回复中说明任务完成。',
    '- 确认 CSV 中没有残留“生成初始路线图”、本文件原文或提示词模板。'
  ].join('\n');
}

function buildRoadmapValidationScript(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
const bootstrapMarkers = [
  '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
  '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
  '保留 CSV 表头且字段顺序必须严格是',
  '生成初始路线图',
  '.solopreneur/bootstrap-roadmap-instructions.md',
  '不要把本文件内容、提示词模板或解释性说明写回 CSV'
];

function parseArgs(argv) {
  const args = { mode: 'revision' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode' && argv[index + 1]) {
      args.mode = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (inQuotes) {
    throw new Error('CSV 引号未闭合。');
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmptyRows = rows.filter((candidate) => candidate.some((value) => String(value || '').trim()));
  if (!nonEmptyRows.length) {
    return { fields: [], data: [] };
  }
  const fields = nonEmptyRows[0].map((field) => String(field || '').trim());
  return {
    fields,
    data: nonEmptyRows.slice(1).map((values) => {
      const entry = {};
      fields.forEach((field, index) => {
        entry[field] = values[index] === undefined ? '' : values[index];
      });
      return entry;
    })
  };
}

function normalizeNodes(data) {
  return data.map((node) => ({
    id: String(node.id || '').trim(),
    title: String(node.title || '').trim(),
    description: String(node.description || '').trim(),
    stage: String(node.stage || '').trim(),
    dependencies: String(node.dependencies || '').trim(),
    agentCli: String(node.agentCli || '').trim(),
    agentPrompt: String(node.agentPrompt || '').trim(),
    status: String(node.status || '').trim()
  })).filter((node) => node.id);
}

function fail(reason) {
  console.error('FAIL roadmap validation: ' + reason);
  process.exit(1);
}

function pass(mode, count) {
  console.log('PASS roadmap validation: ' + mode + ' (' + count + ' steps)');
}

function validateCommon(fields, nodes, label) {
  if (requiredColumns.some((field) => !fields.includes(field))) {
    fail(label + ' roadmap.csv 格式不完整。字段必须包含：' + requiredColumns.join(', '));
  }
  if (!nodes.length) {
    fail(label + '路线图没有可执行环节。');
  }
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    fail(label + '路线图存在重复环节 ID。');
  }
  if (nodes.some((node) => !node.title || !node.stage || !node.description || !node.agentPrompt)) {
    fail(label + '路线图存在缺少标题、阶段、描述或 Agent 任务的环节。');
  }
  for (const node of nodes) {
    const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
      fail(label + '路线图存在无效依赖关系。');
    }
  }
}

function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (!['bootstrap', 'revision'].includes(mode)) {
    fail('未知 mode：' + mode + '。请使用 --mode bootstrap 或 --mode revision。');
  }
  const roadmapPath = path.join(process.cwd(), '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    fail('未找到 .solopreneur/roadmap.csv。');
  }
  let parsed;
  try {
    parsed = parseCsv(fs.readFileSync(roadmapPath, 'utf8'));
  } catch (error) {
    fail('roadmap.csv 无法解析：' + (error && error.message ? error.message : error));
  }
  const nodes = normalizeNodes(parsed.data);
  validateCommon(parsed.fields, nodes, mode === 'bootstrap' ? '生成后的' : '调整后的');
  if (mode === 'bootstrap') {
    if (nodes.length < 2 || nodes.length > 8) {
      fail('生成后的路线图环节数量不在 2 到 8 个之间。');
    }
    if (nodes.some((node) => node.status !== 'Pending')) {
      fail('生成后的路线图所有环节都必须回到 Pending。');
    }
    if (nodes.some((node) => bootstrapMarkers.some((marker) => node.title.includes(marker) || node.agentPrompt.includes(marker)))) {
      fail('生成后的 roadmap.csv 仍然残留了初始化提示词，没有真正写成业务路线图。');
    }
    if (nodes.some((node) => node.title === '生成初始路线图')) {
      fail('生成后的路线图仍然保留了原始 bootstrap 节点。');
    }
  } else {
    const allowedStatuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
    if (nodes.some((node) => !allowedStatuses.has(node.status))) {
      fail('调整后的路线图存在无法识别的环节状态。');
    }
  }
  pass(mode, nodes.length);
}

main();
`;
}

function buildRoadmapMethodologyInstructions(): string {
  return [
    '# SoloMap Roadmap Methodology',
    '',
    'SoloMap 路线图不是普通任务清单。它应先匹配项目真实要达成的结果，再给出可执行的推进路径。',
    '',
    '```text',
    '目标与对象 -> 可验证交付 -> 真实结果反馈 -> 下一轮改进',
    '```',
    '',
    '## 商业化产品的默认四阶段',
    '',
    '当项目面向外部用户，并需要获得采用、付费或市场验证时，默认覆盖以下四阶段：',
    '',
    '1. `问题与客户发现`：明确值得解决的问题、目标用户、验证方式和第一步行动。',
    '2. `产品与 MVP`：把问题转成可运行、可验证的产品切片，包括需求、架构、数据、测试、部署或维护。',
    '3. `营销与销售`：让产品被发现、理解、信任并产生转化，包括品牌、官网、发布、销售或需求生成。',
    '4. `反馈与规模化`：建立 Build -> Sell -> Learn -> Improve 循环，包括数据、客户反馈、支持、单位经济模型或扩张机会。',
    '',
    '## 不应强行套用四阶段的情况',
    '',
    '- 内部工具、基础设施、迁移、合规修复、研究验证或内容交付等项目，如果目标不包含对外获客或销售，就按其真实交付与验收路径安排阶段。',
    '- 不要为了满足模板，为不存在的客户、营销、销售或规模化目标创造任务。',
    '- 如果项目证据不足以判断是否需要商业化路径，在路线图中先安排澄清目标与成功标准的可交付动作，而不是擅自套用。',
    '',
    '## 所有路线图的共同底线',
    '',
    '- 阶段名称和任务应服务项目实际结果，不服务固定模板。',
    '- 对确实需要用户采用、获客或转化的产品，不要把路线图退化成只写代码的工程任务。',
    '- Build -> Sell -> Learn -> Improve 是底层判断模型，不是让用户手工维护的表单、说明页或侧边栏大组件。',
    '- 用四阶段判断项目是否失衡，并把结果转成明确的下一步动作。',
    '- 不要只生成研究、分析、规划这类无本地交付物的任务。',
    '- 每个环节都必须能通过 Agent 对话推进，并产生本地文件、验证结果、市场材料或反馈记录。',
    '- 每个环节都必须能被完成标准判断：交付物是什么、证据在哪里、是否还需要下一轮推进。',
    '- 如果项目还没有代码，也要先产出项目文档、访谈问题、MVP 边界或发布材料等可提交文件。',
    '- 路线图应该让用户始终知道下一步，而不是让用户阅读一份静态计划。',
    '',
    '## 推荐循环',
    '',
    '```text',
    '项目目标 -> 适配的路线图 -> 下一步动作 -> Agent 对话 -> 本地交付 -> 结果验证 -> 路线图更新',
    '```'
  ].join('\n');
}

function ensureSolopreneurReadme(solopreneurDir: string): void {
  const readmePath = path.join(solopreneurDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, buildSolopreneurDirectoryReadme(), 'utf8');
  }
}

function ensureBootstrapRoadmapInstructions(solopreneurDir: string, cliPath: string): void {
  const instructionsPath = path.join(solopreneurDir, 'bootstrap-roadmap-instructions.md');
  fs.writeFileSync(instructionsPath, buildBootstrapRoadmapInstructions(cliPath), 'utf8');
}

function ensureRoadmapValidationScript(solopreneurDir: string): void {
  const scriptPath = path.join(solopreneurDir, 'validate-roadmap.cjs');
  fs.mkdirSync(solopreneurDir, { recursive: true });
  fs.writeFileSync(scriptPath, buildRoadmapValidationScript(), { encoding: 'utf8', mode: 0o755 });
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // chmod is best-effort for platforms that support POSIX file modes.
  }
}

function ensureRoadmapMethodologyInstructions(solopreneurDir: string): void {
  const instructionsPath = path.join(solopreneurDir, 'roadmap-methodology.md');
  fs.writeFileSync(instructionsPath, buildRoadmapMethodologyInstructions(), 'utf8');
}

function getStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.json`);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 8);
}

function buildCompletionCriteriaForNode(node: RoadmapNode): string[] {
  const stage = String(node.stage || '').trim();
  const title = String(node.title || '当前环节').trim();
  const prompt = String(node.agentPrompt || '').trim();
  const criteria: string[] = [
    `已经围绕“${title}”产出可提交的本地文件、页面、配置、市场材料或反馈记录。`
  ];

  if (stage === '问题与客户发现') {
    criteria.push('问题假设、目标用户、验证方式、风险和下一步行动已经写入项目文件。');
  } else if (stage === '产品与 MVP') {
    criteria.push('MVP 或产品切片已经能被运行、查看或按文档验证。');
  } else if (stage === '营销与销售') {
    criteria.push('定位、触达、官网、发布、销售或转化材料已经形成可直接使用的版本。');
  } else if (stage === '反馈与规模化') {
    criteria.push('反馈来源、关键指标、支持信号、单位经济假设或下一轮改进任务已经记录清楚。');
  } else {
    criteria.push('本环节说明中的核心交付物已经落到项目文件中。');
  }

  if (/测试|验证|校验|运行|test|check|build/i.test(prompt)) {
    criteria.push('已经运行最窄必要验证命令；如果无法运行，原因和替代检查已记录。');
  } else {
    criteria.push('已经完成一次最小自检，并在输出中说明本轮结果。');
  }

  criteria.push('如果仍需后续推进，已经留下明确的下一次建议；如果不需要，Agent 或用户可以安全标记该环节完成。');
  return criteria;
}

function readStepMemoryObject(filePath: string): Record<string, unknown> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCompletionCriteria(workspaceRoot: string, node: RoadmapNode): string[] {
  const filePath = getStepMemoryFilePath(workspaceRoot, node.id || '');
  const memory = readStepMemoryObject(filePath);
  const existing = normalizeStringList(memory.completionCriteria);
  return existing.length > 0 ? existing : buildCompletionCriteriaForNode(node);
}

function ensureCompletionCriteriaForNodes(workspaceRoot: string, nodes: RoadmapNode[], options: { writeMissing?: boolean } = {}): RoadmapNode[] {
  if (!workspaceRoot) {
    return nodes;
  }
  const writeMissing = options.writeMissing !== false;
  return nodes.map((node) => {
    const filePath = getStepMemoryFilePath(workspaceRoot, node.id || '');
    const legacyFilePath = getLegacyStepMemoryFilePath(workspaceRoot, node.id || '');
    const memory = readStepMemoryObject(filePath);
    const existingCriteria = normalizeStringList(memory.completionCriteria);
    const completionCriteria = existingCriteria.length > 0 ? existingCriteria : buildCompletionCriteriaForNode(node);
    if (writeMissing && existingCriteria.length === 0) {
      const legacyEntries = !fs.existsSync(filePath) && fs.existsSync(legacyFilePath)
        ? parseStepHandoffEntries(fs.readFileSync(legacyFilePath, 'utf8'))
        : [];
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: Number(memory.version || 1),
        format: String(memory.format || 'solopreneur.stepHandoff'),
        description: String(memory.description || 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.'),
        completionCriteria,
        lastCompletionEvidence: normalizeStringList(memory.lastCompletionEvidence),
        entries: Array.isArray(memory.entries) ? memory.entries : legacyEntries
      }, null, 2), 'utf8');
    }
    return {
      ...node,
      completionCriteria
    };
  });
}

async function addProjectFromDialog(context: vscode.ExtensionContext): Promise<void> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use This Folder'
  });

  const folder = result?.[0]?.fsPath;
  if (!folder) {
    return;
  }

  const projects = getProjects(context);
  if (!projects.some((project) => project.path === folder)) {
    const projectType = await vscode.window.showQuickPick([
      { label: '核心产品', description: '面向外部用户，需要获客、采用、付费或持续使用', value: 'core_product' },
      { label: '基础设施', description: '为多个项目提供能力，重视契约、治理和兼容性', value: 'infra' },
      { label: '内容产品', description: '围绕内容生产、发布、分发和反馈持续运转', value: 'content' },
      { label: '试验研究', description: '验证想法或学习技术，重点是获得结论', value: 'experiment' },
      { label: '工具脚手架', description: '减少重复工作，供自己或多个项目复用', value: 'tool' },
      { label: '日常工作处理', description: '承接持续发生的事务、支持、运营、排障和日常推进', value: 'daily_work' },
      { label: '归档维护', description: '已上线或稳定项目，重点是健康检查和维护', value: 'archive' }
    ], {
      placeHolder: '这个项目更像哪一类？'
    });
    if (!projectType) {
      return;
    }
    projects.push({
      name: projectName(folder),
      path: folder,
      type: projectType.value
    });
    ensureProjectFoundation(folder, projectType.value);
    await saveProjects(context, projects);
    recordLocalUsageEvent(context, 'projectAdded');
  }
  await setProjectHidden(context, folder, false);

  await context.globalState.update(selectedProjectKey, folder);
  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  await ensureSyncEngine(context);
  sendProjectsToWebviews(context);
  sendNodesToWebview();
}

async function removeProject(context: vscode.ExtensionContext, projectPath: string): Promise<void> {
  const projects = getProjects(context);
  const project = projects.find((candidate) => candidate.path === projectPath);
  if (!project) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `从 SoloMap 中删除项目“${project.name}”？这只会删除该项目里的 .solopreneur 文件夹，并把项目从插件列表中移除，不会删除项目本身的代码文件夹。`,
    { modal: true },
    '确认删除'
  );
  if (confirmed !== '确认删除') {
    return;
  }

  const solopreneurDir = path.join(projectPath, '.solopreneur');
  if (fs.existsSync(solopreneurDir)) {
    fs.rmSync(solopreneurDir, { recursive: true, force: true });
  }

  const nextProjects = projects.filter((candidate) => candidate.path !== projectPath);
  await saveProjects(context, nextProjects);
  await setProjectHidden(context, projectPath, true);

  const nextSelectedProjectPath = nextProjects[0]?.path || '';
  await context.globalState.update(selectedProjectKey, nextSelectedProjectPath);

  syncEngine = null;
  activeProjectRoot = null;
  syncEngineReady = false;
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }

  if (nextSelectedProjectPath) {
    await ensureSyncEngine(context);
  }

  sendProjectsToWebviews(context);
  sendNodesToWebview();
  vscode.window.showInformationMessage(`SoloMap 已移除项目“${project.name}”。项目文件夹本身未删除。`);
}

function sendProjectsToWebviews(context: vscode.ExtensionContext): void {
  const projects = getProjectState(context);
  if (activePanel) {
    postProjectsLoaded(activePanel.webview, projects);
  }
  if (sidebarProvider) {
    sidebarProvider.sendProjects();
  }
}

function sendLocalProjectsToWebviews(context: vscode.ExtensionContext): void {
  const projects = getProjectState(context);
  if (activePanel) {
    postProjectsLoaded(activePanel.webview, projects);
  }
  if (sidebarProvider) {
    sidebarProvider.sendLocalProjects();
  }
}

async function getSoloConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string): Promise<AgentConversation[]> {
  if (!getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  if (syncEngine && activeProjectRoot === projectPath) {
    return selectLatestConversationRoots(buildConversationPresentations(projectPath, soloConversationId, syncEngine.getAgentExecutions(soloConversationId)), 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return selectLatestConversationRoots(buildConversationPresentations(projectPath, soloConversationId, store.getExecutionLogs(soloConversationId)), 1);
  } finally {
    store.close();
  }
}

async function getStepConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string, nodeId: string): Promise<AgentConversation[]> {
  if (!nodeId || !getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  if (syncEngine && activeProjectRoot === projectPath) {
    return selectLatestConversationRoots(buildConversationPresentations(projectPath, nodeId, syncEngine.getAgentExecutions(nodeId)), 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return selectLatestConversationRoots(buildConversationPresentations(projectPath, nodeId, store.getExecutionLogs(nodeId)), 1);
  } finally {
    store.close();
  }
}

async function getProjectConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string): Promise<AgentConversation[]> {
  if (!getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  const excludeNodeIds = new Set([soloConversationId, roadmapRevisionId]);
  if (syncEngine && activeProjectRoot === projectPath) {
    return hydrateProjectConversationContinuations(projectPath, syncEngine.getProjectAgentExecutions())
      .filter((conversation) => !excludeNodeIds.has(String(conversation.nodeId || '')))
      .slice(0, sidebarProjectConversationHistoryLimit);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return hydrateProjectConversationContinuations(projectPath, store.getAllExecutionLogs())
      .filter((conversation) => !excludeNodeIds.has(String(conversation.nodeId || '')))
      .slice(0, sidebarProjectConversationHistoryLimit);
  } finally {
    store.close();
  }
}

function hydrateProjectConversationContinuations(projectPath: string, conversations: AgentConversation[]): AgentConversation[] {
  const byNode = new Map<string, AgentConversation[]>();
  for (const conversation of conversations) {
    const nodeId = String(conversation.nodeId || '');
    if (!nodeId) {
      continue;
    }
    const group = byNode.get(nodeId) || [];
    group.push(conversation);
    byNode.set(nodeId, group);
  }
  const hydratedById = new Map<number, AgentConversation>();
  for (const [nodeId, group] of byNode.entries()) {
    buildConversationPresentations(projectPath, nodeId, group)
      .forEach((conversation) => hydratedById.set(Number(conversation.id || 0), conversation));
  }
  return conversations.map((conversation) => hydratedById.get(Number(conversation.id || 0)) || conversation);
}

/**
 * Ensures the sync engine is initialized if a workspace is open.
 */
async function ensureSyncEngine(context: vscode.ExtensionContext): Promise<boolean> {
  const projectRoot = getSelectedProjectPath(context);
  if (syncEngine && activeProjectRoot === projectRoot && syncEngineReady) {
    return true;
  }
  if (syncEngineInitPromise && syncEngineInitProjectRoot === projectRoot) {
    return syncEngineInitPromise;
  }

  if (!projectRoot) {
    return false;
  }
  const solopreneurDir = path.join(projectRoot, '.solopreneur');

  if (!fs.existsSync(solopreneurDir)) {
    fs.mkdirSync(solopreneurDir, { recursive: true });
  }
  ensureSolopreneurReadme(solopreneurDir);
  ensureRoadmapMethodologyInstructions(solopreneurDir);
  ensureBootstrapRoadmapInstructions(solopreneurDir, getPersistedSettings(context).cliPath || 'agy');
  ensureRoadmapValidationScript(solopreneurDir);
  ensureDocumentationManifest(projectRoot);

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngineInitProjectRoot = projectRoot;
  syncEngineInitPromise = (async () => {
    const nextSyncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
    syncEngine = nextSyncEngine;
    activeProjectRoot = projectRoot;
    syncEngineReady = false;
    sendNodesToWebview();
    try {
      await nextSyncEngine.initAndSync();
      if (getSelectedProjectPath(context) !== projectRoot) {
        return false;
      }
      syncEngine = nextSyncEngine;
      activeProjectRoot = projectRoot;
      syncEngineReady = true;
      ensureCompletionCriteriaForNodes(projectRoot, syncEngine.getNodes());
      setupFileSentinelWatcher(projectRoot);
      // Project switching should stay local-first; avoid re-triggering
      // full external-card refreshes while short-lived caches are still warm.
      if (sidebarProvider) {
        sidebarProvider.sendNodesToWebview();
        sidebarProvider.sendLocalProjects();
      }
      return true;
    } catch (error) {
      syncEngineReady = false;
      postRoadmapLoadFailed(projectRoot, error);
      vscode.window.showErrorMessage(`路线图本地数据加载失败：${formatLocalDataError(error)}`);
      return false;
    } finally {
      syncEngineInitPromise = null;
      syncEngineInitProjectRoot = '';
    }
  })();
  return syncEngineInitPromise;
}

async function openRoadmapPanel(context: vscode.ExtensionContext, initialView: 'roadmap' | 'solo' | 'flow' = 'roadmap') {
  const effectiveInitialView = initialView;
  // If panel already exists, reveal it
  if (activePanel) {
    recordLocalUsageEvent(context, 'roadmapOpened');
    activePanel.reveal(vscode.ViewColumn.One);
    postWebviewMessage(activePanel.webview, { command: 'setMainView', view: effectiveInitialView });
    void postFlowStateToWebview(context);
    return;
  }

  const projectRoot = getSelectedProjectPath(context);
  if (!projectRoot) {
    vscode.window.showErrorMessage('Choose a project folder before launching the Roadmap.');
    return;
  }
  recordLocalUsageEvent(context, 'roadmapOpened');

  // Create Webview Panel
  activePanel = vscode.window.createWebviewPanel(
    'solopreneurRoadmap',
    'SoloMap - AI Coding Agent Roadmap',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    }
  );

  // Load basic HTML into Webview
  activePanel.webview.html = getWebviewHtml(activePanel.webview, context);
  postWebviewMessage(activePanel.webview, { command: 'roadmapLoading', projectPath: projectRoot });
  postSettingsLoaded(activePanel.webview, getSettingsWithRuntimeState(context));
  postProjectsLoaded(activePanel.webview, getProjectState(context));
  postWebviewMessage(activePanel.webview, { command: 'setMainView', view: effectiveInitialView });
  void postFlowStateToWebview(context);

  // Handle messages from Webview
  activePanel.webview.onDidReceiveMessage(
    async (message) => {
      if (await handleSharedWebviewAction(context, message, 'roadmap', activePanel?.webview)) {
        return;
      }
      switch (message.command) {
        case 'getNodes':
          if (syncEngine && activeProjectRoot === getSelectedProjectPath(context)) {
            sendNodesToWebview();
          } else {
            postWebviewMessage(activePanel?.webview, { command: 'roadmapLoading', projectPath: getSelectedProjectPath(context) });
            void ensureSyncEngine(context).then((ready) => {
              if (ready) {
                sendNodesToWebview();
              }
            });
          }
          break;

        case 'updateNode':
          if (syncEngine) {
            syncEngine.updateNode(message.nodeId, message.updates);
            sendNodesToWebview();
          }
          break;

        case 'completeNode':
          completeNodeManually(message.nodeId);
          break;

        case 'getFlowState':
          await postFlowStateToWebview(context);
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  void ensureSyncEngine(context).then((ready) => {
    if (ready) {
      sendNodesToWebview();
    }
  });

  // Clean up when panel is closed
  activePanel.onDidDispose(
    () => {
      activePanel = null;
      if (watcher) {
        watcher.dispose();
        watcher = null;
      }
      if (statusPoller) {
        clearInterval(statusPoller);
        statusPoller = null;
      }
    },
    null,
    context.subscriptions
  );
}

async function handleOpenStrategyPyramid(context: vscode.ExtensionContext): Promise<void> {
  await openStrategyPyramidPanel(context);
}

async function hasLocalStrategyPyramidAccess(context: vscode.ExtensionContext): Promise<boolean> {
  if (hasProEntitlement(getPersistedSettings(context), 'strategyPyramid')) {
    return true;
  }
  const cached = await readPassportGrant(context);
  return cached ? grantContainsFeature(cached) : false;
}

async function openStrategyPyramidPanel(context: vscode.ExtensionContext): Promise<void> {
  if (activeStrategyPyramidPanel) {
    activeStrategyPyramidPanel.reveal(vscode.ViewColumn.One);
    activeStrategyPyramidPanel.webview.html = buildLocalDataStatusHtml(
      activeStrategyPyramidPanel.webview,
      context,
      {
        title: '正在打开战略金字塔',
        message: '先打开视图，再读取本地项目组合数据。'
      }
    );
    void refreshStrategyPyramidPanel(context);
    return;
  }

  activeStrategyPyramidPanel = vscode.window.createWebviewPanel(
    'solopreneurStrategyPyramid',
    'SoloMap: Strategy Pyramid',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)]
    }
  );

  activeStrategyPyramidPanel.webview.html = buildLocalDataStatusHtml(
    activeStrategyPyramidPanel.webview,
    context,
    {
      title: '正在打开战略金字塔',
      message: '先打开视图，再读取本地项目组合数据。'
    }
  );
  void refreshStrategyPyramidPanel(context);

  activeStrategyPyramidPanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'refreshStrategyPyramid':
          activeStrategyPyramidPanel!.webview.html = buildLocalDataStatusHtml(
            activeStrategyPyramidPanel!.webview,
            context,
            {
              title: '正在刷新战略金字塔',
              message: '正在重新读取本地项目组合数据。'
            }
          );
          void refreshStrategyPyramidPanel(context);
          break;
        case 'openProAuthorization':
          await beginPassportAuthorizationFlow(context);
          break;
        case 'openProjectRoadmap':
          if (message.projectPath) {
            await selectProject(context, String(message.projectPath));
            await openRoadmapPanel(context);
          }
          break;
        case 'saveProjectStrategy':
          if (message.projectPath) {
            await saveProjectStrategy(
              context,
              message.projectPath,
              message.role,
              message.businessStage,
              message.revenueTier,
              message.timeLoad,
              message.strategicAction,
              message.abilities
            );
            void refreshStrategyPyramidPanel(context);
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  activeStrategyPyramidPanel.onDidDispose(
    () => {
      activeStrategyPyramidPanel = null;
    },
    null,
    context.subscriptions
  );
}

async function refreshStrategyPyramidPanel(context: vscode.ExtensionContext): Promise<void> {
  const panel = activeStrategyPyramidPanel;
  if (!panel) {
    return;
  }
  if (!await hasLocalStrategyPyramidAccess(context)) {
    panel.webview.html = buildLocalDataStatusHtml(panel.webview, context, {
      title: '需要 SoloMap Pro',
      message: '战略金字塔需要 Pro。你仍然可以先使用本地路线图和项目卡片；登录或升级后这里会读取本地项目组合数据。',
      actionLabel: '登录 / 升级 Pro',
      actionCommand: 'openProAuthorization'
    });
    return;
  }
  await postLocalDataLoad(
    () => buildStrategyPyramidSnapshot(context),
    (snapshot) => {
      if (!activeStrategyPyramidPanel) return;
      activeStrategyPyramidPanel.webview.html = getStrategyPyramidWebviewHtml(
        activeStrategyPyramidPanel.webview,
        context,
        snapshot
      );
    },
    (message) => {
      if (!activeStrategyPyramidPanel) return;
      activeStrategyPyramidPanel.webview.html = buildLocalDataStatusHtml(activeStrategyPyramidPanel.webview, context, {
        title: '战略金字塔加载失败',
        message: '本地项目组合数据没有成功读取。',
        detail: message,
        actionLabel: '重试',
        actionCommand: 'refreshStrategyPyramid'
      });
    },
    '战略金字塔本地数据加载失败。'
  );
}

function buildStrategyPyramidSnapshot(context: vscode.ExtensionContext) {
  return buildStrategyPyramidSnapshotData(
    getProjects(context),
    normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath),
    getWorkspaceRoot() || process.cwd()
  );
}

async function saveProjectStrategy(
  context: vscode.ExtensionContext,
  projectPath: string,
  role: string,
  businessStage: string,
  revenueTier: string,
  timeLoad: string,
  strategicAction: string,
  abilities: string[]
): Promise<void> {
  return saveProjectStrategyData(
    normalizeGlobalDataPathForExtension(getPersistedSettings(context).globalDataPath),
    projectPath,
    role,
    businessStage,
    revenueTier,
    timeLoad,
    strategicAction,
    abilities
  );
}


/**
 * Sends current node and edge states back to the Webview frontend.
 */
function sendNodesToWebview() {
  const nodes = syncEngine
    ? ensureCompletionCriteriaForNodes(activeProjectRoot || '', syncEngine.getNodes(), { writeMissing: false })
    : [];
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'nodesUpdated',
      nodes,
      projectPath: activeProjectRoot || '',
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendNodesToWebview();
  }
  if (extensionContextRef) {
    void postFlowStateToWebview(extensionContextRef);
  }
}

function reconcileActiveProjectConversationLifecycle(): void {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  if (typeof syncEngine.getProjectAgentExecutions !== 'function') {
    return;
  }
  const conversations = syncEngine.getProjectAgentExecutions();
  const runningNodeIds = new Set(
    conversations
      .filter((conversation) => String(conversation.status || '') === 'Running')
      .map((conversation) => String(conversation.nodeId || ''))
      .filter(Boolean)
  );
  const latestByNode = new Map<string, AgentConversation>();
  for (const conversation of conversations) {
    const nodeId = String(conversation.nodeId || '');
    if (!nodeId || nodeId === soloConversationId || nodeId === roadmapRevisionId) {
      continue;
    }
    const current = latestByNode.get(nodeId);
    if (!current || Number(conversation.id || 0) > Number(current.id || 0)) {
      latestByNode.set(nodeId, conversation);
    }
  }
  for (const node of syncEngine.getNodes()) {
    if (node.status !== 'Running' || runningNodeIds.has(node.id)) {
      continue;
    }
    const latest = latestByNode.get(node.id);
    const latestStatus = String(latest?.status || '');
    const nextStatus = latestStatus === 'Failed'
      ? 'Failed'
      : latestStatus === 'Completed'
        ? 'Completed'
        : 'In Progress';
    syncEngine.updateNode(node.id, {
      status: nextStatus as RoadmapNode['status'],
      completedAt: nextStatus === 'Completed' ? (node.completedAt || new Date().toISOString()) : ''
    });
  }
}

function postRoadmapLoadFailed(projectPath: string, error: unknown): void {
  const message = formatLocalDataError(error, '路线图本地数据加载失败。');
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'roadmapLoadFailed',
      projectPath,
      message
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendNodesToWebview();
  }
}

function refreshSidebarProjectCards(): void {
  if (sidebarProvider) {
    sidebarProvider.sendLocalProjects();
  }
}

function completeNodeManually(nodeId: string): void {
  if (!syncEngine || !nodeId) {
    return;
  }

  syncEngine.updateNode(nodeId, {
    status: 'Completed',
    completedAt: new Date().toISOString()
  });

  if (activeProjectRoot) {
    const statusFilePath = path.join(activeProjectRoot, '.agent_status.json');
    const currentStatus = readAgentStatus(statusFilePath);
    const completionDecisionFilePath = String(currentStatus?.completionDecisionFilePath || '').trim();
    if (currentStatus?.nodeId === nodeId && completionDecisionFilePath) {
      try {
        fs.writeFileSync(completionDecisionFilePath, JSON.stringify({
          markCompleted: true,
          reason: '用户已手动确认完成该环节。',
          source: 'user'
        }), 'utf8');
      } catch (error) {
        console.warn('Failed to persist manual completion decision:', error);
      }
    }
  }

  sendNodesToWebview();
}

function buildContinuationMetadataBlock(parentConversationId: number, sessionId: string): string {
  return [
    `Continuation parent conversation: ${parentConversationId}`,
    `Continuation session id: ${sessionId}`,
    'Continuation source: interactive_sdk'
  ].join('\n');
}

function isContinuationRunKind(runKind: string): boolean {
  return runKind === 'solo_continue' || runKind === 'step_continue';
}

function buildInteractiveContinuationPrompt(
  node: RoadmapNode | null,
  userMessage: string,
  workspaceRoot: string,
  completionDecisionFilePath = '',
  supplementFiles: string[] = [],
  globalPrompt = '',
  globalDataPath = ''
): string {
  const normalizedUserMessage = String(userMessage || '').trim();
  const completionFile = completionDecisionFilePath
    ? toProjectRelativeRuntimePath(workspaceRoot, completionDecisionFilePath)
    : '';
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为这次续聊附加了补充文件，开始前先读取这些文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '这些文件与本轮用户最新消息一起构成最高优先级上下文。'
    ].join('\n')
    : '';
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如果与本轮用户最新消息冲突，以本轮用户最新消息为准。'
    ].join('\n')
    : '';
  const stepMemoryFilePath = node ? getStepMemoryFilePath(workspaceRoot, node.id || '') : '';
  const completionCriteria = node ? readCompletionCriteria(workspaceRoot, node) : [];
  const completionCriteriaInstructions = completionCriteria.length > 0
    ? [
      '如果这是路线图环节续聊，完成标准仍然如下：',
      ...completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`)
    ].join('\n')
    : '';
  const stepMemoryInstructions = node && node.id && node.id !== soloConversationId
    ? [
      '这是一个已有路线图环节的续聊。',
      `开始前先读取环节交接文件：${toProjectRelativeRuntimePath(workspaceRoot, stepMemoryFilePath)}`,
      '继续推进当前环节，不要切换到其他环节。'
    ].join('\n')
    : '这是同一项目中的续聊，请延续当前项目语境回答和行动。';
  const continuationRunKind = node && node.id && node.id !== soloConversationId ? 'step_continue' : 'solo_continue';
  const startupContextText = [
    normalizedUserMessage,
    node?.title || '',
    node?.stage || '',
    node?.description || '',
    attachedFiles.join('\n')
  ].join('\n');
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapLearningRetrievalContext = buildLearningRetrievalContext(workspaceRoot, globalDataPath, {
    projectPath: workspaceRoot,
    runKind: continuationRunKind,
    contextText: startupContextText,
    files: attachedFiles
  });
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: node?.id || soloConversationId,
    runKind: continuationRunKind,
    contextText: startupContextText,
    supplementFiles: attachedFiles
  });
  const solomapStartupPackInstructions = buildSolomapStartupPackInstructions({
    workspaceRoot,
    globalDataPath,
    runKind: continuationRunKind,
    contextText: startupContextText,
    learningSummaryContext: solomapLearningContext,
    learningRetrievalContext: solomapLearningRetrievalContext,
    executionExperienceContext: solomapExecutionExperienceContext
  });
  return [
    '你正在继续 SoloMap 中已经存在的一段对话。',
    `项目目录：${workspaceRoot}`,
    node && node.id && node.id !== soloConversationId
      ? `所属环节：${node.title}（${node.stage}）`
      : '所属范围：Solo 对话',
    '',
    '最高优先级规则：',
    '1. 当前这条用户最新消息是本轮唯一最高优先级要求。',
    '2. 延续既有对话上下文，但不要被旧结论绑死；如果新消息推翻了旧方向，以新消息为准。',
    '3. 如果需要修改项目文件或运行命令，直接完成最小闭环，不要只做口头建议。',
    '',
    '用户最新消息：',
    normalizedUserMessage || '继续上一轮对话，并根据新的情况推进。',
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    stepMemoryInstructions,
    ...(completionCriteriaInstructions ? ['', completionCriteriaInstructions] : []),
    '',
    solomapStartupPackInstructions,
    '',
    '闭环要求：',
    '1. 保持这是同一次任务的续聊，不要把它改造成新的无关任务。',
    '2. 运行必要的最窄验证；如果无法验证，要说明原因。',
    completionDecisionFilePath
      ? `3. 如果你判断整个任务已经达到完成标准，请向 ${completionFile} 写入 JSON：{"markCompleted":true,"reason":"一句话说明为什么已完成"}。如果仍需后续续聊，不要写入完成。`
      : '3. 如果你判断任务已完成，请在最终回答中明确说明。',
    '4. 完成当前这一轮后正常结束本次 turn。'
  ].join('\n');
}

function buildSessionCaptureScript(
  provider: string,
  workspaceRoot: string,
  startedAtFilePath: string,
  outputFilePath: string,
  sessionFilePath: string
): string {
  const sessionWriter = [
    `if [ -n "$session_id" ]; then`,
    `node -e ${shellQuote([
      'const fs=require("fs");',
      'const file=process.argv[1];',
      'const sessionId=process.argv[2];',
      'const source=process.argv[3]||"unknown";',
      'fs.mkdirSync(require("path").dirname(file),{recursive:true});',
      'fs.writeFileSync(file, JSON.stringify({ sessionId, source }, null, 2));'
    ].join(''))} ${shellQuote(sessionFilePath)} "$session_id" "$session_source";`,
    `fi`
  ].join(' ');

  if (provider === 'antigravity') {
    return [
      `session_id=""`,
      `session_source=""`,
      `latest_log=$(find "$HOME/.gemini/antigravity-cli/log" -type f -name 'cli-*.log' -newer ${shellQuote(startedAtFilePath)} -print 2>/dev/null | sort | tail -1 || true)`,
      `if [ -n "$latest_log" ]; then session_id=$(grep -Eo 'conversation[ =:]+[0-9a-fA-F-]{36}|Created conversation [0-9a-fA-F-]{36}' "$latest_log" 2>/dev/null | grep -Eo '[0-9a-fA-F-]{36}' | tail -1 || true); session_source="antigravity-log"; fi`,
      `if [ -z "$session_id" ] && [ -f "$HOME/.gemini/antigravity-cli/cache/last_conversations.json" ]; then session_id=$(node -e ${shellQuote([
        'const fs=require("fs");',
        'const file=process.argv[1];',
        'const workspace=process.argv[2];',
        'try {',
        'const data=JSON.parse(fs.readFileSync(file,"utf8"));',
        'process.stdout.write(data[workspace] || "");',
        '} catch {}'
      ].join(''))} "$HOME/.gemini/antigravity-cli/cache/last_conversations.json" ${shellQuote(workspaceRoot)}); session_source="antigravity-cache"; fi`,
      // Fallback: if provider-specific extraction fails, capture a recognizable session token in the run output log.
      `if [ -z "$session_id" ]; then session_id=$(grep -Eo 'ses_[A-Za-z0-9_.:-]+|[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true); session_source="generic-output"; fi`,
      sessionWriter
    ].join('; ');
  }

  if (provider === 'codex') {
    const codexOutputSessionExtractor = [
      'const fs=require("fs");',
      'const file=process.argv[1];',
      'try {',
      'const text=fs.readFileSync(file,"utf8").replace(/\\x1b\\[[0-9;]*m/g,"");',
      'const lines=text.split(/\\r?\\n/);',
      'for (const line of lines) {',
      'const match=line.match(/^\\s*session id:\\s*([0-9a-fA-F-]{36})\\s*$/i);',
      'if (match) { process.stdout.write(match[1]); process.exit(0); }',
      '}',
      '} catch {}'
    ].join('');
    return [
      `session_id=""`,
      `session_source=""`,
      `session_id=$(node -e ${shellQuote(codexOutputSessionExtractor)} ${shellQuote(outputFilePath)})`,
      `if [ -n "$session_id" ]; then session_source="codex-output"; fi`,
      `if [ -z "$session_id" ]; then latest_session=$(find "$HOME/.codex/sessions" -type f -name '*.jsonl' -newer ${shellQuote(startedAtFilePath)} -print 2>/dev/null | sort | tail -1 || true); if [ -n "$latest_session" ]; then session_id=$(node -e ${shellQuote([
        'const fs=require("fs");',
        'const file=process.argv[1];',
        'try {',
        'const first=fs.readFileSync(file,"utf8").split(/\\r?\\n/).find(Boolean)||"";',
        'const parsed=JSON.parse(first);',
        'process.stdout.write((parsed.payload && parsed.payload.id) || "");',
        '} catch {}'
      ].join(''))} "$latest_session"); session_source="codex-session-file"; fi; fi`,
      sessionWriter
    ].join('; ');
  }

  return [
    `session_id=$(grep -Eo 'ses_[A-Za-z0-9_.:-]+|[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true)`,
    `session_source="generic-output"`,
    sessionWriter
  ].filter(Boolean).join('; ');
}

function resolveNativeSessionIdForConversation(nodeId: string, conversation: AgentConversation | null): string {
  return resolveNativeSessionIdForConversationFromWorkspace(activeProjectRoot || '', nodeId, conversation);
}

function buildWorkspaceSnapshotScript(workspaceRoot: string, snapshotFilePath: string): string {
  return `node -e ${shellQuote([
    'const fs=require("fs");',
    'const path=require("path");',
    'const root=process.argv[1];',
    'const out=process.argv[2];',
    'const snapshot={};',
    'function shouldSkip(rel){',
    'if(rel===".git" || rel.startsWith(".git/")) return true;',
    'if(rel==="node_modules" || rel.startsWith("node_modules/")) return true;',
    'if(rel===".solopreneur") return false;',
    'if(rel.startsWith(".solopreneur/")) return rel !== ".solopreneur/roadmap.csv";',
    'return false;',
    '}',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
    'if(shouldSkip(rel)) continue;',
    'if(entry.isDirectory()){ walk(full); continue; }',
    'if(!entry.isFile() || rel===".agent_status.json") continue;',
    'const stat=fs.statSync(full);',
    'snapshot[rel]={size:stat.size,mtimeMs:stat.mtimeMs};',
    '}',
    '}',
    'if(fs.existsSync(root)) walk(root);',
    'fs.mkdirSync(path.dirname(out),{recursive:true});',
    'fs.writeFileSync(out, JSON.stringify(snapshot));'
  ].join(''))} ${shellQuote(workspaceRoot)} ${shellQuote(snapshotFilePath)}`;
}

function buildWorkspaceDiffScript(workspaceRoot: string, snapshotFilePath: string, touchedFilesPath: string): string {
  return `node -e ${shellQuote([
    'const fs=require("fs");',
    'const path=require("path");',
    'const root=process.argv[1];',
    'const beforeFile=process.argv[2];',
    'const out=process.argv[3];',
    'let before={};',
    'try{ before=JSON.parse(fs.readFileSync(beforeFile,"utf8"))||{}; } catch {}',
    'const after={};',
    'function shouldSkip(rel){',
    'if(rel===".git" || rel.startsWith(".git/")) return true;',
    'if(rel==="node_modules" || rel.startsWith("node_modules/")) return true;',
    'if(rel===".solopreneur") return false;',
    'if(rel.startsWith(".solopreneur/")) return rel !== ".solopreneur/roadmap.csv";',
    'return false;',
    '}',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
    'if(shouldSkip(rel)) continue;',
    'if(entry.isDirectory()){ walk(full); continue; }',
    'if(!entry.isFile() || rel===".agent_status.json") continue;',
    'const stat=fs.statSync(full);',
    'after[rel]={size:stat.size,mtimeMs:stat.mtimeMs};',
    '}',
    '}',
    'if(fs.existsSync(root)) walk(root);',
    'const changes=[];',
    'for(const [rel,meta] of Object.entries(after)){',
    'const prev=before[rel];',
    'if(!prev){ changes.push(`A ${rel}`); continue; }',
    'if(prev.size!==meta.size || Math.round(prev.mtimeMs)!==Math.round(meta.mtimeMs)){ changes.push(`M ${rel}`); }',
    '}',
    'for(const rel of Object.keys(before)){ if(!after[rel]) changes.push(`D ${rel}`); }',
    'changes.sort((a,b)=>a.localeCompare(b));',
    'fs.mkdirSync(path.dirname(out),{recursive:true});',
    'fs.writeFileSync(out, changes.join("\\n"));'
  ].join(''))} ${shellQuote(workspaceRoot)} ${shellQuote(snapshotFilePath)} ${shellQuote(touchedFilesPath)}`;
}

function toProjectRelativeRuntimePath(workspaceRoot: string, targetPath: string): string {
  const relativePath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
  return relativePath && !relativePath.startsWith('..') ? relativePath : targetPath;
}


function buildAgentConversationPrompt(
  node: RoadmapNode,
  userMessage: string,
  workspaceRoot: string,
  stepMemoryFilePath = '',
  agentRunsDir = '',
  completionDecisionFilePath = '',
  previousSessionId = '',
  supplementFiles: string[] = [],
  globalPrompt = '',
  githubIssueContext = '',
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const normalizedGlobalPrompt = globalPrompt.trim();
  const normalizedGithubIssueContext = githubIssueContext.trim();
  const supplement = userMessage.trim()
    ? `\n\n用户对本次对话的补充要求：\n${userMessage.trim()}`
    : '';
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次对话选择了补充文件，开始执行前必须先读取这些文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '这些文件是本轮任务的重要上下文；如果它们与历史记录或环节默认描述冲突，以这些文件和本次用户补充为准。'
    ].join('\n')
    : '';
  const globalPromptInstructions = normalizedGlobalPrompt
    ? [
      '用户设置的全局默认要求（适用于每一次环节对话）：',
      normalizedGlobalPrompt,
      '如果全局默认要求与本次用户补充冲突，以本次用户补充为准。'
    ].join('\n')
    : '';
  const memoryFile = stepMemoryFilePath || getStepMemoryFilePath(workspaceRoot, node.id || '');
  const runsDir = agentRunsDir || path.join(workspaceRoot, '.solopreneur', 'agent-runs', node.id || '');
  const completionFile = completionDecisionFilePath
    ? toProjectRelativeRuntimePath(workspaceRoot, completionDecisionFilePath)
    : '';
  const memoryFileDisplay = toProjectRelativeRuntimePath(workspaceRoot, memoryFile);
  const runsDirDisplay = toProjectRelativeRuntimePath(workspaceRoot, runsDir);
  const completionCriteria = readCompletionCriteria(workspaceRoot, node);
  const completionCriteriaInstructions = completionCriteria.length > 0
    ? [
      '本环节完成标准：',
      ...completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
      '本轮交付和最终完成判断必须对照这些标准；如果只完成其中一部分，请保持环节为继续推进状态。'
    ].join('\n')
    : '';
  const memoryInstructions = [
    '开始前必须先读取 SoloMap 为本环节保存的项目上下文文件：',
    `- 环节交接 JSON：${memoryFileDisplay}`,
    `- 环节运行记录目录：${runsDirDisplay}`,
    '如果文件或目录不存在，说明这是该环节的早期对话，继续执行本轮任务即可。',
    '读取这些项目文件后，再结合本次用户补充推进当前环节；不要依赖插件直接注入的历史摘要。'
  ].join('\n');
  const userPriorityInstructions = normalizedUserMessage
    ? [
      '最高优先级规则：',
      '1. 本次“用户对本次对话的补充要求”是这一轮唯一最高优先级指令，高于旧会话中的既有结论、高于之前的完成判断、高于你刚才输出过的总结话术。',
      '2. 如果旧会话、环节默认任务、历史完成状态与这次用户补充有任何冲突，必须以这次用户补充为准。',
      '3. 禁止重复汇报与这次用户补充无关的旧成果，禁止再次输出“已经完成”“状态健康”“随时待命”这类空泛总结，除非你在本轮真的完成了用户补充要求。',
      '4. 即使当前环节状态显示为 Completed 或 Failed，也不能把它当成停止信号；你仍然必须执行这次用户补充要求。'
    ].join('\n')
    : [
      '最高优先级规则：',
      '如果本轮没有额外的用户补充要求，就以当前环节任务为唯一目标，不要偏离到其他路线图环节或仓库内无关工作。'
    ].join('\n');

  const priorSessionInstructions = previousSessionId.trim()
    ? [
      '上轮同 Agent 原生会话参考：',
      `- 上一轮会话 ID：${previousSessionId.trim()}`,
      '- 这只是可选参考，不是强制续接命令。',
      '- 只有在你判断确实需要查看上一轮对话细节时，才自行使用这个会话 ID；否则直接按本轮任务执行。',
      '- 即使你查看上一轮对话，本轮仍必须以当前环节任务和本次用户补充为准，不要被旧结论带偏。'
    ].join('\n')
    : '';
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const startupContextText = [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n');
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    startupContextText
  );
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    startupContextText,
    enabledEnhancements
  );
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const githubSecurityContext = buildGithubSecurityContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapLearningRetrievalContext = buildLearningRetrievalContext(workspaceRoot, globalDataPath, {
    projectPath: workspaceRoot,
    runKind: 'step',
    contextText: startupContextText,
    files: attachedFiles
  });
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: node.id || '',
    runKind: 'step',
    contextText: [
      node.title,
      node.stage,
      node.description,
      node.agentPrompt,
      normalizedUserMessage,
      normalizedGithubIssueContext,
      attachedFiles.join('\n')
    ].join('\n'),
    supplementFiles: attachedFiles
  });
  const solomapStartupPackInstructions = buildSolomapStartupPackInstructions({
    workspaceRoot,
    globalDataPath,
    runKind: 'step',
    contextText: startupContextText,
    learningSummaryContext: solomapLearningContext,
    learningRetrievalContext: solomapLearningRetrievalContext,
    executionExperienceContext: solomapExecutionExperienceContext
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, node.id || '', 'step');

  return [
    '你正在 SoloMap 的一个路线图环节中工作。',
    '请把这次调用当成该环节的一次 agent 对话，而不是必须一次性完成整个环节。',
    '这是本次调用的唯一任务。不要执行与本环节无关的仓库记忆、历史会话或其他待办事项。',
    '',
    `项目目录：${workspaceRoot}`,
    `环节：${node.title}`,
    `阶段：${node.stage}`,
    `环节说明：${node.description}`,
    `当前环节状态：${node.status}`,
    ...(completionCriteriaInstructions ? ['', completionCriteriaInstructions] : []),
    '',
    userPriorityInstructions,
    '',
    '本次任务：',
    node.agentPrompt,
    supplement,
    ...(normalizedGithubIssueContext ? ['', normalizedGithubIssueContext] : []),
    ...(githubDeliveryContext ? ['', githubDeliveryContext] : []),
    ...(githubSecurityContext ? ['', githubSecurityContext] : []),
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapStartupPackInstructions,
    '',
    solomapDocumentationInstructions,
    '',
    crossAgentHandoffInstructions,
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    ...(priorSessionInstructions ? ['', priorSessionInstructions] : []),
    memoryInstructions,
    '',
    '闭环要求：',
    '1. 直接在项目目录中完成本次能交付的文件改动或文档产出。除非用户明确要求，否则不要只输出计划或总结。',
    '2. 不要等待用户二次确认；如果任务过大，先交付一个可验证的小闭环，并在输出末尾说明下一次建议继续做什么。',
    '3. 运行你认为最窄且必要的验证命令；如果无法运行，说明原因。',
    '4. 完成后正常退出 CLI 进程。扩展会根据进程退出码记录本轮对话是否成功。',
    completionDecisionFilePath
      ? `5. 如果你判断整个路线图环节已经达到完成标准，请向 ${completionFile} 写入 JSON：{"markCompleted":true,"reason":"一句话说明为什么这个环节已完成"}。如果还需要后续对话，不要写这个文件。`
      : '5. 如果你判断整个路线图环节已经达到完成标准，请在最终输出中明确说明。'
  ].join('\n');
}

function buildRoadmapRevisionPrompt(
  userMessage: string,
  workspaceRoot: string,
  globalPrompt = '',
  supplementFiles: string[] = [],
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次路线图调整附加了补充文件，开始执行前必须先读取这些文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '这些文件是本轮调整的重要上下文；如果它们与历史路线图描述冲突，以这些文件和本次调整要求为准。'
    ].join('\n')
    : '';
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如与本次路线图调整要求冲突，始终以本次路线图调整要求为准。'
    ].join('\n')
    : '';
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const startupContextText = [normalizedUserMessage, attachedFiles.join('\n')].join('\n');
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, startupContextText);
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(workspaceRoot, globalDataPath, startupContextText, enabledEnhancements);
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const githubSecurityContext = buildGithubSecurityContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapLearningRetrievalContext = buildLearningRetrievalContext(workspaceRoot, globalDataPath, {
    projectPath: workspaceRoot,
    runKind: 'roadmap_revision',
    contextText: startupContextText,
    files: attachedFiles
  });
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: roadmapRevisionId,
    runKind: 'roadmap_revision',
    contextText: startupContextText,
    supplementFiles: attachedFiles
  });
  const solomapStartupPackInstructions = buildSolomapStartupPackInstructions({
    workspaceRoot,
    globalDataPath,
    runKind: 'roadmap_revision',
    contextText: startupContextText,
    learningSummaryContext: solomapLearningContext,
    learningRetrievalContext: solomapLearningRetrievalContext,
    executionExperienceContext: solomapExecutionExperienceContext
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, roadmapRevisionId, 'roadmap_revision');
  return [
    '你正在 SoloMap 中调整当前项目路线图。',
    '本轮唯一交付物是根据用户的最新目标，直接更新项目目录中的 `.solopreneur/roadmap.csv`。',
    '',
    `项目目录：${workspaceRoot}`,
    '',
    '本次路线图调整要求（最高优先级）：',
    normalizedUserMessage,
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapStartupPackInstructions,
    '',
    solomapDocumentationInstructions,
    '',
    crossAgentHandoffInstructions,
    ...(githubDeliveryContext ? ['', githubDeliveryContext] : []),
    ...(githubSecurityContext ? ['', githubSecurityContext] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行要求：',
    '1. 先读取当前 `.solopreneur/roadmap.csv`、`.solopreneur/roadmap-methodology.md`、`.solopreneur/validate-roadmap.cjs` 和项目已有文件，理解已经完成的工作与仍待推进的事项。',
    '2. 直接重写 `.solopreneur/roadmap.csv`，让后续环节反映本次调整要求；不要把本段提示词、解释文字或执行日志写进 CSV。',
    '3. 除非用户明确要求推翻已完成工作，否则保留已完成环节的事实和状态，并围绕新方向调整待推进环节、依赖与 Agent 任务。',
    '4. CSV 必须保留字段 `id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`；每个依赖必须指向存在的环节 ID，且不能自依赖。',
    '5. 先判断项目最适配的类型（Core Product / Infrastructure / Content Product / Experiment & Research / Tools & Scaffolding / Archive & Maintenance）：如果是核心产品（商业化产品），待推进路线图必须完整覆盖问题、MVP、营销、反馈规模化等闭环阶段，不可长期只剩工程 Build 任务；若属于基础设施、工具、试验或内容类，按其相应的方法论规范去调整安排后续阶段（例如基础设施需包含设计契约/标准化接入/治理，试验项目包含原型/评估/总结沉淀，内容产品包含生产/分发），不可强行套用营销或销售任务，也不可虚构无关的商业化阶段。',
    '6. 用 Build -> Sell -> Learn -> Improve 作为底层闭环审查，针对性设计每一阶段的 `agentPrompt`。每一个被修改或新增的待推进环节，其 `agentPrompt` 都必须具有落地证据，要求 Agent 直接创建、修改或测试项目本地文件或配置，严禁生成务虚、没有本地产出物的研究或总结环节。',
    '7. 不要把方法论本身写成用户需要维护的说明环节；它只应用来决定后续路线图和下一步动作。',
    '8. 完成后必须运行 `node .solopreneur/validate-roadmap.cjs --mode revision` 校验最终 CSV；如果失败，按输出修正后重新运行，直到通过。',
    '9. 只有校验通过后，才允许在最终回复中说明路线图调整完成并正常退出 CLI。'
  ].join('\n');
}

function buildSoloConversationPrompt(
  userMessage: string,
  workspaceRoot: string,
  globalPrompt = '',
  supplementFiles: string[] = [],
  globalDataPath = '',
  enabledEnhancements: Record<string, boolean> = {}
): string {
  const normalizedUserMessage = userMessage.trim();
  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);
  const supplementFileInstructions = attachedFiles.length > 0
    ? [
      '用户为本次 Solo 对话选择了补充文件：',
      ...attachedFiles.map((file) => `- ${file}`),
      '请先读取这些文件，并仅将它们作为本次问题的背景材料。'
    ].join('\n')
    : '';
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如与本次用户要求冲突，始终以本次用户要求为准。'
    ].join('\n')
    : '';
  const solomapDocumentationInstructions = buildDocumentationPromptContext(workspaceRoot);
  const startupContextText = [normalizedUserMessage, attachedFiles.join('\n')].join('\n');
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, startupContextText);
  const solomapEnhancementInstructions = buildSolomapEnhancementCandidateInstructions(workspaceRoot, globalDataPath, startupContextText, enabledEnhancements);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
  const solomapLearningRetrievalContext = buildLearningRetrievalContext(workspaceRoot, globalDataPath, {
    projectPath: workspaceRoot,
    runKind: 'solo',
    contextText: startupContextText,
    files: attachedFiles
  });
  const solomapExecutionExperienceContext = buildExecutionExperiencePrompt(workspaceRoot, {
    nodeId: soloConversationId,
    runKind: 'solo',
    contextText: startupContextText,
    supplementFiles: attachedFiles
  });
  const solomapStartupPackInstructions = buildSolomapStartupPackInstructions({
    workspaceRoot,
    globalDataPath,
    runKind: 'solo',
    contextText: startupContextText,
    learningSummaryContext: solomapLearningContext,
    learningRetrievalContext: solomapLearningRetrievalContext,
    executionExperienceContext: solomapExecutionExperienceContext
  });
  const crossAgentHandoffInstructions = buildCrossAgentHandoffInstructions(workspaceRoot, soloConversationId, 'solo');
  return [
    '你正在 SoloMap 的 Solo 模式中处理当前项目的一次直接对话。',
    '这次对话尚未归属于任何路线图环节；优先解决用户当前问题，不要要求用户先选择环节。',
    '',
    `项目目录：${workspaceRoot}`,
    '',
    '用户本次要求（最高优先级）：',
    normalizedUserMessage,
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapStartupPackInstructions,
    '',
    solomapDocumentationInstructions,
    '',
    crossAgentHandoffInstructions,
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(solomapEnhancementInstructions ? ['', solomapEnhancementInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行边界：',
    '1. 可以读取当前项目文件与 `.solopreneur/roadmap.csv` 了解背景，但不要自行修改路线图、环节状态、完成标准或环节交接记录。',
    '2. 如果用户要的是讨论、判断或头脑风暴，直接给出有用结论即可，不要求产生文件修改。',
    '3. 如果用户明确要求实现或修复，直接交付可验证的最小改动并运行必要验证。',
    '4. 完成后在结论中用一句话说明本次对话更适合：仅保留在 Solo、关联某个已有环节（写明环节标题），或进入路线图调整。',
    '5. 完成后正常退出 CLI 进程；SoloMap 会保存本次 Solo 对话，由用户决定是否关联路线图环节。'
  ].join('\n');
}

function buildFlowExecutionNodeId(flowId: string, loopId: string, role: FlowRole): string {
  return `__flow__::${flowId}::${loopId}::${role}`;
}

function parseFlowExecutionNodeId(nodeId: string): { flowId: string; loopId: string; role: FlowRole } | null {
  const match = String(nodeId || '').match(/^__flow__::([^:]+)::([^:]+)::(planner|builder|verifier)$/);
  if (!match) {
    return null;
  }
  return {
    flowId: match[1],
    loopId: match[2],
    role: match[3] as FlowRole
  };
}

function extractFlowJsonBlock(output: string): Record<string, any> | null {
  const match = String(output || '').match(/SOLOMAP_FLOW_JSON_START\s*([\s\S]*?)\s*SOLOMAP_FLOW_JSON_END/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function validateFlowPlannerResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Planner 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!String(data.goal || '').trim()) errors.push('goal 不能为空。');
  if (!Array.isArray(data.scope) || data.scope.length === 0) errors.push('scope 至少需要 1 项。');
  if (!Array.isArray(data.successCriteria) || data.successCriteria.length === 0) errors.push('successCriteria 至少需要 1 项。');
  if (!Array.isArray(data.plan) || data.plan.length === 0) errors.push('plan 至少需要 1 项。');
  if (!Array.isArray(data.verificationPlan) || data.verificationPlan.length === 0) errors.push('verificationPlan 至少需要 1 项。');
  return errors;
}

function validateFlowBuilderResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Builder 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!Array.isArray(data.actions) || data.actions.length === 0) errors.push('actions 至少需要 1 项。');
  if (!Array.isArray(data.commandsRun)) errors.push('commandsRun 必须是数组。');
  if (!String(data.recommendedStatus || '').trim()) errors.push('recommendedStatus 不能为空。');
  return errors;
}

function validateFlowVerifierResult(data: Record<string, any> | null): string[] {
  if (!data) {
    return ['未找到 Verifier 的结构化 JSON 结果。'];
  }
  const errors: string[] = [];
  if (!Array.isArray(data.checks) || data.checks.length === 0) errors.push('checks 至少需要 1 项。');
  if (!data.H || typeof data.H.pass !== 'boolean') errors.push('H.pass 必须存在。');
  if (!data.I || typeof data.I.pass !== 'boolean') errors.push('I.pass 必须存在。');
  if (!data.J || typeof data.J.pass !== 'boolean') errors.push('J.pass 必须存在。');
  if (!String(data.recommendedStatus || '').trim()) errors.push('recommendedStatus 不能为空。');
  return errors;
}

function buildFlowPlannerPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  relatedRoadmapStepTitle?: string;
  globalPrompt?: string;
  globalDataPath?: string;
  supplementFiles?: string[];
}): string {
  const contextText = [input.goal, input.relatedRoadmapStepTitle || '', (input.supplementFiles || []).join('\n')].join('\n');
  const learningContext = buildLearningRetrievalContext(input.workspaceRoot, input.globalDataPath || '', {
    projectPath: input.workspaceRoot,
    runKind: 'flow',
    role: 'planner',
    contextText,
    files: input.supplementFiles || []
  });
  const executionExperienceContext = buildExecutionExperiencePrompt(input.workspaceRoot, {
    nodeId: buildFlowExecutionNodeId(input.flowId, input.loopId, 'planner'),
    runKind: 'flow',
    contextText,
    supplementFiles: input.supplementFiles || []
  });
  const startupPack = buildSolomapStartupPackInstructions({
    workspaceRoot: input.workspaceRoot,
    globalDataPath: input.globalDataPath || '',
    runKind: 'flow',
    role: 'planner',
    contextText,
    learningSummaryContext: buildSolomapLearningContext(input.workspaceRoot, input.globalDataPath || ''),
    learningRetrievalContext: learningContext,
    executionExperienceContext
  });
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Planner。',
    '你的唯一任务是：把当前目标拆成一个可执行、可验证、可归因的微观循环计划。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.relatedRoadmapStepTitle ? [`相关路线图环节：${input.relatedRoadmapStepTitle}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    startupPack,
    '',
    '执行要求：',
    '1. 先阅读相关代码、文档和当前项目事实，不要空想方案。',
    '2. 严格按“五看三定”产出结构化规划：目标、范围、边界、路径、风险、验证。',
    '3. 不要执行代码修改，不要运行会改变项目状态的命令；你只负责规划。',
    '4. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"goal":"","scope":[],"outOfScope":[],"successCriteria":[],"plan":[],"affectedAreas":[],"constraints":[],"risks":[],"verificationPlan":[],"nextLoopGoal":""}',
    'SOLOMAP_FLOW_JSON_END',
    '5. 输出前自行检查 JSON 可被直接解析，字段齐全，不要夹杂额外说明。'
  ].join('\n');
}

function buildFlowBuilderPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  planner: Record<string, any>;
  globalPrompt?: string;
  globalDataPath?: string;
  supplementFiles?: string[];
}): string {
  const contextText = [input.goal, JSON.stringify(input.planner), (input.supplementFiles || []).join('\n')].join('\n');
  const learningContext = buildLearningRetrievalContext(input.workspaceRoot, input.globalDataPath || '', {
    projectPath: input.workspaceRoot,
    runKind: 'flow',
    role: 'builder',
    contextText,
    files: input.supplementFiles || []
  });
  const executionExperienceContext = buildExecutionExperiencePrompt(input.workspaceRoot, {
    nodeId: buildFlowExecutionNodeId(input.flowId, input.loopId, 'builder'),
    runKind: 'flow',
    contextText,
    supplementFiles: input.supplementFiles || []
  });
  const startupPack = buildSolomapStartupPackInstructions({
    workspaceRoot: input.workspaceRoot,
    globalDataPath: input.globalDataPath || '',
    runKind: 'flow',
    role: 'builder',
    contextText,
    learningSummaryContext: buildSolomapLearningContext(input.workspaceRoot, input.globalDataPath || ''),
    learningRetrievalContext: learningContext,
    executionExperienceContext
  });
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Builder。',
    '你的唯一任务是：按照 Planner 的微观循环计划直接落地实现并给出结构化实施结果。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    startupPack,
    '',
    'Planner 结构化计划：',
    JSON.stringify(input.planner, null, 2),
    '',
    '执行要求：',
    '1. 直接修改项目文件并运行必要的最窄验证，不要停留在建议。',
    '2. 如果发现 Planner 缺口，先在当前实现里做最小纠偏，不要擅自换目标。',
    '3. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"actions":[],"commandsRun":[],"knownGaps":[],"recommendedStatus":"partial|ready_for_verification|needs_replan","summary":""}',
    'SOLOMAP_FLOW_JSON_END',
    '4. 输出前自行检查 JSON 可解析，且 actions 必须对应真实发生的实施动作。'
  ].join('\n');
}

function buildFlowVerifierPrompt(input: {
  goal: string;
  workspaceRoot: string;
  flowId: string;
  loopId: string;
  planner: Record<string, any>;
  builder: Record<string, any>;
  evidence: {
    changedFilesSummary: string;
    touchedFilesSummary: string;
    outputTail: string;
  };
  globalPrompt?: string;
  globalDataPath?: string;
  supplementFiles?: string[];
}): string {
  const touchedFiles = (input.evidence.touchedFilesSummary || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const contextText = [
    input.goal,
    JSON.stringify(input.planner),
    JSON.stringify(input.builder),
    input.evidence.changedFilesSummary,
    input.evidence.touchedFilesSummary
  ].join('\n');
  const learningContext = buildLearningRetrievalContext(input.workspaceRoot, input.globalDataPath || '', {
    projectPath: input.workspaceRoot,
    runKind: 'flow',
    role: 'verifier',
    contextText,
    files: touchedFiles
  });
  const executionExperienceContext = buildExecutionExperiencePrompt(input.workspaceRoot, {
    nodeId: buildFlowExecutionNodeId(input.flowId, input.loopId, 'verifier'),
    runKind: 'flow',
    contextText,
    supplementFiles: touchedFiles
  });
  const startupPack = buildSolomapStartupPackInstructions({
    workspaceRoot: input.workspaceRoot,
    globalDataPath: input.globalDataPath || '',
    runKind: 'flow',
    role: 'verifier',
    contextText,
    learningSummaryContext: buildSolomapLearningContext(input.workspaceRoot, input.globalDataPath || ''),
    learningRetrievalContext: learningContext,
    executionExperienceContext
  });
  return [
    '你正在 SoloMap 的 Flow 模式中担任 Verifier。',
    '你的唯一任务是：基于 Planner 意图、Builder 结果和真实证据，判断这一轮微观循环是否闭环。',
    '',
    `项目目录：${input.workspaceRoot}`,
    `Flow ID：${input.flowId}`,
    `微循环：${input.loopId}`,
    `用户目标：${input.goal}`,
    ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? [`补充文件：${input.supplementFiles.join(', ')}`] : []),
    ...(input.globalPrompt ? ['', '用户设置的全局默认要求：', input.globalPrompt] : []),
    '',
    startupPack,
    '',
    'Planner JSON：',
    JSON.stringify(input.planner, null, 2),
    '',
    'Builder JSON：',
    JSON.stringify(input.builder, null, 2),
    '',
    '真实证据：',
    `Workspace changes:\n${input.evidence.changedFilesSummary || '无'}`,
    `Touched project files:\n${input.evidence.touchedFilesSummary || '无'}`,
    `Agent output tail:\n${input.evidence.outputTail || '无'}`,
    '',
    '执行要求：',
    '1. 用 H/I/J 评审：H=硬证据，I=意图与边界，J=工程判断。',
    '2. 不要凭感觉说通过；每个 pass/fail 都要引用真实证据。',
    '3. 最终只输出一个 JSON，必须包在以下标记之间：',
    'SOLOMAP_FLOW_JSON_START',
    '{"checks":[],"H":{"pass":false,"reason":""},"I":{"pass":false,"reason":""},"J":{"pass":false,"reason":""},"recommendedStatus":"completed|partial|implemented_unverified|verified_failed|deviated|needs_user_confirmation","nextLoopGoal":"","summary":""}',
    'SOLOMAP_FLOW_JSON_END',
    '4. 输出前自行检查 JSON 可解析，不要夹带额外正文。'
  ].join('\n');
}

function deriveFlowLoopScoring(verifier: Record<string, any> | null, changedFilesSummary: string, touchedFilesSummary: string): FlowLoopScoring {
  const hPass = Boolean(verifier?.H?.pass) && Boolean(changedFilesSummary.trim() || touchedFilesSummary.trim());
  const iPass = Boolean(verifier?.I?.pass);
  const jPass = Boolean(verifier?.J?.pass);
  let recommendedStatus: FlowLoopStatus = 'implemented_unverified';
  if (String(verifier?.recommendedStatus || '') === 'needs_user_confirmation') {
    recommendedStatus = 'needs_user_confirmation';
  } else if (!hPass && !changedFilesSummary.trim() && !touchedFilesSummary.trim()) {
    recommendedStatus = 'no_effect';
  } else if (!hPass) {
    recommendedStatus = 'implemented_unverified';
  } else if (!iPass) {
    recommendedStatus = 'deviated';
  } else if (String(verifier?.recommendedStatus || '') === 'verified_failed') {
    recommendedStatus = 'verified_failed';
  } else if (String(verifier?.recommendedStatus || '') === 'partial') {
    recommendedStatus = 'partial';
  } else if ((String(verifier?.recommendedStatus || '') === 'completed' || String(verifier?.recommendedStatus || '') === 'closed') && hPass && iPass) {
    recommendedStatus = 'closed';
  }
  return {
    hardEvidencePass: hPass,
    intentPass: iPass,
    judgmentPass: jPass,
    recommendedStatus,
    reasons: [
      verifier?.H?.reason ? `H: ${String(verifier.H.reason)}` : '',
      verifier?.I?.reason ? `I: ${String(verifier.I.reason)}` : '',
      verifier?.J?.reason ? `J: ${String(verifier.J.reason)}` : ''
    ].filter(Boolean)
  };
}

function buildAgentShellScript(
  agentCli: string,
  selectedModel: string,
  conversationPrompt: string,
  workspaceRoot: string,
  nodeId: string,
  executionLogId: number,
  userMessage: string,
  completionDecisionFilePath?: string,
  nativeSessionId = '',
  directExecutionCommand = '',
  runKind = 'step',
  roadmapBackupFilePath = '',
  globalDataPath = '',
  taskPermissionMode = 'auto',
  reviewerCliPath = '',
  collaborationReviewMode = 'high_risk',
  enabledEnhancements: Record<string, boolean> = {},
  runDirOverride = '',
  statusFilePathOverride = ''
): { finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  let effectiveSelectedModel = selectedModel;
  let effectiveConversationPrompt = conversationPrompt;
  let effectiveWorkspaceRoot = workspaceRoot;
  let effectiveNodeId = nodeId;
  let effectiveExecutionLogId = executionLogId;
  let effectiveUserMessage = userMessage;
  let effectiveCompletionDecisionFilePath = completionDecisionFilePath;
  let effectiveNativeSessionId = nativeSessionId;
  let effectiveDirectExecutionCommand = directExecutionCommand;
  let effectiveRunKind = runKind;
  let effectiveRoadmapBackupFilePath = roadmapBackupFilePath;
  let effectiveGlobalDataPath = globalDataPath;
  let effectiveTaskPermissionMode = taskPermissionMode;
  let effectiveReviewerCliPath = reviewerCliPath;
  let effectiveCollaborationReviewMode = collaborationReviewMode;
  let effectiveEnabledEnhancements = enabledEnhancements;
  let effectiveRunDirOverride = runDirOverride;
  let effectiveStatusFilePathOverride = statusFilePathOverride;

  if (typeof executionLogId !== 'number') {
    effectiveSelectedModel = '';
    effectiveConversationPrompt = selectedModel;
    effectiveWorkspaceRoot = conversationPrompt;
    effectiveNodeId = String(workspaceRoot || '');
    effectiveExecutionLogId = Number(nodeId) || 0;
    effectiveUserMessage = String(executionLogId || '');
    effectiveCompletionDecisionFilePath = typeof userMessage === 'string' && userMessage ? userMessage : undefined;
    effectiveNativeSessionId = completionDecisionFilePath || '';
    effectiveDirectExecutionCommand = nativeSessionId || '';
    effectiveRunKind = directExecutionCommand || 'step';
    effectiveRoadmapBackupFilePath = runKind || '';
    effectiveGlobalDataPath = roadmapBackupFilePath || '';
    effectiveTaskPermissionMode = globalDataPath || 'auto';
    effectiveReviewerCliPath = taskPermissionMode || '';
    effectiveCollaborationReviewMode = reviewerCliPath || 'high_risk';
    effectiveEnabledEnhancements = (collaborationReviewMode && typeof collaborationReviewMode === 'object')
      ? collaborationReviewMode as Record<string, boolean>
      : {};
    effectiveRunDirOverride = typeof enabledEnhancements === 'string' ? enabledEnhancements : '';
    effectiveStatusFilePathOverride = runDirOverride || '';
  }
  const runDir = effectiveRunDirOverride || path.join(effectiveWorkspaceRoot, '.solopreneur', 'agent-runs', effectiveNodeId);
  const statusFilePath = effectiveStatusFilePathOverride || path.join(effectiveWorkspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runScriptPath = path.join(runDir, 'run-agent.sh');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const startedAtFilePath = path.join(runDir, 'started_at');
  const sessionFilePath = path.join(runDir, 'session.json');
  const codexHomeFilePath = path.join(runDir, 'codex-home.txt');
  const decisionFilePath = effectiveCompletionDecisionFilePath || path.join(runDir, 'completion.json');
  const agentProvider = getAgentProvider(agentCli);
  const sessionKey = getAgentSessionKey(agentCli);
  const sessionMode = effectiveNativeSessionId.trim() ? 'fresh-with-reference' : 'fresh';
  const startedAt = new Date().toISOString();
  const loggedCommand = effectiveDirectExecutionCommand || buildAgentCommandForPromptFile(agentCli, promptFilePath, effectiveWorkspaceRoot, effectiveTaskPermissionMode, effectiveSelectedModel);
  const commandPreview = effectiveDirectExecutionCommand ? loggedCommand : `${agentCli} [${sessionMode}]`;
  const executionCommand = effectiveDirectExecutionCommand || buildAgentCommandForPromptFile(agentCli, promptFilePath, effectiveWorkspaceRoot, effectiveTaskPermissionMode, effectiveSelectedModel);
  const statusBase = { workspaceRoot: effectiveWorkspaceRoot, nodeId: effectiveNodeId, runKind: effectiveRunKind, roadmapBackupFilePath: effectiveRoadmapBackupFilePath, globalDataPath: effectiveGlobalDataPath, agentCli, selectedModel: effectiveSelectedModel, commandPreview, commandFilePath, promptFilePath, executionLogId: effectiveExecutionLogId, userMessage: effectiveUserMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, codexHomeFilePath, nativeSessionId: effectiveNativeSessionId, sessionKey, sessionProvider: agentProvider, sessionMode, startedAt, reviewerCliPath: effectiveReviewerCliPath, collaborationReviewMode: effectiveCollaborationReviewMode };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_exit_failed', failureReason: 'Agent CLI exited before completing this task.' });
  const noChangesStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'no_deliverable_changes', failureReason: 'Agent exited without project file changes or a completion decision.' });
  const sessionCaptureScript = buildSessionCaptureScript(agentProvider, effectiveWorkspaceRoot, startedAtFilePath, outputFilePath, sessionFilePath);
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(effectiveWorkspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(effectiveWorkspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const enhancementRuntime = ensureSolomapEnhancementRuntime(effectiveWorkspaceRoot, effectiveGlobalDataPath, effectiveEnabledEnhancements);
  const enhancementContextFilePath = path.join(runDir, 'harness-enhancements.md');
  const enhancementContextPreflight = buildSolomapEnhancementContextPreflight(effectiveWorkspaceRoot, enhancementContextFilePath, effectiveUserMessage, enhancementRuntime.runtimeRoot, effectiveEnabledEnhancements);
  const enhancementRuntimeInstructions = buildSolomapEnhancementRuntimeInstructions(enhancementContextFilePath, effectiveEnabledEnhancements);
  const promptExportScript = effectiveDirectExecutionCommand
    ? [`agent_prompt=$(cat ${shellQuote(promptFilePath)})`, 'export agent_prompt']
    : [];
  const terminalExecutionScript = (effectiveRunKind === 'solo_continue' || effectiveRunKind === 'step_continue')
    ? [
      'if command -v script >/dev/null 2>&1; then',
      `script -q -f -e -c ${shellQuote(executionCommand)} ${shellQuote(outputFilePath)};`,
      'status=$?;',
      'else',
      `(${executionCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
      'status=${PIPESTATUS[0]};',
      'fi'
    ].join(' ')
    : [
      `(${executionCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
      'status=${PIPESTATUS[0]}'
    ].join(' ');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(promptFilePath, enhancementRuntimeInstructions ? [effectiveConversationPrompt, '', enhancementRuntimeInstructions].join('\n') : effectiveConversationPrompt, 'utf8');
  fs.writeFileSync(commandFilePath, loggedCommand, 'utf8');
  const script = [
    `cd ${shellQuote(effectiveWorkspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    ...enhancementRuntime.envLines,
    `mkdir -p ${shellQuote(runDir)}`,
    `touch ${shellQuote(startedAtFilePath)}`,
    agentProvider === 'codex' ? `printf '%s\\n' "\${CODEX_HOME:-$HOME/.codex}" > ${shellQuote(codexHomeFilePath)}` : '',
    workspaceSnapshotScript,
    `printf %s ${shellQuote(JSON.stringify({ markCompleted: false }))} > ${shellQuote(decisionFilePath)}`,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    `while true; do sleep 30; touch ${shellQuote(statusFilePath)}; done & solomap_status_heartbeat_pid=$!`,
    ...enhancementRuntime.preflightLines,
    ...enhancementContextPreflight,
    ...promptExportScript,
    terminalExecutionScript,
    `kill "$solomap_status_heartbeat_pid" 2>/dev/null || true`,
    sessionCaptureScript,
    `git -C ${shellQuote(effectiveWorkspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `if [ ${shellQuote(effectiveRunKind)} != 'solo' ] && [ ${shellQuote(effectiveRunKind)} != 'solo_continue' ] && [ ${shellQuote(effectiveRunKind)} != 'step_continue' ] && [ $status -eq 0 ] && [ ! -s ${shellQuote(changesFilePath)} ] && [ ! -s ${shellQuote(touchedFilesPath)} ] && ! grep -q '"markCompleted"[[:space:]]*:[[:space:]]*true' ${shellQuote(decisionFilePath)} 2>/dev/null; then status=125; printf '\\nSoloMap: Agent exited without project file changes or a completion decision. Marking this run as failed so it can be retried.\\n' >> ${shellQuote(outputFilePath)}; printf %s ${shellQuote(noChangesStatus)} > ${shellQuote(statusFilePath)}; elif [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].filter(Boolean).join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });

  return {
    finalCommand: `bash ${shellQuote(runScriptPath)}`,
    outputFilePath,
    changesFilePath,
    commandFilePath,
    promptFilePath,
    runScriptPath
  };
}

function buildCodexContinuationRunnerScript(
  runnerFilePath: string,
  workspaceRoot: string,
  threadId: string,
  promptText: string,
  sessionFilePath: string,
  selectedModel = ''
): void {
  const runnerSource = `
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const workspaceRoot = ${JSON.stringify(workspaceRoot)};
const threadId = ${JSON.stringify(threadId)};
const promptText = ${JSON.stringify(promptText)};
const sessionFilePath = ${JSON.stringify(sessionFilePath)};
const selectedModel = ${JSON.stringify(selectedModel)};

const proc = spawn('codex', ['app-server'], {
  cwd: workspaceRoot,
  stdio: ['pipe', 'pipe', 'pipe']
});

const output = process.stdout;
const errors = process.stderr;
const rl = readline.createInterface({ input: proc.stdout });

let finished = false;
let resumedThreadId = threadId;
let latestTurnId = '';
let assistantBuffer = '';
let lastError = '';

function send(message) {
  proc.stdin.write(JSON.stringify(message) + '\\n');
}

function writeSession(thread) {
  if (!thread || !thread.id) return;
  fs.mkdirSync(require('path').dirname(sessionFilePath), { recursive: true });
  fs.writeFileSync(sessionFilePath, JSON.stringify({
    sessionId: String(thread.id),
    source: 'codex_app_server',
    updatedAt: new Date().toISOString()
  }) + '\\n', 'utf8');
}

function fail(message, code = 1) {
  if (finished) return;
  finished = true;
  if (message) {
    process.stderr.write(String(message).trim() + '\\n');
  }
  proc.kill('SIGTERM');
  process.exit(code);
}

function complete() {
  if (finished) return;
  finished = true;
  if (assistantBuffer.trim()) {
    output.write('\\n');
  }
  proc.kill('SIGTERM');
  process.exit(0);
}

errors.on('data', (chunk) => {
  process.stderr.write(chunk);
});

proc.on('error', (error) => {
  fail(error instanceof Error ? error.message : String(error));
});

proc.on('exit', (code) => {
  if (!finished) {
    fail(lastError || 'Codex app-server exited before turn completion.', Number(code || 1));
  }
});

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (error) {
    process.stderr.write(line + '\\n');
    return;
  }
  if (msg.error) {
    lastError = String(msg.error.message || 'Unknown Codex app-server error');
    fail(lastError, 1);
    return;
  }
  if (msg.id === 1 && msg.result && msg.result.thread) {
    resumedThreadId = String(msg.result.thread.id || threadId);
    writeSession(msg.result.thread);
    send({
      method: 'turn/start',
      id: 2,
      params: {
        threadId: resumedThreadId,
        input: [{ type: 'text', text: promptText }],
        ...(selectedModel ? { model: selectedModel } : {})
      }
    });
    return;
  }
  if (msg.id === 2 && msg.result && msg.result.turn) {
    latestTurnId = String(msg.result.turn.id || '');
    return;
  }
  if (msg.method === 'item/agentMessage/delta') {
    const delta = String(msg.params?.delta || '');
    assistantBuffer += delta;
    output.write(delta);
    return;
  }
  if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
    const text = String(msg.params.item.text || '');
    if (text && !assistantBuffer) {
      assistantBuffer = text;
      output.write(text);
    }
    return;
  }
  if (msg.method === 'turn/completed') {
    const turn = msg.params?.turn || {};
    const status = String(turn.status || '').toLowerCase();
    if (status === 'completed') {
      complete();
      return;
    }
    fail('Codex turn did not complete successfully: ' + status, 1);
  }
});

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: {
      name: 'solomap_vscode',
      title: 'SoloMap VS Code Extension',
      version: '0.1.0'
    }
  }
});
send({ method: 'initialized', params: {} });
send({
  method: 'thread/resume',
  id: 1,
  params: {
    threadId,
    cwd: workspaceRoot,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ...(selectedModel ? { model: selectedModel } : {})
  }
});
`;
  fs.writeFileSync(runnerFilePath, runnerSource, { encoding: 'utf8', mode: 0o755 });
}

function isReviewableRunKind(runKind: string, nodeId: string): boolean {
  return runKind !== 'agent_review' && !isContinuationRunKind(runKind);
}

function shouldRunAgentReview(
  mode: string,
  runKind: string,
  nodeId: string,
  nextStatus: string,
  changedFilesSummary: string,
  touchedFilesSummary: string
): boolean {
  const normalizedMode = normalizeCollaborationReviewMode(mode);
  if (normalizedMode === 'off' || !isReviewableRunKind(runKind, nodeId)) {
    return false;
  }
  if (!['Completed', 'In Progress'].includes(nextStatus)) {
    return false;
  }
  if (normalizedMode === 'all') {
    return true;
  }
  const combined = [changedFilesSummary, touchedFilesSummary].join('\n');
  return Boolean(combined.trim() || runKind === 'roadmap_revision' || nextStatus === 'Completed');
}

function buildAgentReviewPrompt(input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  userMessage: string;
  mainAgentCli: string;
  mainStatus: string;
  mainResolvedCommand: string;
  completionReason: string;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  reviewResultFilePath: string;
}): string {
  return [
    '# SoloMap 副 Agent 复核任务',
    '',
    '你是本轮任务的只读复核 Agent。你的职责是判断主 Agent 的交付是否足以闭环，不要修改项目文件，不要提交，不要发布，不要删除文件。',
    '',
    '## 复核目标',
    '- 检查用户原始目标是否被满足。',
    '- 检查主 Agent 是否留下足够完成证据。',
    '- 检查是否还需要验证、用户确认或继续修正。',
    '- 如果涉及普通用户可见界面、内容或文案，额外检查是否残留工程自描述、维护者口吻、模板说明或实现痕迹。',
    '',
    '## 必须输出',
    `请把复核结论写入：${input.reviewResultFilePath}`,
    'JSON 格式必须是：',
    '{"status":"pass|revise|needs_user_confirmation","summary":"一句话结论","findings":["可执行问题或确认点"],"nextAction":"下一步动作"}',
    '',
    'status 含义：',
    '- pass：可以接受本轮结果。',
    '- revise：有明确可执行问题，应打回主 Agent 继续修正。',
    '- needs_user_confirmation：涉及授权、产品取舍、发布、删除或无法由证据裁决的问题，需要用户确认。',
    '',
    '## 本轮事实',
    `- workspace: ${input.workspaceRoot}`,
    `- nodeId: ${input.nodeId}`,
    `- runKind: ${input.runKind}`,
    `- mainAgent: ${input.mainAgentCli}`,
    `- mainStatus: ${input.mainStatus}`,
    input.userMessage ? `- userSupplement: ${input.userMessage}` : '- userSupplement: 无',
    input.completionReason ? `- completionDecision: ${input.completionReason}` : '- completionDecision: 无',
    input.mainResolvedCommand ? `- mainCommand: ${input.mainResolvedCommand}` : '',
    '',
    '## Workspace changes',
    input.changedFilesSummary || 'No captured git changes.',
    '',
    '## Touched files',
    input.touchedFilesSummary || 'No captured touched files.',
    '',
    '## Main Agent output tail',
    input.outputTail || 'No captured output tail.',
    '',
    '## 约束',
    '- 只读复核，不改文件。',
    '- 不要输出长篇讨论。',
    '- 如果没有足够证据确认完成，应选择 revise 或 needs_user_confirmation。',
    '- 完成写入 JSON 后正常退出。'
  ].filter(Boolean).join('\n');
}

function parseAgentReviewResult(resultFilePath: string): { status: string; summary: string; findings: string[]; nextAction: string } {
  if (!resultFilePath || !fs.existsSync(resultFilePath)) {
    return { status: 'needs_user_confirmation', summary: '复核结果文件不存在。', findings: [], nextAction: '请查看复核运行输出。' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
    const status = ['pass', 'revise', 'needs_user_confirmation'].includes(String(parsed.status || ''))
      ? String(parsed.status)
      : 'needs_user_confirmation';
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((item: unknown) => compactLine(String(item || ''), 260)).filter(Boolean).slice(0, 8)
      : [];
    return {
      status,
      summary: compactLine(String(parsed.summary || ''), 500),
      findings,
      nextAction: compactLine(String(parsed.nextAction || ''), 500)
    };
  } catch {
    return { status: 'needs_user_confirmation', summary: '复核结果文件无法解析。', findings: [], nextAction: '请查看复核运行输出。' };
  }
}

function formatAgentReviewResult(result: { status: string; summary: string; findings: string[]; nextAction: string }): string {
  return [
    `Review decision: ${result.status}`,
    result.summary ? `Review summary: ${result.summary}` : '',
    result.findings.length > 0 ? `Review findings:\n${result.findings.map((item) => `- ${item}`).join('\n')}` : '',
    result.nextAction ? `Review next action: ${result.nextAction}` : ''
  ].filter(Boolean).join('\n');
}

function hasAgentReviewForExecution(nodeId: string, mainExecutionLogId: number): boolean {
  if (!syncEngine || !mainExecutionLogId || typeof syncEngine.getAgentExecutions !== 'function') {
    return false;
  }
  return syncEngine.getAgentExecutions(nodeId).some((conversation) => {
    const output = String(conversation?.output || '');
    return new RegExp(`Review of execution:\\s*${mainExecutionLogId}(\\D|$)`).test(output);
  });
}

function startAgentReviewRun(input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  reviewerCli: string;
  mainAgentCli: string;
  mainExecutionLogId: number;
  mainResolvedCommand: string;
  userMessage: string;
  mainStatus: string;
  completionReason: string;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  targetStatus: string;
  globalDataPath: string;
  taskPermissionMode: string;
}): void {
  if (!syncEngine) {
    return;
  }
  const reviewRunId = `review-${input.mainExecutionLogId || Date.now()}`;
  const runDir = path.join(input.workspaceRoot, '.solopreneur', 'agent-runs', input.nodeId, reviewRunId);
  const statusFilePath = path.join(input.workspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runScriptPath = path.join(runDir, 'run-agent-review.sh');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const reviewResultFilePath = path.join(runDir, 'review-result.json');
  const startedAt = new Date().toISOString();
  fs.mkdirSync(runDir, { recursive: true });

  const prompt = buildAgentReviewPrompt({
    workspaceRoot: input.workspaceRoot,
    nodeId: input.nodeId,
    runKind: input.runKind,
    userMessage: input.userMessage,
    mainAgentCli: input.mainAgentCli,
    mainStatus: input.mainStatus,
    mainResolvedCommand: input.mainResolvedCommand,
    completionReason: input.completionReason,
    changedFilesSummary: input.changedFilesSummary,
    touchedFilesSummary: input.touchedFilesSummary,
    outputTail: input.outputTail,
    reviewResultFilePath
  });
  fs.writeFileSync(promptFilePath, prompt, 'utf8');

  const loggedCommand = buildAgentCommandForPromptFile(input.reviewerCli, promptFilePath, input.workspaceRoot, input.taskPermissionMode);
  fs.writeFileSync(commandFilePath, loggedCommand, 'utf8');
  const executionLogId = syncEngine.logAgentExecution(
    input.nodeId,
    input.reviewerCli,
    loggedCommand,
    [
      'Agent review started.',
      `Review of execution: ${input.mainExecutionLogId}`,
      `Run started at: ${startedAt}`,
      input.userMessage.trim() ? `User supplement:\n${input.userMessage.trim()}` : ''
    ].filter(Boolean).join('\n\n'),
    'Running'
  );

  const statusBase = {
    workspaceRoot: input.workspaceRoot,
    nodeId: input.nodeId,
    runKind: 'agent_review',
    globalDataPath: input.globalDataPath,
    agentCli: input.reviewerCli,
    commandPreview: `${input.reviewerCli} [review]`,
    commandFilePath,
    executionLogId,
    userMessage: input.userMessage,
    outputFilePath,
    changesFilePath,
    touchedFilesPath,
    reviewResultFilePath,
    reviewOfExecutionLogId: input.mainExecutionLogId,
    reviewTargetStatus: input.targetStatus,
    startedAt
  };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_review_failed', failureReason: 'Review Agent exited before writing a valid review decision.' });
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(input.workspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(input.workspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const terminalExecutionScript = [
    `(${loggedCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
    'status=${PIPESTATUS[0]}'
  ].join(' ');
  const script = [
    `cd ${shellQuote(input.workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    `mkdir -p ${shellQuote(runDir)}`,
    workspaceSnapshotScript,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    `while true; do sleep 30; touch ${shellQuote(statusFilePath)}; done & solomap_status_heartbeat_pid=$!`,
    terminalExecutionScript,
    `kill "$solomap_status_heartbeat_pid" 2>/dev/null || true`,
    `git -C ${shellQuote(input.workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `node -e 'const fs=require("fs");try{const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p,"utf8"));if(!["pass","revise","needs_user_confirmation"].includes(String(v.status||""))) process.exit(2);}catch(e){process.exit(2)}' ${shellQuote(reviewResultFilePath)} || status=125`,
    `if [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });

  launchAgentConversationTerminal({
    workspaceRoot: input.workspaceRoot,
    label: `review-${input.nodeId}-${executionLogId}`,
    conversationId: executionLogId,
    command: `bash ${shellQuote(runScriptPath)}`,
    refreshNodeId: input.nodeId
  });
}

function getOutputTail(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  const content = cleanTerminalControlSequences(fs.readFileSync(filePath, 'utf8'))
    .trim();
  if (content.length <= 4000) {
    return content;
  }

  return content.slice(-4000);
}

function cleanTerminalControlSequences(value: string): string {
  return String(value || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/(?:^|[\r\n])?0;[^\x07\r\n]{0,160}\x07/g, '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\x07/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

function getChangedFilesSummary(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return 'No git workspace changes were detected or this workspace is not a Git repository.';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content || 'No workspace file changes detected.';
}

function getTouchedFilesSummary(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return 'No project files were touched during this run.';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content || 'No project files were touched during this run.';
}

function hasRecordedWorkspaceChanges(changedFilesSummary: string, touchedFilesSummary: string): boolean {
  const noGitChanges = changedFilesSummary === 'No workspace file changes detected.'
    || changedFilesSummary === 'No git workspace changes were detected or this workspace is not a Git repository.';
  const noTouchedFiles = touchedFilesSummary === 'No project files were touched during this run.';
  return !noGitChanges || !noTouchedFiles;
}

function buildLocalRoadmap(prompt: string, cliPath: string): RoadmapNode[] {
  const now = new Date().toISOString();
  const safePrompt = prompt.trim() || '新的独立开发项目';
  return [
    {
      id: '1',
      title: '生成初始路线图',
      description: `基于当前项目文件和你对“${safePrompt}”的理解，直接重写 .solopreneur/roadmap.csv，生成这个项目真正要执行的定制化路线图。`,
      stage: '目标与路径确认',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md、.solopreneur/roadmap-methodology.md 和 .solopreneur/validate-roadmap.cjs，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后必须运行 node .solopreneur/validate-roadmap.cjs --mode bootstrap；校验失败就修正 CSV 并重跑，直到通过后才算完成。',
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '2',
      title: '明确交付目标与成功标准',
      description: `把“${safePrompt}”的目标、使用对象、边界和可验证成功标准整理清楚。`,
      stage: '目标与路径确认',
      dependencies: '1',
      agentCli: cliPath,
      agentPrompt: `为“${safePrompt}”创建 docs/project-brief.md，包含交付目标、使用对象、成功标准、范围边界、风险和下一步行动；若证据表明这是对外产品，再补充客户验证要求。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '3',
      title: '交付首个可验证切片',
      description: '把目标转成可以运行、查看或按文档验收的最小交付结果。',
      stage: '交付与验证',
      dependencies: '2',
      agentCli: cliPath,
      agentPrompt: `阅读 docs/project-brief.md，为“${safePrompt}”实现首个可验证切片，产出项目文件或 docs/delivery-slice.md，并记录最窄验证命令。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '4',
      title: '验证结果并安排下一轮',
      description: '收集本次交付的使用、运行或验收结果，并把反馈转成下一轮动作。',
      stage: '结果反馈与迭代',
      dependencies: '3',
      agentCli: cliPath,
      agentPrompt: `基于当前交付，为“${safePrompt}”创建 docs/iteration-review.md，记录验证证据、反馈来源、未解决问题和下一轮改进任务；若这是对外产品，加入触达与用户反馈动作。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    }
  ];
}

function postNodeConversations(nodeId: string, fallbackConversations: import('./db/types').AgentConversation[] = []): void {
  if (syncEngine && activePanel) {
    const conversations = syncEngine.getAgentExecutions(nodeId);
    const payloadConversations = conversations.length > 0 ? conversations : fallbackConversations;
    activePanel.webview.postMessage({
      command: 'nodeConversationsLoaded',
      nodeId,
      conversations: buildConversationPresentations(activeProjectRoot || '', nodeId, payloadConversations),
      projectPath: activeProjectRoot || ''
    });
  }
  if (nodeId === soloConversationId && sidebarProvider && activeProjectRoot) {
    void sidebarProvider.sendSoloConversationHistory(activeProjectRoot);
  } else if (sidebarProvider && activeProjectRoot) {
    void sidebarProvider.sendStepConversationHistory(activeProjectRoot, nodeId);
    if (nodeId !== roadmapRevisionId) {
      void sidebarProvider.sendProjectConversationHistory(activeProjectRoot);
    }
  }
}

function getAgentStatusRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', agentStatusDirName);
}

function getAgentStatusFilePath(workspaceRoot: string, executionLogId: number): string {
  return path.join(getAgentStatusRoot(workspaceRoot), `${Number(executionLogId || 0)}.json`);
}

function inferWorkspaceRootFromStatusFilePath(statusFilePath: string): string {
  const normalizedPath = String(statusFilePath || '').trim();
  if (!normalizedPath) {
    return '';
  }
  const fileName = path.basename(normalizedPath);
  const statusDir = path.dirname(normalizedPath);
  if (fileName === '.agent_status.json') {
    return statusDir;
  }
  if (path.basename(statusDir) === agentStatusDirName && path.basename(path.dirname(statusDir)) === '.solopreneur') {
    return path.dirname(path.dirname(statusDir));
  }
  return '';
}

function findAgentStatusForConversation(workspaceRoot: string, conversationId: number): any | null {
  const statusRoot = getAgentStatusRoot(workspaceRoot);
  const directStatus = readAgentStatus(getAgentStatusFilePath(workspaceRoot, conversationId));
  if (directStatus) {
    return directStatus;
  }
  const legacyStatus = readAgentStatus(path.join(workspaceRoot, '.agent_status.json'));
  if (legacyStatus && Number(legacyStatus.executionLogId || 0) === Number(conversationId || 0)) {
    return legacyStatus;
  }
  try {
    if (!fs.existsSync(statusRoot)) {
      return null;
    }
    for (const fileName of fs.readdirSync(statusRoot)) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      const candidate = readAgentStatus(path.join(statusRoot, fileName));
      if (candidate && Number(candidate.executionLogId || 0) === Number(conversationId || 0)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function makeAgentTerminalName(workspaceRoot: string, label: string): string {
  agentTerminalCounter += 1;
  const projectName = path.basename(workspaceRoot);
  const cleanLabel = String(label || 'run').replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 40) || 'run';
  return `${projectName} · ${cleanLabel} · ${agentTerminalCounter} (${agentTerminalBaseName})`;
}

function findActiveAgentTerminal(conversationId = 0): vscode.Terminal | undefined {
  const terminals = [...vscode.window.terminals];
  const mappedName = conversationId ? agentTerminalNamesByConversationId.get(Number(conversationId)) : '';
  if (mappedName) {
    const mapped = terminals.find((candidate) => candidate.name === mappedName);
    if (mapped) {
      return mapped;
    }
  }
  if (activeAgentTerminalName) {
    const active = terminals.find((candidate) => candidate.name === activeAgentTerminalName);
    if (active) {
      return active;
    }
  }
  return terminals.reverse().find((candidate) => candidate.name.includes(agentTerminalBaseName));
}

function createAgentTerminal(workspaceRoot: string, label: string, conversationId = 0): vscode.Terminal {
  const terminalName = makeAgentTerminalName(workspaceRoot, label);
  activeAgentTerminalName = terminalName;
  if (conversationId) {
    agentTerminalNamesByConversationId.set(Number(conversationId), terminalName);
    agentTerminalProjectRootsByConversationId.set(Number(conversationId), workspaceRoot);
  }
  let iconPath: vscode.Uri | vscode.ThemeIcon;
  if (extensionContextRef) {
    iconPath = vscode.Uri.joinPath(extensionContextRef.extensionUri, 'resources', 'logo.svg');
  } else {
    iconPath = new vscode.ThemeIcon('symbol-string');
  }
  return vscode.window.createTerminal({
    name: terminalName,
    iconPath: iconPath,
    color: new vscode.ThemeColor('terminal.ansiCyan'),
    cwd: workspaceRoot,
  });
}

function launchAgentConversationTerminal(input: {
  workspaceRoot: string;
  label: string;
  conversationId?: number;
  command: string;
  refreshNodeId?: string;
}): vscode.Terminal {
  const terminal = createAgentTerminal(input.workspaceRoot, input.label, input.conversationId || 0);
  terminal.show(true);
  terminal.sendText(input.command);
  if (input.refreshNodeId) {
    postNodeConversations(input.refreshNodeId);
  }
  return terminal;
}

async function handleAgentTerminalClosed(terminalName: string): Promise<boolean> {
  const matched = [...agentTerminalNamesByConversationId.entries()]
    .find(([, name]) => name === terminalName);
  if (!matched) {
    return false;
  }
  const [conversationId] = matched;
  const workspaceRoot = agentTerminalProjectRootsByConversationId.get(Number(conversationId)) || activeProjectRoot || '';
  agentTerminalNamesByConversationId.delete(Number(conversationId));
  agentTerminalProjectRootsByConversationId.delete(Number(conversationId));
  if (!workspaceRoot) {
    return false;
  }
  const runningStatus = findAgentStatusForConversation(workspaceRoot, Number(conversationId));
  if (!runningStatus || String(runningStatus.status || '') !== 'Running') {
    return false;
  }
  const statusFilePath = getAgentStatusFilePath(workspaceRoot, Number(runningStatus.executionLogId || conversationId));
  const isContinuationRun = isContinuationRunKind(String(runningStatus.runKind || ''));
  const finishedAt = new Date().toISOString();
  if (runningStatus.outputFilePath) {
    fs.appendFileSync(
      runningStatus.outputFilePath,
      isContinuationRun ? '\nSoloMap: Continuation terminal closed.\n' : '\nSoloMap: Agent terminal closed.\n',
      'utf8'
    );
  }
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(statusFilePath, JSON.stringify({
    ...runningStatus,
    status: isContinuationRun ? 'In Progress' : 'Failed',
    ...(isContinuationRun ? {} : {
      failureCode: 'terminal_closed',
      failureReason: 'Agent terminal was closed before the task finished.'
    }),
    finishedAt
  }), 'utf8');
  await processAgentStatusFile(statusFilePath);
  return true;
}

function showAgentTerminal(conversationId = 0): void {
  const terminal = findActiveAgentTerminal(conversationId);
  if (terminal) {
    terminal.show(true);
    return;
  }
  vscode.window.showInformationMessage('No active SoloMap Agent terminal is available.');
}

function getSkillInstallWorkspaceRoot(context: vscode.ExtensionContext): string {
  return activeProjectRoot || getSelectedProjectPath(context) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function postMcpInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'mcpInstallResult', success, message, settings });
  sidebarProvider?.postMcpInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

function postSkillInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'skillInstallResult', success, message, settings });
  sidebarProvider?.postSkillInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

function postEnhancementInstallResult(context: vscode.ExtensionContext, success: boolean, message: string): void {
  const settings = getPersistedSettings(context);
  activePanel?.webview.postMessage({ command: 'enhancementInstallResult', success, message, settings });
  sidebarProvider?.postEnhancementInstallResult(success, message);
  vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
}

async function handleInstallSolomapSkill(context: vscode.ExtensionContext, rawSkillInput: string): Promise<void> {
  const skillInput = String(rawSkillInput || '').trim();
  if (!skillInput) {
    vscode.window.showWarningMessage('Paste a skill link or package name before installing.');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const { skillsRoot, runsRoot } = ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const runId = `skill-install-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-skill-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildSkillInstallPrompt(skillInput, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(skillsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap skill install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  const terminal = createAgentTerminal(workspaceRoot, `skill-${runId.slice(-6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  vscode.window.showInformationMessage('SoloMap skill install started. The Agent terminal will complete the package install.');

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(poller);
        vscode.window.showWarningMessage('SoloMap skill install is still waiting for result.json. Check the Agent terminal output.');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterSkillInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
      postSkillInstallResult(context, true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap skill install failed validation: ${validation.message}`);
      postSkillInstallResult(context, false, validation.message);
    }
  }, 2000);
}

async function handleInstallSolomapMcp(context: vscode.ExtensionContext, rawMcpInput: string): Promise<void> {
  const mcpInput = String(rawMcpInput || '').trim();
  if (!mcpInput) {
    vscode.window.showWarningMessage('Paste an MCP connector link, package, or config before installing.');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const { mcpRoot, runsRoot } = ensureSolomapMcpStore(workspaceRoot, settings.globalDataPath);
  const runId = `mcp-install-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-mcp-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildMcpInstallPrompt(mcpInput, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(mcpRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap MCP install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  const terminal = createAgentTerminal(workspaceRoot, `mcp-${runId.slice(-6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  vscode.window.showInformationMessage('SoloMap MCP connector install started. The Agent terminal will complete the controlled install.');

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(poller);
        vscode.window.showWarningMessage('SoloMap MCP install is still waiting for result.json. Check the Agent terminal output.');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterMcpInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
      postMcpInstallResult(context, true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap MCP install failed validation: ${validation.message}`);
      postMcpInstallResult(context, false, validation.message);
    }
  }, 2000);
}

async function handleUninstallSolomapSkill(context: vscode.ExtensionContext, skillId: string): Promise<void> {
  const settings = getPersistedSettings(context);
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const globalDataPath = settings.globalDataPath || '';
  
  try {
    const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
    if (!registry.skills.some((skill) => skill.id === skillId)) {
      const message = `Skill is not installed: ${skillId}`;
      vscode.window.showWarningMessage(message);
      postSkillInstallResult(context, false, message);
      return;
    }
    const nextSkills = registry.skills.filter((skill) => skill.id !== skillId);
    writeSolomapSkillRegistry(workspaceRoot, globalDataPath, { ...registry, skills: nextSkills });
    
    const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
    const installedPath = path.join(skillsRoot, 'installed', skillId);
    if (fs.existsSync(installedPath)) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    
    const message = `SoloMap skill uninstalled successfully: ${skillId}`;
    vscode.window.showInformationMessage(message);
    postSkillInstallResult(context, true, message);
  } catch (error: any) {
    const message = `Failed to uninstall skill: ${error.message || error}`;
    vscode.window.showErrorMessage(message);
    postSkillInstallResult(context, false, message);
  }
}

async function handleUninstallSolomapMcp(context: vscode.ExtensionContext, mcpId: string): Promise<void> {
  const settings = getPersistedSettings(context);
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const globalDataPath = settings.globalDataPath || '';
  
  try {
    const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
    if (!registry.connectors.some((connector) => connector.id === mcpId)) {
      const message = `MCP connector is not installed: ${mcpId}`;
      vscode.window.showWarningMessage(message);
      postMcpInstallResult(context, false, message);
      return;
    }
    const nextConnectors = registry.connectors.filter((connector) => connector.id !== mcpId);
    writeSolomapMcpRegistry(workspaceRoot, globalDataPath, { ...registry, connectors: nextConnectors });
    
    const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
    const installedPath = path.join(mcpRoot, 'servers', mcpId);
    if (fs.existsSync(installedPath)) {
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    
    const message = `SoloMap MCP connector uninstalled successfully: ${mcpId}`;
    vscode.window.showInformationMessage(message);
    postMcpInstallResult(context, true, message);
  } catch (error: any) {
    const message = `Failed to uninstall MCP connector: ${error.message || error}`;
    vscode.window.showErrorMessage(message);
    postMcpInstallResult(context, false, message);
  }
}

async function handleInstallSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    vscode.window.showWarningMessage('选择一个执行增强后再安装。');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const { enhancementsRoot, runsRoot } = ensureSolomapEnhancementStore(workspaceRoot, settings.globalDataPath);
  const runId = `enhancement-install-${enhancementId}-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-enhancement-install.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildEnhancementInstallPrompt(enhancementId, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(enhancementsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap enhancement install run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  upsertEnhancementRegistryEntry(workspaceRoot, settings.globalDataPath, {
    ...builtin,
    status: 'installing',
    enabled: false,
    updatedAt: new Date().toISOString(),
    health: { ok: false, message: '安装中' }
  });
  postEnhancementInstallResult(context, true, `正在安装执行增强：${builtin.title}`);
  const terminal = createAgentTerminal(workspaceRoot, `enhance-${enhancementId.slice(0, 8)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 45 * 60 * 1000) {
        clearInterval(poller);
        postEnhancementInstallResult(context, false, '执行增强安装仍在等待 result.json，请查看 Agent 终端输出。');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterEnhancementInstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    postEnhancementInstallResult(context, validation.ok, validation.message);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
    } else {
      vscode.window.showErrorMessage(`执行增强安装复验失败：${validation.message}`);
    }
  }, 2000);
}

async function handleCheckSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const result = checkAndRegisterEnhancement(workspaceRoot, settings.globalDataPath, enhancementId);
  postEnhancementInstallResult(context, result.ok, result.message);
  if (result.ok) {
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showWarningMessage(result.message);
  }
}

async function handleSetSolomapEnhancementEnabled(context: vscode.ExtensionContext, rawEnhancementId: string, enabled: boolean): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const result = setSolomapEnhancementEnabled(workspaceRoot, settings.globalDataPath, enhancementId, enabled);
  postEnhancementInstallResult(context, result.ok, result.message);
  if (result.ok) {
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showWarningMessage(result.message);
  }
}

async function handleUninstallSolomapEnhancement(context: vscode.ExtensionContext, rawEnhancementId: string): Promise<void> {
  const enhancementId = sanitizeAttachmentScope(String(rawEnhancementId || '').trim().toLowerCase());
  const builtin = getBuiltinEnhancementDefinition(enhancementId);
  if (!builtin) {
    vscode.window.showWarningMessage('选择一个执行增强后再卸载。');
    return;
  }
  const workspaceRoot = getSkillInstallWorkspaceRoot(context);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}.`);
    return;
  }
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  ensureSolomapSkillStore(workspaceRoot, settings.globalDataPath);
  const { enhancementsRoot, runsRoot } = ensureSolomapEnhancementStore(workspaceRoot, settings.globalDataPath);
  const runId = `enhancement-uninstall-${enhancementId}-${Date.now()}`;
  const runDir = path.join(runsRoot, runId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const outputFilePath = path.join(runDir, 'output.log');
  const resultFilePath = path.join(runDir, 'result.json');
  const commandFilePath = path.join(runDir, 'command.txt');
  const runScriptPath = path.join(runDir, 'run-enhancement-uninstall.sh');
  fs.mkdirSync(runDir, { recursive: true });
  const prompt = buildEnhancementUninstallPrompt(enhancementId, workspaceRoot, settings.globalDataPath, resultFilePath);
  fs.writeFileSync(promptFilePath, prompt, 'utf8');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode);
  fs.writeFileSync(commandFilePath, agentCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    'export DISABLE_TELEMETRY=1',
    `mkdir -p ${shellQuote(runDir)} ${shellQuote(enhancementsRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `printf '\\nSoloMap enhancement uninstall run finished. Result expected at: ${resultFilePath}\\n' >> ${shellQuote(outputFilePath)}`
  ].join('; ');
  fs.writeFileSync(runScriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  upsertEnhancementRegistryEntry(workspaceRoot, settings.globalDataPath, {
    ...builtin,
    status: 'uninstalling',
    enabled: false,
    updatedAt: new Date().toISOString(),
    health: { ok: false, message: '卸载中' }
  });
  postEnhancementInstallResult(context, true, `正在卸载执行增强：${builtin.title}`);
  const terminal = createAgentTerminal(workspaceRoot, `enhance-uninstall-${enhancementId.slice(0, 6)}`);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);

  const startedAt = Date.now();
  const poller = setInterval(() => {
    if (!fs.existsSync(resultFilePath)) {
      if (Date.now() - startedAt > 45 * 60 * 1000) {
        clearInterval(poller);
        postEnhancementInstallResult(context, false, '执行增强卸载仍在等待 result.json，请查看 Agent 终端输出。');
      }
      return;
    }
    clearInterval(poller);
    const validation = validateAndRegisterEnhancementUninstall(workspaceRoot, settings.globalDataPath, resultFilePath);
    postEnhancementInstallResult(context, validation.ok, validation.message);
    if (validation.ok) {
      vscode.window.showInformationMessage(validation.message);
    } else {
      vscode.window.showErrorMessage(`执行增强卸载复验失败：${validation.message}`);
    }
  }, 2000);
}

function resolveContinuationLeafConversation(nodeId: string, conversationId: number): AgentConversation | null {
  if (!syncEngine || !nodeId || !conversationId) {
    return null;
  }
  const conversations = syncEngine.getAgentExecutions(nodeId);
  return resolveContinuationLeafConversationFromList(conversations, conversationId);
}

function resolveConversationNodeIdForContinuation(nodeId: string, conversationId: number): string {
  if (!syncEngine || !conversationId) {
    return '';
  }
  const requestedNodeId = String(nodeId || '');
  if (requestedNodeId) {
    const requestedConversations = syncEngine.getAgentExecutions(requestedNodeId);
    if (requestedConversations.some((entry) => Number(entry.id) === Number(conversationId))
      || resolveContinuationLeafConversationFromList(requestedConversations, conversationId)) {
      return requestedNodeId;
    }
  }
  const projectConversations = typeof syncEngine.getProjectAgentExecutions === 'function'
    ? syncEngine.getProjectAgentExecutions()
    : [];
  const matchedConversation = projectConversations.find((entry) => Number(entry.id) === Number(conversationId));
  return String(matchedConversation?.nodeId || '');
}

function resolveContinuationSessionConversation(nodeId: string, conversationId: number): AgentConversation | null {
  if (!syncEngine || !nodeId || !conversationId) {
    return null;
  }
  return resolveContinuationSessionConversationFromList(syncEngine.getAgentExecutions(nodeId), conversationId);
}

function resolveContinuationRootConversation(nodeId: string, conversationId: number): AgentConversation | null {
  if (!syncEngine || !nodeId || !conversationId) {
    return null;
  }
  return resolveContinuationRootConversationFromList(syncEngine.getAgentExecutions(nodeId), conversationId);
}

async function handleContinueConversationTurn(
  context: vscode.ExtensionContext,
  nodeId: string,
  parentConversationId: number,
  userMessage: string,
  selectedModel = '',
  supplementFiles: string[] = []
): Promise<void> {
  if (!syncEngine || !activeProjectRoot || !nodeId || !parentConversationId) {
    return;
  }
  const resolvedNodeId = resolveConversationNodeIdForContinuation(nodeId, parentConversationId);
  if (resolvedNodeId) {
    nodeId = resolvedNodeId;
  }
  const request = String(userMessage || '').trim();
  if (!request) {
    vscode.window.showWarningMessage('先输入这次续聊要继续推进的内容。');
    return;
  }
  const parentConversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(parentConversationId));
  if (!parentConversation) {
    vscode.window.showErrorMessage(`Conversation ${parentConversationId} not found for continuation.`);
    return;
  }
  const rootConversation = resolveContinuationRootConversation(nodeId, parentConversationId) || parentConversation;
  const rootConversationId = Number(rootConversation.id || parentConversationId);
  const settings = getPersistedSettings(context);
  const requestedAgentCli = String(parentConversation.agentCli || settings.cliPath || '').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, requestedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    vscode.window.showErrorMessage(`Agent CLI not found for continuation: ${requestedAgentCli || agentCli}`);
    return;
  }
  if (!supportsSdkContinuation(agentCli)) {
    await handleContinueNativeConversation(context, nodeId, rootConversationId);
    return;
  }
  const sessionConversation = resolveContinuationSessionConversation(nodeId, parentConversationId) || parentConversation;
  const sessionId = resolveNativeSessionIdForConversation(nodeId, sessionConversation);
  if (!sessionId) {
    vscode.window.showErrorMessage('No resumable Codex session ID was recorded for this conversation.');
    return;
  }

  if (nodeId !== roadmapRevisionId && nodeId !== soloConversationId) {
    const currentNode = syncEngine.getNodes().find((candidate) => candidate.id === nodeId);
    if (currentNode && currentNode.status !== 'Completed') {
      syncEngine.updateNode(nodeId, { status: 'Running' });
      sendNodesToWebview();
      refreshSidebarProjectCards();
    }
  }

  const preGitHash = createPreSessionGitCommit(activeProjectRoot);
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Agent continuation started.',
    `Run started at: ${new Date().toISOString()}`,
    buildContinuationMetadataBlock(rootConversationId, sessionId),
    `User supplement:\n${request}`,
    attachedFiles.length > 0 ? `Attached files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [preparing interactive continuation]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', nodeId, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(activeProjectRoot, executionLogId);
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  const node = nodeId === soloConversationId
    ? null
    : syncEngine.getNodes().find((candidate) => candidate.id === nodeId) || null;
  const continuationPrompt = buildInteractiveContinuationPrompt(
    node,
    request,
    activeProjectRoot,
    completionDecisionFilePath,
    attachedFiles,
    settings.globalPrompt,
    settings.globalDataPath
  );
  const runnerFilePath = path.join(runDir, 'run-codex-continuation.cjs');
  const sessionFilePath = path.join(runDir, 'session.json');
  fs.mkdirSync(runDir, { recursive: true });
  buildCodexContinuationRunnerScript(runnerFilePath, activeProjectRoot, sessionId, continuationPrompt, sessionFilePath, selectedModel);
  const directExecutionCommand = `${shellQuote(process.execPath)} ${shellQuote(runnerFilePath)}`;
  const displayCommand = buildSdkSentinelCommandLabel(agentCli, activeProjectRoot, sessionId);
  syncEngine.updateAgentExecution(executionLogId, agentCli, displayCommand, launchSummary, 'Running');

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    selectedModel,
    continuationPrompt,
    activeProjectRoot,
    nodeId,
    executionLogId,
    request,
    completionDecisionFilePath,
    sessionId,
    directExecutionCommand,
    nodeId === soloConversationId ? 'solo_continue' : 'step_continue',
    '',
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    statusFilePath
  );
  launchAgentConversationTerminal({
    workspaceRoot: activeProjectRoot,
    label: `continue-${nodeId}-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand,
    refreshNodeId: nodeId
  });
}

async function handleContinueNativeConversation(context: vscode.ExtensionContext, nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !activeProjectRoot || !nodeId || !conversationId) {
    return;
  }
  const resolvedNodeId = resolveConversationNodeIdForContinuation(nodeId, conversationId);
  if (resolvedNodeId) {
    nodeId = resolvedNodeId;
  }

  const conversation = resolveContinuationLeafConversation(nodeId, conversationId)
    || syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId))
    || null;
  if (!conversation) {
    vscode.window.showErrorMessage(`Conversation ${conversationId} not found for step ${nodeId}.`);
    return;
  }

  const sessionConversation = resolveContinuationSessionConversation(nodeId, conversationId) || conversation;
  const sessionId = resolveNativeSessionIdForConversation(nodeId, sessionConversation);
  if (!sessionId) {
    vscode.window.showInformationMessage('No native Agent session ID was recorded for this conversation.');
    return;
  }

  const agentCli = resolveAgentCli(sessionConversation.agentCli || conversation.agentCli || '', '');
  if (!commandExists(agentCli)) {
    vscode.window.showErrorMessage(`Agent CLI not found for native continuation: ${conversation.agentCli || agentCli}`);
    return;
  }

  const settings = getPersistedSettings(context);
  const rootConversation = resolveContinuationRootConversation(nodeId, conversationId) || conversation;
  const rootConversationId = Number(rootConversation.id || conversationId);
  if (nodeId !== roadmapRevisionId && nodeId !== soloConversationId) {
    const currentNode = syncEngine.getNodes().find((candidate) => candidate.id === nodeId);
    if (currentNode && currentNode.status !== 'Completed') {
      syncEngine.updateNode(nodeId, { status: 'Running' });
      sendNodesToWebview();
      refreshSidebarProjectCards();
    }
  }
  const preGitHash = createPreSessionGitCommit(activeProjectRoot);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Agent continuation started.',
    `Run started at: ${new Date().toISOString()}`,
    buildContinuationMetadataBlock(rootConversationId, sessionId),
    'Continuation mode: direct terminal with tracked sentinel recording.'
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [preparing tracked continuation terminal]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', nodeId, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(activeProjectRoot, executionLogId);
  fs.mkdirSync(runDir, { recursive: true });
  const directExecutionCommand = buildNativeContinueCommand(agentCli, sessionId, activeProjectRoot);
  const displayCommand = buildSdkSentinelCommandLabel(agentCli, activeProjectRoot, sessionId);
  syncEngine.updateAgentExecution(executionLogId, agentCli, displayCommand, launchSummary, 'Running');
  const { finalCommand } = buildAgentShellScript(
    agentCli,
    '',
    'SoloMap tracked continuation terminal',
    activeProjectRoot,
    nodeId,
    executionLogId,
    '',
    undefined,
    sessionId,
    directExecutionCommand,
    nodeId === soloConversationId ? 'solo_continue' : 'step_continue',
    '',
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    statusFilePath
  );
  launchAgentConversationTerminal({
    workspaceRoot: activeProjectRoot,
    label: `continue-${nodeId}-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand,
    refreshNodeId: nodeId
  });
}

function readAgentStatus(statusFilePath: string): any | null {
  if (!fs.existsSync(statusFilePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(statusFilePath, 'utf8').trim();
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

function getAgentStatusFilePaths(workspaceRoot: string): string[] {
  const paths: string[] = [path.join(workspaceRoot, '.agent_status.json')];
  const statusRoot = getAgentStatusRoot(workspaceRoot);
  try {
    if (fs.existsSync(statusRoot)) {
      for (const fileName of fs.readdirSync(statusRoot)) {
        if (fileName.endsWith('.json')) {
          paths.push(path.join(statusRoot, fileName));
        }
      }
    }
  } catch {
    // Ignore transient directory reads while a run is starting.
  }
  return paths;
}

function hasRunningAgentConversation(workspaceRoot: string, nodes: RoadmapNode[]): boolean {
  reconcileActiveProjectConversationLifecycle();
  if (syncEngine?.getProjectAgentExecutions().some((conversation) => conversation.status === 'Running')) {
    return true;
  }
  if (nodes.some((candidate) => candidate.status === 'Running')) {
    return true;
  }
  const status = readAgentStatus(path.join(workspaceRoot, '.agent_status.json'));
  return Boolean(status && status.status === 'Running');
}

async function stopAgentRun(nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !activeProjectRoot || !nodeId) {
    return;
  }
  const runningStatus = findAgentStatusForConversation(activeProjectRoot, conversationId);
  const statusFilePath = runningStatus
    ? getAgentStatusFilePath(activeProjectRoot, Number(runningStatus.executionLogId || conversationId))
    : path.join(activeProjectRoot, '.agent_status.json');
  const conversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId));
  if (!conversation || conversation.status !== 'Running') {
    vscode.window.showInformationMessage('This Agent conversation is no longer running.');
    return;
  }

  const terminal = findActiveAgentTerminal(conversationId);
  terminal?.dispose();
  const isContinuationRun = isContinuationRunKind(String(runningStatus?.runKind || ''))
    || /Agent continuation started\.|Continuation mode:/i.test(String(conversation.output || ''));
  const failureReason = 'Stopped by user.';
  const finishedAt = new Date().toISOString();
  if (runningStatus && runningStatus.nodeId === nodeId && Number(runningStatus.executionLogId) === Number(conversationId)) {
    if (runningStatus.outputFilePath) {
      fs.appendFileSync(
        runningStatus.outputFilePath,
        isContinuationRun ? '\nSoloMap: Continuation terminal stopped by user.\n' : '\nSoloMap: Task stopped by user.\n',
        'utf8'
      );
    }
    fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
    fs.writeFileSync(statusFilePath, JSON.stringify({
      ...runningStatus,
      status: isContinuationRun ? 'In Progress' : 'Failed',
      ...(isContinuationRun ? {} : { failureCode: 'stopped_by_user', failureReason }),
      finishedAt
    }), 'utf8');
    await processAgentStatusFile(statusFilePath);
    agentTerminalNamesByConversationId.delete(Number(conversationId));
    return;
  }

  if (!isContinuationRun && nodeId !== roadmapRevisionId && nodeId !== soloConversationId) {
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
  }
  syncEngine.updateAgentExecution(
    conversationId,
    conversation.agentCli,
    conversation.command,
    isContinuationRun
      ? `${conversation.output}\n\nContinuation recording stopped by user.\n\nRun finished at: ${finishedAt}`
      : `${conversation.output}\n\nFailure category: stopped_by_user\n\nFailure reason:\n${failureReason}\n\nRun finished at: ${finishedAt}`,
    isContinuationRun ? 'Recorded' : 'Failed'
  );
  agentTerminalNamesByConversationId.delete(Number(conversationId));
  sendNodesToWebview();
  postNodeConversations(nodeId);
  vscode.window.showInformationMessage(isContinuationRun ? 'Continuation conversation was recorded.' : `Agent task [${nodeId}] was stopped.`);
  if (!isContinuationRun && extensionContextRef) {
    scheduleAutomationTasksAfterRun(extensionContextRef, {
      workspaceRoot: activeProjectRoot,
      nodeId,
      runKind: nodeId === soloConversationId ? 'solo' : nodeId === roadmapRevisionId ? 'roadmap_revision' : 'step',
      nextStatus: 'Failed',
      failureCode: 'stopped_by_user',
      executionLogId: Number(conversationId || 0),
      agentCli: String(conversation.agentCli || ''),
      userMessage: extractUserSupplementFromExecutionOutput(conversation.output || ''),
      isReviewRun: false,
      isContinuationRun: false
    });
  }
}

async function handleRoadmapRevision(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const revisionRequest = userMessage.trim();
  if (!revisionRequest) {
    vscode.window.showWarningMessage('Describe how you want to adjust the roadmap before sending.');
    return;
  }
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.logAgentExecution(
      roadmapRevisionId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      `User supplement:\n${revisionRequest}\n\nFailure category: cli_not_found\n\nFailure reason:\n${failureReason}`,
      'Failed'
    );
    postNodeConversations(roadmapRevisionId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.logAgentExecution(
      roadmapRevisionId,
      agentCli,
      agentCli,
      `User supplement:\n${revisionRequest}\n\nFailure category: agent_automation_not_ready\n\nFailure reason:\n${automation.message}`,
      'Failed'
    );
    postNodeConversations(roadmapRevisionId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  recordLocalUsageEvent(context, 'roadmapRevision');
  ensureRoadmapValidationScript(path.join(activeProjectRoot, '.solopreneur'));
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const conversationPrompt = buildRoadmapRevisionPrompt(revisionRequest, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath, settings.enabledEnhancements);
  const launchSummary = [
    'Roadmap revision started.',
    `Run started at: ${new Date().toISOString()}`,
    `User supplement:\n${revisionRequest}`,
    attachedFiles.length > 0 ? `Supplement files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    roadmapRevisionId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', 'roadmap-revision', String(executionLogId));
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, activeProjectRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    selectedModel,
    conversationPrompt,
    activeProjectRoot,
    roadmapRevisionId,
    executionLogId,
    revisionRequest,
    undefined,
    '',
    '',
    'roadmap_revision',
    roadmapBackupFilePath,
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    getAgentStatusFilePath(activeProjectRoot, executionLogId)
  );
  launchAgentConversationTerminal({
    workspaceRoot: activeProjectRoot,
    label: `revision-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand,
    refreshNodeId: roadmapRevisionId
  });
}

async function handleRunSoloConversation(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const request = userMessage.trim();
  if (!request) {
    vscode.window.showWarningMessage('Describe what you want to handle before starting a Solo conversation.');
    return;
  }

  await syncEngine.initAndSync();

  const settings = getPersistedSettings(context);
  const requestedAgentCli = (selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : settings.cliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.logAgentExecution(
      soloConversationId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      `User supplement:\n${request}\n\nFailure category: cli_not_found\n\nFailure reason:\n${failureReason}`,
      'Failed'
    );
    postNodeConversations(soloConversationId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.logAgentExecution(
      soloConversationId,
      agentCli,
      agentCli,
      `User supplement:\n${request}\n\nFailure category: agent_automation_not_ready\n\nFailure reason:\n${automation.message}`,
      'Failed'
    );
    postNodeConversations(soloConversationId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  recordLocalUsageEvent(context, 'soloConversation');
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const storedSession = getStoredAgentSession(activeProjectRoot, soloConversationId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const preGitHash = createPreSessionGitCommit(activeProjectRoot);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Solo conversation started.',
    `Run started at: ${new Date().toISOString()}`,
    nativeSessionId
      ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
      : `Starting a new native ${getAgentProvider(agentCli)} session.`,
    `User supplement:\n${request}`,
    attachedFiles.length > 0 ? `Attached files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    soloConversationId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', soloConversationId, String(executionLogId));
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  const conversationPrompt = buildSoloConversationPrompt(request, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath, settings.enabledEnhancements);
  const agentCommand = buildAgentCommandForPromptFile(agentCli, path.join(runDir, 'prompt.txt'), activeProjectRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(
    executionLogId,
    agentCli,
    agentCommand,
    launchSummary,
    'Running'
  );

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    selectedModel,
    conversationPrompt,
    activeProjectRoot,
    soloConversationId,
    executionLogId,
    request,
    undefined,
    nativeSessionId,
    '',
    'solo',
    roadmapBackupFilePath,
    settings.globalDataPath,
    settings.taskPermissionMode,
    settings.reviewerCliPath,
    settings.collaborationReviewMode,
    settings.enabledEnhancements,
    runDir,
    getAgentStatusFilePath(activeProjectRoot, executionLogId)
  );
  launchAgentConversationTerminal({
    workspaceRoot: activeProjectRoot,
    label: `solo-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand,
    refreshNodeId: soloConversationId
  });
}

function getCurrentFlowTrace(projectPath: string): FlowTrace | null {
  return buildFlowStatePayload(projectPath, true).flow;
}

async function startFlowRoleRun(
  context: vscode.ExtensionContext,
  input: {
    projectPath: string;
    flow: FlowTrace;
    loopIndex: number;
    role: FlowRole;
    prompt: string;
    selectedAgentCli?: string;
    selectedModel?: string;
  }
): Promise<void> {
  if (!syncEngine) {
    return;
  }
  const settings = getPersistedSettings(context);
  const requestedAgentCli = (input.selectedAgentCli || input.flow.source.selectedAgentCli || settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, input.selectedAgentCli ? '' : settings.cliPath);
  if (!commandExists(agentCli)) {
    throw new Error(`Flow Agent CLI not found: ${requestedAgentCli || agentCli}`);
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    throw new Error(automation.message);
  }
  const loop = input.flow.loops.find((candidate) => candidate.index === input.loopIndex);
  if (!loop) {
    throw new Error(`Flow loop ${input.loopIndex} not found.`);
  }
  const nodeId = buildFlowExecutionNodeId(input.flow.flowId, loop.loopId, input.role);
  const launchSummary = [
    `Flow ${input.role} started.`,
    `Flow ID: ${input.flow.flowId}`,
    `Loop ID: ${loop.loopId}`,
    `Run started at: ${new Date().toISOString()}`,
    `Goal:\n${input.flow.goal}`
  ].join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [flow ${input.role}]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(input.projectPath, '.solopreneur', 'flows', input.flow.flowId, loop.loopId, input.role, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(input.projectPath, executionLogId);
  const effectiveModel = input.selectedModel || input.flow.source.selectedModel || '';
  const agentCommand = buildAgentCommandForPromptFile(agentCli, path.join(runDir, 'prompt.txt'), input.projectPath, settings.taskPermissionMode, effectiveModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');
  updateFlowTrace(input.projectPath, input.flow.flowId, (trace) => {
    const nextTrace = { ...trace, status: 'running' as const };
    nextTrace.loops = trace.loops.map((candidate) => {
      if (candidate.index !== input.loopIndex) {
        return candidate;
      }
      const roleState = {
        status: 'running' as const,
        executionLogId,
        startedAt: new Date().toISOString(),
        command: agentCommand
      };
      return {
        ...candidate,
        status: input.role === 'planner' ? 'planned' : input.role === 'builder' ? 'building' : 'verifying',
        updatedAt: new Date().toISOString(),
        planner: input.role === 'planner' ? roleState : candidate.planner,
        builder: input.role === 'builder' ? roleState : candidate.builder,
        verifier: input.role === 'verifier' ? roleState : candidate.verifier
      };
    });
    return nextTrace;
  });
  await postFlowStateToWebview(context);
  const { finalCommand } = buildAgentShellScript(
    agentCli,
    effectiveModel,
    input.prompt,
    input.projectPath,
    nodeId,
    executionLogId,
    input.flow.goal,
    undefined,
    '',
    '',
    `flow_${input.role}`,
    '',
    settings.globalDataPath,
    settings.taskPermissionMode,
    '',
    'off',
    settings.enabledEnhancements,
    runDir,
    statusFilePath
  );
  launchAgentConversationTerminal({
    workspaceRoot: input.projectPath,
    label: `flow-${input.flow.flowId}-${input.role}-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand
  });
}

async function handleRunFlow(
  context: vscode.ExtensionContext,
  goal: string,
  selectedAgentCli = '',
  selectedModel = '',
  supplementFiles: string[] = []
): Promise<void> {
  if (!activeProjectRoot || !syncEngine) {
    return;
  }
  const request = String(goal || '').trim();
  if (!request) {
    vscode.window.showWarningMessage('先写下你想让 Flow 自动推进完成的目标。');
    return;
  }
  if (!await hasFlowModeAccess(context)) {
    const choice = await vscode.window.showInformationMessage('Flow 是 SoloMap Pro 功能。', '升级 Pro');
    if (choice === '升级 Pro') {
      await beginPassportAuthorizationFlow(context);
    }
    await postFlowStateToWebview(context);
    return;
  }
  await syncEngine.initAndSync();
  const trace = createFlowTrace(activeProjectRoot, request, {
    supplementFiles,
    selectedAgentCli,
    selectedModel
  });
  trace.loops = [createFlowLoop(request, 1)];
  saveFlowTrace(activeProjectRoot, trace);
  await postFlowStateToWebview(context);
  await startFlowRoleRun(context, {
    projectPath: activeProjectRoot,
    flow: trace,
    loopIndex: 1,
    role: 'planner',
    prompt: buildFlowPlannerPrompt({
      goal: request,
      workspaceRoot: activeProjectRoot,
      flowId: trace.flowId,
      loopId: 'loop-1',
      globalPrompt: getPersistedSettings(context).globalPrompt,
      globalDataPath: getPersistedSettings(context).globalDataPath,
      supplementFiles
    }),
    selectedAgentCli,
    selectedModel
  });
}

function linkSoloConversationToNode(conversationId: number, nodeId: string): void {
  if (!syncEngine || !conversationId || !nodeId) {
    return;
  }
  const node = syncEngine.getNodes().find((candidate) => candidate.id === nodeId);
  const conversation = syncEngine.getAgentExecutions(soloConversationId)
    .find((entry) => Number(entry.id) === conversationId);
  if (!node || !conversation || conversation.status === 'Running') {
    vscode.window.showWarningMessage('This Solo conversation cannot be associated with that step.');
    return;
  }
  const marker = `Solo reference ID: ${conversationId}`;
  const existingStepConversations = syncEngine.getAgentExecutions(nodeId);
  if (existingStepConversations.some((entry) => String(entry.output || '').includes(marker))) {
    vscode.window.showInformationMessage('This Solo conversation is already associated with that step.');
    return;
  }
  const linkedAt = new Date().toISOString();
  const linkedOutput = [
    'Linked from Solo conversation.',
    marker,
    `Linked at: ${linkedAt}`,
    `Original Solo status: ${conversation.status}`,
    '',
    conversation.output
  ].join('\n');
  const linkedLogId = syncEngine.logAgentExecution(
    nodeId,
    conversation.agentCli,
    conversation.command,
    linkedOutput,
    'Linked'
  );
  postNodeConversations(nodeId, [{
    id: linkedLogId,
    nodeId,
    timestamp: linkedAt,
    agentCli: conversation.agentCli,
    command: conversation.command,
    output: linkedOutput,
    status: 'Linked'
  }, ...existingStepConversations]);
  postNodeConversations(soloConversationId);
  vscode.window.showInformationMessage(`Solo conversation associated with step: ${node.title}`);
}

function createPreSessionGitCommit(projectPath: string): string | null {
  try {
    const isRepo = childProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    if (isRepo.status !== 0) {
      return null;
    }
    
    const statusResult = childProcess.spawnSync('git', ['status', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    const hasChanges = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
    
    if (hasChanges) {
      childProcess.spawnSync('git', ['add', '-A'], { cwd: projectPath });
      const commitMsg = `SoloMap pre-session auto-backup [${new Date().toISOString()}]`;
      childProcess.spawnSync('git', ['commit', '-m', commitMsg, '--no-verify'], { cwd: projectPath });
    }
    
    const revResult = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf8'
    });
    if (revResult.status === 0) {
      return revResult.stdout.trim();
    }
  } catch (err) {
    console.error('Failed to create pre-session git commit:', err);
  }
  return null;
}

function getGitCommandOutput(projectPath: string, args: string[]): string {
  const result = childProcess.spawnSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return String(result.stdout || '').trim();
}

function registerSolomapGitDiffContent(label: string, content: string): vscode.Uri {
  const safeLabel = path.basename(label || 'diff.txt') || 'diff.txt';
  const uri = vscode.Uri.from({
    scheme: SOLOMAP_GIT_DIFF_SCHEME,
    path: `/${safeLabel}`,
    query: `id=${crypto.randomUUID()}`
  });
  solomapGitDiffContent.set(uri.toString(), content);
  if (solomapGitDiffContent.size > 200) {
    const oldestKey = solomapGitDiffContent.keys().next().value;
    if (oldestKey) {
      solomapGitDiffContent.delete(oldestKey);
    }
  }
  return uri;
}

function readGitFileAtRevision(projectPath: string, gitHash: string, relativePath: string): { exists: boolean; content: string } {
  const gitPath = String(relativePath || '').replace(/\\/g, '/');
  const result = childProcess.spawnSync('git', ['show', `${gitHash}:${gitPath}`], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    return { exists: false, content: '' };
  }
  return { exists: true, content: String(result.stdout || '') };
}

async function openProjectFileDiff(projectPath: string, relativePath: string, gitHash: string): Promise<boolean> {
  const normalizedRelativePath = String(relativePath || '').trim();
  const normalizedGitHash = String(gitHash || '').trim();
  if (!normalizedRelativePath || !normalizedGitHash) {
    return false;
  }
  const baseline = readGitFileAtRevision(projectPath, normalizedGitHash, normalizedRelativePath);
  const currentPath = path.resolve(projectPath, normalizedRelativePath);
  const currentExists = fs.existsSync(currentPath);
  if (!baseline.exists && !currentExists) {
    return false;
  }

  const leftUri = registerSolomapGitDiffContent(
    `${path.basename(normalizedRelativePath)}.baseline`,
    baseline.exists ? baseline.content : ''
  );
  const rightUri = currentExists
    ? vscode.Uri.file(currentPath)
    : registerSolomapGitDiffContent(`${path.basename(normalizedRelativePath)}.working-tree`, '');
  const title = `${normalizedRelativePath} (${normalizedGitHash.slice(0, 8)}..working tree)`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: false });
  return true;
}

function moveUntrackedFilesToRollbackSafety(projectPath: string): string {
  const listResult = childProcess.spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: projectPath,
    encoding: 'buffer'
  });
  if (listResult.status !== 0) {
    throw new Error(String(listResult.stderr || 'Could not list untracked files.'));
  }
  const untrackedFiles = Buffer.from(listResult.stdout || Buffer.alloc(0))
    .toString('utf8')
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('.solopreneur/rollback-safety/'));
  if (untrackedFiles.length === 0) {
    return '';
  }

  const safeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyRoot = path.join(projectPath, '.solopreneur', 'rollback-safety', safeStamp);
  for (const relativeFile of untrackedFiles) {
    const sourcePath = path.resolve(projectPath, relativeFile);
    if (!sourcePath.startsWith(path.resolve(projectPath) + path.sep) || !fs.existsSync(sourcePath)) {
      continue;
    }
    const targetPath = path.join(safetyRoot, relativeFile);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
  }
  return path.relative(projectPath, safetyRoot);
}

async function rollbackProjectToPreSessionGitHash(context: vscode.ExtensionContext, projectPath: string, gitHash: string): Promise<void> {
  const normalizedProjectPath = String(projectPath || '').trim();
  const normalizedGitHash = String(gitHash || '').trim();
  if (!normalizedProjectPath || !/^[a-f0-9]{7,40}$/i.test(normalizedGitHash)) {
    vscode.window.showErrorMessage('Invalid rollback request.');
    return;
  }
  if (!getProjects(context).some((project) => project.path === normalizedProjectPath)) {
    vscode.window.showErrorMessage(`Project folder is not registered: ${normalizedProjectPath}`);
    return;
  }

  try {
    getGitCommandOutput(normalizedProjectPath, ['rev-parse', '--is-inside-work-tree']);
    const verifiedHash = getGitCommandOutput(normalizedProjectPath, ['rev-parse', '--verify', `${normalizedGitHash}^{commit}`]);
    const ancestorResult = childProcess.spawnSync('git', ['merge-base', '--is-ancestor', verifiedHash, 'HEAD'], {
      cwd: normalizedProjectPath,
      encoding: 'utf8'
    });
    if (ancestorResult.status !== 0 && verifiedHash !== getGitCommandOutput(normalizedProjectPath, ['rev-parse', 'HEAD'])) {
      vscode.window.showErrorMessage('回滚失败：这次对话记录的 Git 哈希不是当前分支的祖先提交。');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确认撤销本次修改并恢复到对话开始前？未跟踪的新文件会先转移到 .solopreneur/rollback-safety，不会直接删除。提交：${verifiedHash.slice(0, 8)}`,
      { modal: true },
      '确认撤销'
    );
    if (confirm !== '确认撤销') {
      return;
    }

    const safetyDir = moveUntrackedFilesToRollbackSafety(normalizedProjectPath);
    const restoreRes = childProcess.spawnSync('git', ['restore', '--source', verifiedHash, '--staged', '--worktree', '--', '.'], {
      cwd: normalizedProjectPath,
      encoding: 'utf8'
    });
    if (restoreRes.status !== 0) {
      vscode.window.showErrorMessage(`回滚失败：${restoreRes.stderr || '未知 Git 错误'}`);
      return;
    }

    vscode.window.showInformationMessage(
      safetyDir
        ? `项目已恢复到 ${verifiedHash.slice(0, 8)}；未跟踪新文件已移到 ${safetyDir}`
        : `项目已恢复到 ${verifiedHash.slice(0, 8)}`
    );
    if (getSelectedProjectPath(context) !== normalizedProjectPath) {
      await selectProject(context, normalizedProjectPath);
    }
    if (syncEngine) {
      await syncEngine.initAndSync();
    }
    sendNodesToWebview();
    refreshSidebarProjectCards();
  } catch (error: any) {
    vscode.window.showErrorMessage(`执行回滚操作出错：${error?.message || error}`);
  }
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(context: vscode.ExtensionContext, nodeId: string, userMessage: string, selectedAgentCli = '', selectedModel = '', supplementFiles: string[] = []) {
  if (!syncEngine) {
    return;
  }

  const workspaceRoot = activeProjectRoot || '';
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Choose a project folder before running an Agent task.');
    return;
  }

  await syncEngine.initAndSync();
  sendNodesToWebview();

  const nodes = syncEngine.getNodes();
  const node = nodes.find((n) => n.id === nodeId);

  if (!node) {
    vscode.window.showErrorMessage(`Node ${nodeId} not found`);
    return;
  }

  const attachedFiles = filterProjectRelativeFiles(workspaceRoot, supplementFiles);

  // Resolve CLI path from config if applicable
  const settings = getPersistedSettings(context);
  const configuredCliPath = settings.cliPath;
  const requestedAgentCli = (selectedAgentCli || node.agentCli || configuredCliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath);

  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath).join(', ');
    const failureReason = `Agent CLI not found. Tried: ${candidates}.`;
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
    syncEngine.logAgentExecution(
      nodeId,
      requestedAgentCli || agentCli,
      requestedAgentCli || agentCli,
      [
        userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
        'Failure category: cli_not_found',
        `Failure reason:\n${failureReason}`
      ].filter(Boolean).join('\n\n'),
      'Failed'
    );
    sendNodesToWebview();
    postNodeConversations(nodeId);
    vscode.window.showErrorMessage(`${failureReason} Set SoloMap CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }
  const automation = ensureAgentTaskAutomation(agentCli);
  if (!automation.ok) {
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
    syncEngine.logAgentExecution(
      nodeId,
      agentCli,
      agentCli,
      [
        userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
        'Failure category: agent_automation_not_ready',
        `Failure reason:\n${automation.message}`
      ].filter(Boolean).join('\n\n'),
      'Failed'
    );
    sendNodesToWebview();
    postNodeConversations(nodeId);
    vscode.window.showErrorMessage(automation.message);
    return;
  }

  // Update node status to Running
  recordLocalUsageEvent(context, 'agentRun');
  syncEngine.updateNode(nodeId, { status: 'Running' });
  sendNodesToWebview();
  refreshSidebarProjectCards();

  const storedSession = getStoredAgentSession(workspaceRoot, nodeId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const preGitHash = createPreSessionGitCommit(workspaceRoot);
  const launchSummary = [
    preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
    'Agent conversation started.',
    `Run started at: ${new Date().toISOString()}`,
    nativeSessionId
      ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
      : `Starting a new native ${getAgentProvider(agentCli)} session.`,
    userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : '',
    attachedFiles.length ? `Attached files:\n${attachedFiles.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    `${agentCli} [preparing isolated run]`,
    launchSummary,
    'Running'
  );
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, String(executionLogId));
  const statusFilePath = getAgentStatusFilePath(workspaceRoot, executionLogId);
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  const stepMemoryFilePath = getStepMemoryFilePath(workspaceRoot, nodeId);
  const githubIssueContext = buildGithubIssueContext(workspaceRoot, node);
  ensureRoadmapValidationScript(path.join(workspaceRoot, '.solopreneur'));
  ensureSolomapMemoryStore(workspaceRoot, settings.globalDataPath);
  const conversationPrompt = buildAgentConversationPrompt(
    node,
    userMessage,
    workspaceRoot,
    stepMemoryFilePath,
    runDir,
    completionDecisionFilePath,
    nativeSessionId,
    attachedFiles,
    settings.globalPrompt,
    githubIssueContext,
    settings.globalDataPath,
    settings.enabledEnhancements
  );
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot, settings.taskPermissionMode, selectedModel);
  syncEngine.updateAgentExecution(executionLogId, agentCli, agentCommand, launchSummary, 'Running');

  const { finalCommand } = buildAgentShellScript(agentCli, selectedModel, conversationPrompt, workspaceRoot, nodeId, executionLogId, userMessage.trim(), completionDecisionFilePath, nativeSessionId, '', 'step', '', settings.globalDataPath, settings.taskPermissionMode, settings.reviewerCliPath, settings.collaborationReviewMode, settings.enabledEnhancements, runDir, statusFilePath);

  launchAgentConversationTerminal({
    workspaceRoot,
    label: `step-${nodeId}-${executionLogId}`,
    conversationId: executionLogId,
    command: finalCommand,
    refreshNodeId: nodeId
  });
}

function extractUserSupplementFromExecutionOutput(output: string): string {
  const text = String(output || '');
  const match = text.match(/User supplement:\n([\s\S]*?)(?:\n\n(?:Sentinel captured state:|Native session mode:|Roadmap step state:|Workspace changes:|Touched project files:|Agent output tail:)|$)/);
  return match ? match[1].trim() : '';
}

async function handleRetryConversation(context: vscode.ExtensionContext, nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !nodeId || !conversationId) {
    return;
  }

  const conversation = syncEngine.getAgentExecutions(nodeId).find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) {
    vscode.window.showErrorMessage(`Conversation ${conversationId} not found for step ${nodeId}.`);
    return;
  }

  if (conversation.status !== 'Failed') {
    vscode.window.showWarningMessage('Only failed Agent conversations can be retried.');
    return;
  }

  const retryUserMessage = extractUserSupplementFromExecutionOutput(conversation.output || '');
  if (nodeId === roadmapRevisionId) {
    await handleRoadmapRevision(context, retryUserMessage, conversation.agentCli || '');
    return;
  }
  if (nodeId === soloConversationId) {
    await handleRunSoloConversation(context, retryUserMessage, conversation.agentCli || '');
    return;
  }
  await handleRunAgent(context, nodeId, retryUserMessage, conversation.agentCli || '');
}

function automationTriggerFromRunStatus(nextStatus: string, failureCode: string): SolomapAutomationTrigger | '' {
  if (failureCode === 'stopped_by_user') {
    return 'stopped';
  }
  if (nextStatus === 'Completed') {
    return 'completed';
  }
  if (nextStatus === 'Failed') {
    return 'failed';
  }
  return '';
}

function hasAutomationAction(settings: SolomapAutomationSettings, trigger: SolomapAutomationTrigger): boolean {
  const rule = settings.triggers?.[trigger] || {};
  return Boolean(rule.notify || rule.sound || rule.retry || String(rule.prompt || '').trim());
}

function getAutomationLogPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'automation-tasks.jsonl');
}

function recordAutomationTaskEvent(workspaceRoot: string, event: Record<string, unknown>): void {
  try {
    const logPath = getAutomationLogPath(workspaceRoot);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ...event, recordedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    console.warn('Failed to record SoloMap automation task event:', error);
  }
}

function playAutomationSound(): void {
  try {
    activePanel?.webview.postMessage({ command: 'automationPlaySound' });
    sidebarProvider?.postMessage({ command: 'automationPlaySound' });
  } catch (error) {
    console.warn('Failed to play SoloMap automation sound:', error);
  }
}

function showAutomationNotification(trigger: SolomapAutomationTrigger, nodeId: string, status: string): void {
  const label = trigger === 'completed'
    ? '任务已完成'
    : trigger === 'stopped'
      ? '任务已停止'
      : trigger === 'focus_time'
        ? '专注时间到了'
        : trigger === 'scheduled_time'
          ? '定时任务已触发'
          : '任务失败';
  const message = nodeId && trigger !== 'focus_time' && trigger !== 'scheduled_time'
    ? `SoloMap 自动化任务：${label}（${nodeId}）。`
    : `SoloMap 自动化任务：${label}。`;
  if (status === 'Failed' || trigger === 'failed') {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

function scheduleFocusReminder(context: vscode.ExtensionContext): void {
  if (focusReminderTimer) {
    clearTimeout(focusReminderTimer);
    focusReminderTimer = null;
  }
  const settings = getPersistedSettings(context).automationTasks || normalizeAutomationSettings({});
  const rule = settings.triggers?.focus_time || {};
  if (!rule.notify && !rule.sound) {
    focusReminderNextAt = '';
    return;
  }
  const minutes = Math.max(1, Math.min(240, Number(settings.focusMinutes || 25) || 25));
  focusReminderNextAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  focusReminderTimer = setTimeout(() => {
    const workspaceRoot = activeProjectRoot || getSelectedProjectPath(context) || getWorkspaceRoot();
    if (rule.notify) {
      showAutomationNotification('focus_time', '', 'Completed');
    }
    if (rule.sound) {
      playAutomationSound();
    }
    if (workspaceRoot) {
      recordAutomationTaskEvent(workspaceRoot, {
        trigger: 'focus_time',
        action: 'reminder',
        status: 'ok',
        focusMinutes: minutes
      });
    }
    scheduleFocusReminder(context);
  }, minutes * 60 * 1000);
  if (focusReminderTimer && typeof focusReminderTimer.unref === 'function') {
    focusReminderTimer.unref();
  }
  void broadcastSettings(context);
}

function getNextScheduledAutomationAt(timeOfDay: string, now = new Date()): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeOfDay || '').trim());
  const hours = match ? Number(match[1]) : 9;
  const minutes = match ? Number(match[2]) : 0;
  const next = new Date(now.getTime());
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function getNextScheduledAutomationTask(tasks: SolomapScheduledAutomationTask[], now = new Date()): { task: SolomapScheduledAutomationTask; nextAt: Date } | null {
  const candidates = tasks
    .filter((task) => task && task.enabled !== false && String(task.prompt || '').trim())
    .map((task) => ({
      task,
      nextAt: getNextScheduledAutomationAt(task.timeOfDay || '09:00', now)
    }))
    .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime());
  return candidates[0] || null;
}

function getScheduledAutomationProjectPath(task: SolomapScheduledAutomationTask, fallbackProjectPath: string): string {
  return String(task.projectPath || '').trim() || String(fallbackProjectPath || '').trim();
}

function scheduleTimedAutomationTask(context: vscode.ExtensionContext): void {
  if (scheduledAutomationTimer) {
    clearTimeout(scheduledAutomationTimer);
    scheduledAutomationTimer = null;
  }
  const settings = getPersistedSettings(context).automationTasks || normalizeAutomationSettings({});
  const next = getNextScheduledAutomationTask(settings.scheduledTasks || []);
  if (!next) {
    scheduledAutomationNextAt = '';
    return;
  }
  scheduledAutomationNextAt = next.nextAt.toISOString();
  const delayMs = Math.max(1000, next.nextAt.getTime() - Date.now());
  scheduledAutomationTimer = setTimeout(() => {
    void runScheduledAutomationTask(context, next.task.id).finally(() => {
      scheduleTimedAutomationTask(context);
    });
  }, delayMs);
  if (scheduledAutomationTimer && typeof scheduledAutomationTimer.unref === 'function') {
    scheduledAutomationTimer.unref();
  }
  void broadcastSettings(context);
}

async function runScheduledAutomationTask(context: vscode.ExtensionContext, taskId = ''): Promise<void> {
  const settings = getPersistedSettings(context).automationTasks || normalizeAutomationSettings({});
  const tasks = settings.scheduledTasks || [];
  const task = tasks.find((candidate) => candidate.id === taskId) || getNextScheduledAutomationTask(tasks)?.task;
  const prompt = String(task?.prompt || '').trim();
  if (!task || task.enabled === false || !prompt) {
    return;
  }
  const targetProjectPath = getScheduledAutomationProjectPath(task, activeProjectRoot || getSelectedProjectPath(context) || '');
  const workspaceRoot = await ensureActionProject(context, targetProjectPath);
  if (!workspaceRoot) {
    return;
  }
  const timeOfDay = String(task.timeOfDay || '09:00');
  const runKey = `${new Date().toISOString().slice(0, 10)}:${task.id}:${timeOfDay}:${workspaceRoot}`;
  if (scheduledAutomationRunKeys.has(runKey)) {
    recordAutomationTaskEvent(workspaceRoot, {
      trigger: 'scheduled_time',
      action: 'prompt',
      status: 'skipped',
      taskId: task.id,
      message: 'Already launched this scheduled automation task today.'
    });
    return;
  }
  scheduledAutomationRunKeys.add(runKey);
  recordAutomationTaskEvent(workspaceRoot, {
    trigger: 'scheduled_time',
    action: 'prompt',
    status: 'started',
    taskId: task.id,
    title: task.title || '',
    timeOfDay
  });
  await handleRunSoloConversation(context, prompt, getPersistedSettings(context).cliPath || '');
}

function scheduleAutomationTasksAfterRun(context: vscode.ExtensionContext, input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  nextStatus: string;
  failureCode: string;
  executionLogId: number;
  agentCli: string;
  userMessage: string;
  isReviewRun: boolean;
  isContinuationRun: boolean;
}): void {
  const trigger = automationTriggerFromRunStatus(input.nextStatus, input.failureCode);
  if (!trigger || input.isReviewRun || input.isContinuationRun || !input.workspaceRoot || !input.executionLogId) {
    return;
  }
  const automationTasks = getPersistedSettings(context).automationTasks || normalizeAutomationSettings({});
  if (!hasAutomationAction(automationTasks, trigger)) {
    return;
  }
  setTimeout(() => {
    void runAutomationTasksAfterRun(context, trigger, input).catch((error) => {
      recordAutomationTaskEvent(input.workspaceRoot, {
        trigger,
        nodeId: input.nodeId,
        executionLogId: input.executionLogId,
        action: 'automation',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      });
      console.warn('SoloMap automation task failed:', error);
    });
  }, 0);
}

async function runAutomationTasksAfterRun(context: vscode.ExtensionContext, trigger: SolomapAutomationTrigger, input: {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  nextStatus: string;
  failureCode: string;
  executionLogId: number;
  agentCli: string;
  userMessage: string;
}): Promise<void> {
  const settings = getPersistedSettings(context).automationTasks || normalizeAutomationSettings({});
  const rule = settings.triggers?.[trigger] || {};
  if (rule.notify) {
    showAutomationNotification(trigger, input.nodeId, input.nextStatus);
    recordAutomationTaskEvent(input.workspaceRoot, {
      trigger,
      nodeId: input.nodeId,
      executionLogId: input.executionLogId,
      action: 'notification',
      status: 'ok'
    });
  }
  if (rule.sound) {
    playAutomationSound();
    recordAutomationTaskEvent(input.workspaceRoot, {
      trigger,
      nodeId: input.nodeId,
      executionLogId: input.executionLogId,
      action: 'sound',
      status: 'ok'
    });
  }
  if ((trigger === 'failed' || trigger === 'stopped') && rule.retry) {
    if (!automationRetryConversationIds.has(input.executionLogId)) {
      automationRetryConversationIds.add(input.executionLogId);
      recordAutomationTaskEvent(input.workspaceRoot, {
        trigger,
        nodeId: input.nodeId,
        executionLogId: input.executionLogId,
        action: 'retry',
        status: 'started'
      });
      await handleRetryConversation(context, input.nodeId, input.executionLogId);
    } else {
      recordAutomationTaskEvent(input.workspaceRoot, {
        trigger,
        nodeId: input.nodeId,
        executionLogId: input.executionLogId,
        action: 'retry',
        status: 'skipped',
        message: 'Already retried this conversation in the current extension session.'
      });
    }
  }
  const prompt = String(rule.prompt || '').trim();
  if (prompt) {
    const promptKey = `${trigger}:${input.executionLogId}`;
    if (automationPromptConversationIds.has(promptKey)) {
      recordAutomationTaskEvent(input.workspaceRoot, {
        trigger,
        nodeId: input.nodeId,
        executionLogId: input.executionLogId,
        action: 'prompt',
        status: 'skipped',
        message: 'Already launched this automation prompt in the current extension session.'
      });
      return;
    }
    automationPromptConversationIds.add(promptKey);
    recordAutomationTaskEvent(input.workspaceRoot, {
      trigger,
      nodeId: input.nodeId,
      executionLogId: input.executionLogId,
      action: 'prompt',
      status: 'started'
    });
    if (input.runKind === 'roadmap_revision' || input.nodeId === roadmapRevisionId) {
      await handleRoadmapRevision(context, prompt, input.agentCli || '');
    } else if (input.runKind === 'solo' || input.nodeId === soloConversationId) {
      await handleRunSoloConversation(context, prompt, input.agentCli || '');
    } else {
      await handleRunAgent(context, input.nodeId, prompt, input.agentCli || '');
    }
  }
}

function didRoadmapCsvChange(changedFilesSummary: string, touchedFilesSummary: string): boolean {
  const combined = [changedFilesSummary, touchedFilesSummary].join('\n');
  return combined.includes('.solopreneur/roadmap.csv');
}

function validateBootstrapRoadmapRewrite(workspaceRoot: string, nodeId: string): { valid: boolean; reason: string } {
  const roadmapPath = path.join(workspaceRoot, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return { valid: false, reason: '未找到 .solopreneur/roadmap.csv。' };
  }

  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const parsed = Papa.parse<RoadmapNode>(content, { header: true, skipEmptyLines: true });
    const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
    const fields = parsed.meta.fields || [];
    const nodes = parsed.data.map((node) => ({
      id: String(node.id || '').trim(),
      title: String(node.title || '').trim(),
      description: String(node.description || '').trim(),
      stage: String(node.stage || '').trim(),
      dependencies: String(node.dependencies || '').trim(),
      agentCli: String(node.agentCli || '').trim(),
      agentPrompt: String(node.agentPrompt || '').trim(),
      status: String(node.status || '').trim()
    })).filter((node) => node.id);
    const bootstrapMarkers = [
      '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
      '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
      '保留 CSV 表头且字段顺序必须严格是',
      '生成初始路线图',
      '.solopreneur/bootstrap-roadmap-instructions.md',
      '不要把本文件内容、提示词模板或解释性说明写回 CSV'
    ];

    if (parsed.errors.length > 0 || requiredColumns.some((field) => !fields.includes(field))) {
      return { valid: false, reason: '生成后的 roadmap.csv 格式不完整或无法被稳定解析。' };
    }
    if (nodes.length < 2 || nodes.length > 8) {
      return { valid: false, reason: '生成后的路线图环节数量不在 2 到 8 个之间。' };
    }
    if (nodes.some((node) => !node.title || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '生成后的路线图存在缺少标题、描述或 agentPrompt 的环节。' };
    }
    if (nodes.some((node) => !node.stage)) {
      return { valid: false, reason: '生成后的路线图存在缺少 stage 的环节。' };
    }
    const ids = nodes.map((node) => node.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      return { valid: false, reason: '生成后的路线图存在重复环节 ID。' };
    }
    for (const node of nodes) {
      const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
        return { valid: false, reason: '生成后的路线图存在无效依赖关系。' };
      }
    }
    if (nodes.some((node) => node.status !== 'Pending')) {
      return { valid: false, reason: '生成后的路线图所有环节都必须回到 Pending。' };
    }
    if (nodes.some((node) => bootstrapMarkers.some((marker) => node.title.includes(marker) || node.agentPrompt.includes(marker)))) {
      return { valid: false, reason: '生成后的 roadmap.csv 仍然残留了初始化提示词，没有真正写成业务路线图。' };
    }
    if (nodes.some((node) => node.title === '生成初始路线图')) {
      return { valid: false, reason: '生成后的路线图仍然保留了原始 bootstrap 节点。' };
    }
    return { valid: true, reason: '' };
  } catch (error: any) {
    return { valid: false, reason: `生成后的 roadmap.csv 校验失败：${error?.message || error}` };
  }
}

function validateRoadmapRevision(workspaceRoot: string): { valid: boolean; reason: string } {
  const roadmapPath = path.join(workspaceRoot, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return { valid: false, reason: '调整后的路线图文件不存在。' };
  }
  try {
    const parsed = Papa.parse<RoadmapNode>(fs.readFileSync(roadmapPath, 'utf8'), {
      header: true,
      skipEmptyLines: true
    });
    const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
    const fields = parsed.meta.fields || [];
    if (parsed.errors.length > 0 || requiredColumns.some((field) => !fields.includes(field))) {
      return { valid: false, reason: '调整后的 roadmap.csv 格式不完整或无法解析。' };
    }
    const nodes = parsed.data
      .map((node) => ({
        ...node,
        id: String(node.id || '').trim(),
        title: String(node.title || '').trim(),
        description: String(node.description || '').trim(),
        agentPrompt: String(node.agentPrompt || '').trim(),
        dependencies: String(node.dependencies || '').trim(),
        status: String(node.status || '').trim()
      }))
      .filter((node) => node.id);
    if (nodes.length === 0) {
      return { valid: false, reason: '调整后的路线图没有可执行环节。' };
    }
    const ids = nodes.map((node) => node.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      return { valid: false, reason: '调整后的路线图存在重复环节 ID。' };
    }
    if (nodes.some((node) => !node.title || !String(node.stage || '').trim() || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '调整后的路线图存在缺少标题、阶段、描述或 Agent 任务的环节。' };
    }
    const allowedStatuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
    if (nodes.some((node) => !allowedStatuses.has(node.status))) {
      return { valid: false, reason: '调整后的路线图存在无法识别的环节状态。' };
    }
    for (const node of nodes) {
      const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
        return { valid: false, reason: '调整后的路线图存在无效依赖关系。' };
      }
    }
    return { valid: true, reason: '' };
  } catch (error: any) {
    return { valid: false, reason: `调整后的路线图校验失败：${error?.message || error}` };
  }
}

function restoreRoadmapBackup(roadmapBackupFilePath: string, workspaceRoot: string): boolean {
  if (!roadmapBackupFilePath || !fs.existsSync(roadmapBackupFilePath)) {
    return false;
  }
  fs.writeFileSync(
    path.join(workspaceRoot, '.solopreneur', 'roadmap.csv'),
    fs.readFileSync(roadmapBackupFilePath, 'utf8'),
    'utf8'
  );
  return true;
}

function readTextFileSafe(filePath: string): string {
  try {
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

async function processFlowStatusFile(statusFilePath: string, statusData: any): Promise<boolean> {
  const flowMeta = parseFlowExecutionNodeId(String(statusData.nodeId || ''));
  if (!flowMeta || !syncEngine || !activeProjectRoot) {
    return false;
  }
  const { flowId, loopId, role } = flowMeta;
  if (String(statusData.status || '') === 'Running' || String(statusData.status || '') === 'Processed') {
    return true;
  }
  const flow = readFlowTrace(activeProjectRoot, flowId);
  if (!flow) {
    return true;
  }
  const loop = flow.loops.find((candidate) => candidate.loopId === loopId);
  if (!loop) {
    return true;
  }
  const executionLogId = Number(statusData.executionLogId || 0);
  const outputText = readTextFileSafe(String(statusData.outputFilePath || ''));
  const outputTail = getOutputTail(String(statusData.outputFilePath || ''));
  const changedFilesSummary = getChangedFilesSummary(String(statusData.changesFilePath || ''));
  const touchedFilesSummary = getTouchedFilesSummary(String(statusData.touchedFilesPath || ''));
  const resolvedCommand = String(readTextFileSafe(String(statusData.commandFilePath || '')) || statusData.commandPreview || '').trim();
  const structured = extractFlowJsonBlock(outputText || outputTail);
  const validationErrors = role === 'planner'
    ? validateFlowPlannerResult(structured)
    : role === 'builder'
      ? validateFlowBuilderResult(structured)
      : validateFlowVerifierResult(structured);
  const finishedAt = new Date().toISOString();
  const currentRetryCount = Number((loop as any)[role]?.retryCount || 0);
  if (validationErrors.length > 0 && currentRetryCount < 2) {
    const nextRetryCount = currentRetryCount + 1;
    const roleExecution: import('./flowStore').FlowRoleExecution = {
      status: 'running' as const,
      executionLogId,
      startedAt: new Date().toISOString(),
      command: resolvedCommand,
      outputTail,
      validationErrors,
      data: structured || undefined,
      retryCount: nextRetryCount
    };

    const feedbackPrompt = [
      `你在上一轮执行中产出的结构化 JSON 未通过校验，请根据以下校验错误信息进行自检修正，并重新输出完整的 JSON（包在 SOLOMAP_FLOW_JSON_START 和 SOLOMAP_FLOW_JSON_END 之间）：`,
      ...validationErrors.map(err => `- ${err}`),
      '',
      '你上一轮输出的日志尾部是：',
      outputTail,
      '',
      '请重新输出，确保所有必填字段齐全，JSON 可被合法解析。'
    ].join('\n');

    const summaryLines = [
      `Flow ${role} validation failed. Retrying correction (${nextRetryCount}/2).`,
      `Flow ID: ${flowId}`,
      `Loop ID: ${loopId}`,
      validationErrors.length ? `Validation errors:\n${validationErrors.join('\n')}` : '',
      `Workspace changes:\n${changedFilesSummary || '无'}`,
      `Touched project files:\n${touchedFilesSummary || '无'}`,
      outputTail ? `Agent output tail:\n${outputTail}` : ''
    ].filter(Boolean).join('\n\n');

    syncEngine.updateAgentExecution(
      executionLogId,
      String(statusData.agentCli || ''),
      resolvedCommand,
      summaryLines,
      'Running'
    );

    const nextFlow = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
      trace.loops = trace.loops.map((candidate) => {
        if (candidate.loopId !== loopId) {
          return candidate;
        }
        const nextLoop = { ...candidate, updatedAt: finishedAt };
        (nextLoop as any)[role] = roleExecution;
        nextLoop.status = role === 'planner' ? 'created' : role === 'builder' ? 'planned' : 'evidence_collected';
        return nextLoop;
      });
      trace.status = 'running';
      trace.latestSummary = `Flow ${role} 结构校验失败，正在进行第 ${nextRetryCount} 次自检修正。`;
      return trace;
    });

    if (nextFlow) {
      if (extensionContextRef) {
        await postFlowStateToWebview(extensionContextRef);
      }
      await startFlowRoleRun(extensionContextRef!, {
        projectPath: activeProjectRoot,
        flow: nextFlow,
        loopIndex: loop.index,
        role: role,
        prompt: feedbackPrompt
      });
      return true;
    }
  }

  const roleExecution: import('./flowStore').FlowRoleExecution = {
    status: (String(statusData.status || '') === 'In Progress' && validationErrors.length === 0 ? 'completed' : 'failed') as 'completed' | 'failed',
    executionLogId,
    finishedAt,
    command: resolvedCommand,
    outputTail,
    validationErrors,
    data: structured || undefined,
    retryCount: currentRetryCount
  };
  const summaryLines = [
    `Flow ${role} finished.`,
    `Flow ID: ${flowId}`,
    `Loop ID: ${loopId}`,
    `Sentinel captured state: ${String(statusData.status || '')}`,
    validationErrors.length ? `Validation errors:\n${validationErrors.join('\n')}` : '',
    `Workspace changes:\n${changedFilesSummary || '无'}`,
    `Touched project files:\n${touchedFilesSummary || '无'}`,
    outputTail ? `Agent output tail:\n${outputTail}` : ''
  ].filter(Boolean).join('\n\n');
  syncEngine.updateAgentExecution(
    executionLogId,
    String(statusData.agentCli || ''),
    resolvedCommand,
    summaryLines,
    roleExecution.status === 'completed' ? 'Completed' : 'Failed'
  );

  const nextFlow = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
    trace.loops = trace.loops.map((candidate) => {
      if (candidate.loopId !== loopId) {
        return candidate;
      }
      const nextLoop: typeof candidate = {
        ...candidate,
        updatedAt: finishedAt,
        summary: structured?.summary ? String(structured.summary) : candidate.summary
      };
      if (role === 'planner') {
        nextLoop.planner = roleExecution;
        nextLoop.status = roleExecution.status === 'completed' ? 'planned' : 'planning_incomplete';
      } else if (role === 'builder') {
        nextLoop.builder = roleExecution;
        nextLoop.evidence = {
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          commandFilePath: String(statusData.commandFilePath || ''),
          outputFilePath: String(statusData.outputFilePath || ''),
          changesFilePath: String(statusData.changesFilePath || ''),
          touchedFilesPath: String(statusData.touchedFilesPath || '')
        };
        nextLoop.status = roleExecution.status === 'completed'
          ? (changedFilesSummary.trim() || touchedFilesSummary.trim() ? 'evidence_collected' : 'no_effect')
          : 'no_effect';
      } else {
        nextLoop.verifier = roleExecution;
        nextLoop.scoring = deriveFlowLoopScoring(structured, changedFilesSummary, touchedFilesSummary);
        nextLoop.status = roleExecution.status === 'completed' ? nextLoop.scoring.recommendedStatus : 'implemented_unverified';
      }
      return nextLoop;
    });
    const currentLoop = trace.loops.find((candidate) => candidate.loopId === loopId);
    trace.latestSummary = currentLoop?.summary || trace.latestSummary;
    if (role === 'verifier' && currentLoop?.scoring?.recommendedStatus === 'closed') {
      trace.status = 'completed';
      trace.completedAt = finishedAt;
      trace.latestSummary = currentLoop.summary || currentLoop.scoring.reasons.join('；') || 'Flow 已完成目标。';
    } else if (role === 'verifier' && currentLoop?.scoring?.recommendedStatus === 'needs_user_confirmation') {
      trace.status = 'needs_user_confirmation';
      trace.latestSummary = currentLoop.summary || 'Flow 需要用户确认后才能继续。';
    } else if (roleExecution.status === 'failed') {
      trace.status = 'failed';
      trace.latestSummary = `Flow ${role} 未通过。`;
    } else {
      trace.status = 'running';
    }
    return trace;
  });
  if (!nextFlow) {
    return true;
  }
  const latestLearningFlow = readFlowTrace(activeProjectRoot, flowId) || nextFlow;
  const latestLearningLoop = latestLearningFlow.loops.find((candidate) => candidate.loopId === loopId);
  const learningStatus = latestLearningLoop?.scoring?.recommendedStatus || latestLearningLoop?.status || roleExecution.status;
  const flowEventType = roleExecution.status === 'failed'
    ? 'failed'
    : role === 'verifier' && learningStatus === 'closed'
      ? 'verified'
      : ['deviated', 'partial', 'verified_failed', 'implemented_unverified', 'no_effect'].includes(String(learningStatus))
        ? 'deviated'
        : learningStatus === 'needs_user_confirmation'
          ? 'needs_confirmation'
          : 'completed';
  try {
    const flowGlobalDataPath = String(statusData.globalDataPath || (extensionContextRef ? getPersistedSettings(extensionContextRef).globalDataPath : '') || '');
    appendLearningEvent(activeProjectRoot, flowGlobalDataPath, {
      sourceType: 'flow_loop',
      sourceRef: `${flowId}:${loopId}:${role}:${executionLogId || 0}`,
      eventType: flowEventType,
      summary: latestLearningLoop?.summary || `${role} finished with ${String(learningStatus)}`,
      evidenceRefs: ([
        { type: 'flow' as const, ref: toProjectRelativeRuntimePath(activeProjectRoot, path.join(activeProjectRoot, '.solopreneur', 'flows', `${flowId}.json`)), summary: 'Flow trace' },
        statusData.outputFilePath ? { type: 'file' as const, ref: toProjectRelativeRuntimePath(activeProjectRoot, String(statusData.outputFilePath)), summary: 'Flow role output' } : null,
        statusData.changesFilePath ? { type: 'file' as const, ref: toProjectRelativeRuntimePath(activeProjectRoot, String(statusData.changesFilePath)), summary: 'Workspace changes' } : null,
        ...(latestLearningLoop?.scoring?.reasons || []).map((reason) => ({ type: 'trace' as const, ref: reason, summary: 'H/I/J scoring reason' }))
      ].filter(Boolean) as LearningEvidenceRef[]),
      tags: ['flow', role, flowId, loopId, String(learningStatus)],
      metadata: {
        flowId,
        loopId,
        role,
        status: roleExecution.status,
        recommendedStatus: learningStatus,
        validationErrors,
        scoring: latestLearningLoop?.scoring || null,
        planner: latestLearningLoop?.planner?.data || null,
        builder: latestLearningLoop?.builder?.data || null,
        verifier: latestLearningLoop?.verifier?.data || null,
        changedFiles: parseFileSummaryLines(changedFilesSummary),
        touchedFiles: parseFileSummaryLines(touchedFilesSummary),
        failures: validationErrors
      },
      sourcePayload: latestLearningLoop || undefined
    });
  } catch (error) {
    console.warn('Failed to append Flow learning event:', error);
  }
  if (extensionContextRef) {
    await postFlowStateToWebview(extensionContextRef);
  }

  if (role === 'planner' && roleExecution.status === 'completed') {
    await startFlowRoleRun(extensionContextRef!, {
      projectPath: activeProjectRoot,
      flow: nextFlow,
      loopIndex: loop.index,
      role: 'builder',
      prompt: buildFlowBuilderPrompt({
        goal: nextFlow.goal,
        workspaceRoot: activeProjectRoot,
        flowId,
        loopId,
        planner: structured || {},
        globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
        globalDataPath: getPersistedSettings(extensionContextRef!).globalDataPath,
        supplementFiles: nextFlow.source.supplementFiles || []
      })
    });
  } else if (role === 'builder' && roleExecution.status === 'completed') {
    const updatedLoop = readFlowTrace(activeProjectRoot, flowId)?.loops.find((candidate) => candidate.loopId === loopId);
    await startFlowRoleRun(extensionContextRef!, {
      projectPath: activeProjectRoot,
      flow: readFlowTrace(activeProjectRoot, flowId) || nextFlow,
      loopIndex: loop.index,
      role: 'verifier',
      prompt: buildFlowVerifierPrompt({
        goal: nextFlow.goal,
        workspaceRoot: activeProjectRoot,
        flowId,
        loopId,
        planner: updatedLoop?.planner.data || {},
        builder: structured || {},
        evidence: {
          changedFilesSummary,
          touchedFilesSummary,
          outputTail
        },
        globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
        globalDataPath: getPersistedSettings(extensionContextRef!).globalDataPath,
        supplementFiles: nextFlow.source.supplementFiles || []
      })
    });
  } else if (role === 'verifier' && roleExecution.status === 'completed') {
    const latest = readFlowTrace(activeProjectRoot, flowId);
    const latestLoop = latest?.loops.find((candidate) => candidate.loopId === loopId);
    if (latest && latestLoop?.status === 'closed' && latest.source.roadmapStepId && syncEngine) {
      syncEngine.updateNode(latest.source.roadmapStepId, {
        status: 'Completed',
        completedAt: finishedAt
      });
      sendNodesToWebview();
      refreshSidebarProjectCards();
    }
    const shouldSpawnFollowup = latest && latestLoop && ['partial', 'implemented_unverified', 'verified_failed', 'deviated', 'needs_review', 'no_effect'].includes(latestLoop.status);
    if (shouldSpawnFollowup && latest && latest.currentLoopIndex < 6) {
      const nextLoopIndex = latest.currentLoopIndex + 1;
      const nextLoopGoal = String(structured?.nextLoopGoal || latestLoop?.summary || latest.goal).trim() || latest.goal;
      const spawned = updateFlowTrace(activeProjectRoot, flowId, (trace) => {
        trace.currentLoopIndex = nextLoopIndex;
        trace.loops = [
          ...trace.loops.map((candidate) => candidate.loopId === loopId ? { ...candidate, status: 'spawned_followup' as FlowLoopStatus, updatedAt: new Date().toISOString() } : candidate),
          createFlowLoop(nextLoopGoal, nextLoopIndex)
        ];
        trace.status = 'running';
        trace.latestSummary = `继续推进：${nextLoopGoal}`;
        return trace;
      });
      if (spawned) {
        await postFlowStateToWebview(extensionContextRef!);
        await startFlowRoleRun(extensionContextRef!, {
          projectPath: activeProjectRoot,
          flow: spawned,
          loopIndex: nextLoopIndex,
          role: 'planner',
          prompt: buildFlowPlannerPrompt({
            goal: nextLoopGoal,
            workspaceRoot: activeProjectRoot,
            flowId,
            loopId: `loop-${nextLoopIndex}`,
            globalPrompt: getPersistedSettings(extensionContextRef!).globalPrompt,
            globalDataPath: getPersistedSettings(extensionContextRef!).globalDataPath,
            supplementFiles: latest.source.supplementFiles || []
          })
        });
      }
    }
  }
  agentTerminalNamesByConversationId.delete(executionLogId);
  setTimeout(() => {
    const currentStatus = readAgentStatus(statusFilePath);
    if (currentStatus && Number(currentStatus.executionLogId || 0) === executionLogId && fs.existsSync(statusFilePath)) {
      fs.writeFileSync(statusFilePath, JSON.stringify({
        ...currentStatus,
        status: 'Processed',
        processedAt: new Date().toISOString()
      }), 'utf8');
    }
  }, 500);
  return true;
}

async function processAgentStatusFile(statusFilePath: string): Promise<void> {
  if (!fs.existsSync(statusFilePath)) {
    return;
  }

  try {
    const fileContent = fs.readFileSync(statusFilePath, 'utf8').trim();
    if (!fileContent) {
      return;
    }

    const statusData = JSON.parse(fileContent);
    const statusWorkspaceRoot = String(inferWorkspaceRootFromStatusFilePath(statusFilePath) || statusData.workspaceRoot || '').trim();
    if (statusWorkspaceRoot && activeProjectRoot && statusWorkspaceRoot !== activeProjectRoot) {
      return;
    }
    if (parseFlowExecutionNodeId(String(statusData.nodeId || ''))) {
      await processFlowStatusFile(statusFilePath, statusData);
      return;
    }
    const { nodeId, runKind, roadmapBackupFilePath, globalDataPath, status, agentCli, command, commandPreview, commandFilePath, promptFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath, sessionFilePath, codexHomeFilePath, nativeSessionId, sessionMode, startedAt, reviewerCliPath, collaborationReviewMode, reviewResultFilePath, reviewTargetStatus, reviewOfExecutionLogId } = statusData;

    if (!nodeId || !status || status === 'Running' || status === 'Processed' || !syncEngine) {
      return;
    }

    const isReviewRun = runKind === 'agent_review';
    const isContinuationRun = isContinuationRunKind(String(runKind || ''));
    const isSoloConversation = runKind === 'solo' || nodeId === soloConversationId;
    let nextStatus = String(status || '');
    let completionReason = '';
    let failureCode = String(statusData.failureCode || '').trim();
    let failureReason = String(statusData.failureReason || '').trim();
    const currentNode = syncEngine.getNodes().find((candidate) => candidate.id === nodeId) || null;
    const hasOtherRunningConversationForNode = !isSoloConversation
      && !isReviewRun
      && nodeId !== roadmapRevisionId
      && syncEngine.getAgentExecutions(nodeId).some((conversation) => (
        conversation.status === 'Running'
        && Number(conversation.id || 0) !== Number(executionLogId || 0)
      ));
    let reviewResult: ReturnType<typeof parseAgentReviewResult> | null = null;
    if (isReviewRun && status === 'In Progress') {
      reviewResult = parseAgentReviewResult(String(reviewResultFilePath || ''));
      if (reviewResult.status === 'pass') {
        nextStatus = 'Completed';
        completionReason = reviewResult.summary || '副 Agent 复核通过。';
      } else if (reviewResult.status === 'revise') {
        nextStatus = 'In Progress';
        completionReason = reviewResult.summary || '副 Agent 发现需要继续修正的问题。';
      } else {
        nextStatus = 'In Progress';
        completionReason = reviewResult.summary || '副 Agent 认为需要用户确认。';
      }
    } else if (status === 'In Progress' && completionDecisionFilePath && fs.existsSync(completionDecisionFilePath)) {
      try {
        const completionDecision = JSON.parse(fs.readFileSync(completionDecisionFilePath, 'utf8'));
        if (completionDecision.markCompleted === true) {
          nextStatus = 'Completed';
          completionReason = completionDecision.reason || 'Agent marked this roadmap step complete.';
        }
      } catch (error) {
        nextStatus = 'Failed';
        failureCode = 'completion_state_invalid';
        failureReason = 'Agent completion decision file could not be parsed.';
        completionReason = 'Agent completion decision file could not be parsed.';
      }
    }

    const outputTail = getOutputTail(outputFilePath);
    const changedFilesSummary = getChangedFilesSummary(changesFilePath);
    const touchedFilesSummary = getTouchedFilesSummary(touchedFilesPath);
    const workspaceRoot = statusWorkspaceRoot || activeProjectRoot || '';
    if (workspaceRoot && activeProjectRoot && workspaceRoot !== activeProjectRoot) {
      return;
    }
    const roadmapCsvChanged = didRoadmapCsvChange(changedFilesSummary, touchedFilesSummary);
    // User-confirmed completion remains authoritative over any in-flight Agent result.
    const preserveCompletedNode = currentNode?.status === 'Completed';
    let shouldWriteNodeStatus = !preserveCompletedNode && !isSoloConversation;
    let shouldRefreshRoadmap = false;
    let reviewDeferredCompletion = false;
    if (isReviewRun) {
      shouldWriteNodeStatus = !preserveCompletedNode && !isSoloConversation;
      shouldRefreshRoadmap = false;
      if (reviewResult?.status === 'pass' && String(reviewTargetStatus || '') !== 'Completed') {
        shouldWriteNodeStatus = false;
      }
    } else if (workspaceRoot && isContinuationRun) {
      shouldWriteNodeStatus = false;
      nextStatus = 'Recorded';
      completionReason = '续聊已记录；不参与任务完成、失败或进行中判断。';
      failureCode = '';
      failureReason = '';
      shouldRefreshRoadmap = roadmapCsvChanged;
    } else if (workspaceRoot && isSoloConversation) {
      shouldWriteNodeStatus = false;
      if (status === 'In Progress') {
        nextStatus = 'Completed';
        completionReason = 'Solo 对话已完成，等待用户决定是否关联到路线图环节。';
      } else {
        nextStatus = 'Failed';
        failureCode = failureCode || 'agent_exit_failed';
        failureReason = failureReason || 'Agent CLI 在完成 Solo 对话前退出。';
        completionReason = failureReason;
      }
      if (roadmapCsvChanged && restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot)) {
        const protectedRoadmapReason = 'Solo 对话不会直接调整路线图，已保留对话前路线图。';
        completionReason = completionReason ? `${completionReason} ${protectedRoadmapReason}` : protectedRoadmapReason;
      }
    } else if (workspaceRoot && runKind === 'roadmap_revision') {
      shouldWriteNodeStatus = false;
      if (status === 'In Progress' && roadmapCsvChanged) {
        const validation = validateRoadmapRevision(workspaceRoot);
        if (validation.valid) {
          nextStatus = 'Completed';
          completionReason = '路线图已按本次要求更新并通过校验。';
          shouldRefreshRoadmap = true;
        } else {
          nextStatus = 'Failed';
          failureCode = 'roadmap_validation_failed';
          failureReason = `${validation.reason} 已保留调整前的路线图。`;
          completionReason = failureReason;
          restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot);
        }
      } else if (status === 'In Progress') {
        nextStatus = 'Failed';
        failureCode = 'roadmap_not_updated';
        failureReason = 'Agent 未更新路线图文件，原路线图保持不变。';
        completionReason = failureReason;
      } else {
        nextStatus = 'Failed';
        failureCode = failureCode || 'agent_exit_failed';
        failureReason = failureReason || 'Agent CLI 在完成路线图调整前退出。';
        if (roadmapCsvChanged && restoreRoadmapBackup(roadmapBackupFilePath, workspaceRoot)) {
          failureReason = `${failureReason} 已保留调整前的路线图。`;
        }
        completionReason = failureReason;
      }
    } else if (workspaceRoot && currentNode?.title === '生成初始路线图' && roadmapCsvChanged) {
      const validation = validateBootstrapRoadmapRewrite(workspaceRoot, nodeId);
      if (!validation.valid) {
        nextStatus = 'Failed';
        completionReason = validation.reason;
        failureCode = 'roadmap_validation_failed';
        failureReason = validation.reason;
      } else {
        shouldWriteNodeStatus = false;
        shouldRefreshRoadmap = true;
        if (!completionReason) {
          completionReason = '初始路线图已写入 roadmap.csv，并通过结构校验。';
        }
      }
    } else if (workspaceRoot && roadmapCsvChanged) {
      shouldWriteNodeStatus = false;
      shouldRefreshRoadmap = true;
    }
    const shouldStartReview = workspaceRoot && !isReviewRun && shouldRunAgentReview(
      collaborationReviewMode === undefined ? 'off' : String(collaborationReviewMode || 'high_risk'),
      String(runKind || 'step'),
      String(nodeId || ''),
      nextStatus,
      changedFilesSummary,
      touchedFilesSummary
    );
    if (isContinuationRun) {
      shouldWriteNodeStatus = false;
      nextStatus = 'Recorded';
      completionReason = '续聊已记录；不参与任务完成、失败或进行中判断。';
      failureCode = '';
      failureReason = '';
    }
    if (shouldStartReview && shouldWriteNodeStatus && nextStatus === 'Completed') {
      reviewDeferredCompletion = true;
      nextStatus = 'In Progress';
      completionReason = completionReason
        ? `${completionReason} 正在等待副 Agent 复核。`
        : '主 Agent 已标记完成，正在等待副 Agent 复核。';
    }
    if (shouldWriteNodeStatus) {
      let nodeStatus = nextStatus;
      if (hasOtherRunningConversationForNode) {
        nodeStatus = 'Running';
        completionReason = completionReason
          ? `${completionReason} 该环节仍有其他 Agent 对话正在运行。`
          : '该环节仍有其他 Agent 对话正在运行。';
      }
      const completedAt = nodeStatus === 'Completed' ? new Date().toISOString() : '';
      syncEngine.updateNode(nodeId, {
        status: nodeStatus as RoadmapNode['status'],
        completedAt,
      });
      refreshSidebarProjectCards();
    }
    let nativeSessionSummary = '';
    if (workspaceRoot && sessionFilePath && fs.existsSync(sessionFilePath)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
        const sessionId = String(sessionData.sessionId || '').trim();
        if (sessionId) {
          updateStoredAgentSession(workspaceRoot, nodeId, agentCli || command || 'unknown', sessionId);
          nativeSessionSummary = `Native Agent session saved: ${getStepSessionFilePath(workspaceRoot, nodeId)} (${sessionId})`;
        }
      } catch {
        nativeSessionSummary = 'Native Agent session could not be parsed.';
      }
    }
    const resolvedCommand = commandFilePath && fs.existsSync(commandFilePath)
      ? fs.readFileSync(commandFilePath, 'utf8').trim()
      : command || commandPreview || 'Completed execution in terminal';
    if (nextStatus === 'Failed' && !failureReason) {
      failureCode = failureCode || 'agent_exit_failed';
      failureReason = completionReason || 'Agent CLI exited before completing this task.';
    }
    const finishedAt = new Date().toISOString();
    const startedTime = startedAt ? Date.parse(String(startedAt)) : NaN;
    const runDurationMs = Number.isFinite(startedTime) ? Math.max(0, Date.now() - startedTime) : 0;
    const handoffEntry = workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation && !isReviewRun && !isContinuationRun
      ? buildRunHandoffEntry(
        nextStatus,
        [changedFilesSummary, touchedFilesSummary].filter(Boolean).join('\n'),
        outputTail,
        completionReason
      )
      : '';
    const stepHandoffSummary = workspaceRoot && handoffEntry
      ? updateStepHandoffSummary(getStepMemoryFilePath(workspaceRoot, nodeId), handoffEntry)
      : '';
    if (workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation && !isReviewRun && !isContinuationRun) {
      recordSolomapLearningCycle(
        workspaceRoot,
        String(globalDataPath || ''),
        currentNode,
        nextStatus,
        changedFilesSummary,
        touchedFilesSummary,
        outputTail,
        runDurationMs,
        finishedAt
      );
    }
    const documentationAudit = workspaceRoot && !isReviewRun && !isContinuationRun
      ? auditDocumentationAfterRun(workspaceRoot, {
        nodeId,
        runKind,
        status: nextStatus,
        changedFilesSummary,
        touchedFilesSummary,
        outputTail,
        finishedAt
      })
      : null;
    let runDigestSummary = '';
    let runDigestPath = '';
    if (workspaceRoot) {
      try {
        const runDigest = buildRunDigest({
          workspaceRoot,
          nodeId,
          runKind: String(runKind || (isSoloConversation ? 'solo' : 'step')),
          agentCli: String(agentCli || commandPreview || command || 'Unknown CLI'),
          executionLogId: Number(executionLogId || 0),
          userMessage: String(userMessage || ''),
          resolvedCommand,
          status: nextStatus,
          startedAt: String(startedAt || ''),
          finishedAt,
          durationMs: runDurationMs,
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          completionReason,
          failureCode,
          failureReason
        });
        runDigestPath = writeRunDigest(workspaceRoot, runDigest);
        clearProjectInvestmentCache(workspaceRoot);
        runDigestSummary = `Execution digest saved: ${toProjectRelativeRuntimePath(workspaceRoot, runDigestPath)}`;
      } catch (error) {
        runDigestSummary = `Execution digest not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let runIndexSummary = '';
    if (workspaceRoot && executionLogId) {
      try {
        const toRuntimePath = (candidate: string | undefined) => candidate && fs.existsSync(candidate)
          ? toProjectRelativeRuntimePath(workspaceRoot, candidate)
          : '';
        const outputBytes = outputFilePath && fs.existsSync(outputFilePath)
          ? fs.statSync(outputFilePath).size
          : 0;
        const changedFiles = parseFileSummaryLines(changedFilesSummary).map((filePath) => ({
          filePath,
          role: 'changed'
        }));
        const touchedFiles = parseFileSummaryLines(touchedFilesSummary).map((filePath) => ({
          filePath,
          role: 'touched'
        }));
        const verificationSignals = extractVerificationSignals(outputTail, resolvedCommand, nextStatus)
          .map((value) => ({ type: 'verification', value }));
        const failureSignals = extractFailureSignals(outputTail, failureCode, failureReason, nextStatus)
          .map((value) => ({ type: 'failure', value }));
        syncEngine.upsertRunIndex({
          executionLogId: Number(executionLogId),
          nodeId,
          runKind: String(runKind || (isSoloConversation ? 'solo' : 'step')),
          agentCli: String(agentCli || commandPreview || command || 'Unknown CLI'),
          status: nextStatus,
          startedAt: String(startedAt || ''),
          finishedAt,
          durationMs: runDurationMs,
          outputPath: toRuntimePath(outputFilePath),
          outputBytes,
          outputTail: compactLine(outputTail, 4000),
          commandPath: toRuntimePath(commandFilePath),
          promptPath: toRuntimePath(String(promptFilePath || '')),
          changesPath: toRuntimePath(changesFilePath),
          touchedFilesPath: toRuntimePath(touchedFilesPath),
          updatedAt: finishedAt
        }, [...changedFiles, ...touchedFiles], [...verificationSignals, ...failureSignals]);
        clearProjectInvestmentCache(workspaceRoot);
        runIndexSummary = 'Run index saved to project_journal.db.';
      } catch (error) {
        runIndexSummary = `Run index not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let projectGrowthSummary = '';
    if (workspaceRoot && !isReviewRun && extensionContextRef) {
      try {
        const growthView = await refreshProjectGrowthSnapshot(workspaceRoot, extensionContextRef.extensionPath, {
          scanReason: isContinuationRun ? 'agent_continuation' : isSoloConversation ? 'solo' : String(runKind || 'agent_run'),
          maxFiles: 5000
        });
        projectGrowthSummary = `Project growth snapshot saved: ${growthView.totals.files} files, ${growthView.totals.modules} modules, ${growthView.gaps.length} gaps.`;
      } catch (error) {
        projectGrowthSummary = `Project growth snapshot not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (workspaceRoot && !isContinuationRun) {
      const verificationSignals = extractVerificationSignals(outputTail, resolvedCommand, nextStatus);
      const failureSignals = extractFailureSignals(outputTail, failureCode, failureReason, nextStatus);
      const sourceType = isReviewRun
        ? 'review'
        : isSoloConversation
          ? 'solo'
          : runKind === 'roadmap_revision'
            ? 'roadmap_revision'
            : 'step_run';
      const eventType = nextStatus === 'Completed'
        ? (verificationSignals.length > 0 ? 'verified' : 'completed')
        : nextStatus === 'Failed'
          ? 'failed'
          : nextStatus === 'In Progress'
            ? 'partial'
            : 'blocked';
      try {
        appendLearningEvent(workspaceRoot, String(globalDataPath || ''), {
          sourceType,
          sourceRef: `${nodeId}:${executionLogId || 0}`,
          eventType,
          summary: completionReason || failureReason || `${sourceType} finished with ${nextStatus}`,
          evidenceRefs: ([
            runDigestPath ? { type: 'run_digest' as const, ref: toProjectRelativeRuntimePath(workspaceRoot, runDigestPath), summary: 'Execution digest' } : null,
            outputFilePath ? { type: 'file' as const, ref: toProjectRelativeRuntimePath(workspaceRoot, String(outputFilePath)), summary: 'Agent output' } : null,
            changesFilePath ? { type: 'file' as const, ref: toProjectRelativeRuntimePath(workspaceRoot, String(changesFilePath)), summary: 'Workspace changes' } : null,
            ...verificationSignals.slice(0, 3).map((signal) => ({ type: 'command' as const, ref: signal, summary: 'Verification signal' }))
          ].filter(Boolean) as LearningEvidenceRef[]),
          tags: [
            String(runKind || ''),
            String(nodeId || ''),
            currentNode?.stage || '',
            currentNode?.title || '',
            nextStatus
          ],
          metadata: {
            nodeId,
            runKind,
            status: nextStatus,
            verification: verificationSignals,
            failures: failureSignals,
            changedFiles: parseFileSummaryLines(changedFilesSummary),
            touchedFiles: parseFileSummaryLines(touchedFilesSummary)
          }
        });
      } catch (error) {
        console.warn('Failed to append learning event:', error);
      }
    }
    let preGitHash = '';
    let existingConversationOutput = '';
    if (syncEngine && executionLogId) {
      const existingLogs = (isSoloConversation && typeof syncEngine.getProjectAgentExecutions === 'function')
        ? syncEngine.getProjectAgentExecutions()
        : (typeof syncEngine.getAgentExecutions === 'function' ? syncEngine.getAgentExecutions(nodeId) : []);
      const matched = existingLogs.find(log => Number(log.id) === Number(executionLogId));
      if (matched && matched.output) {
        existingConversationOutput = String(matched.output || '');
        const hashMatch = matched.output.match(/SoloMapPreGitHash:\s*([a-f0-9]+)/i);
        if (hashMatch) {
          preGitHash = hashMatch[1];
        }
      }
    }
    const continuationParentId = extractContinuationParentConversationId(existingConversationOutput);
    const continuationSessionId = String(nativeSessionId || '').trim();
    const continuationMetadataSummary = continuationParentId
      ? (continuationSessionId
          ? buildContinuationMetadataBlock(continuationParentId, continuationSessionId)
          : `Continuation parent conversation: ${continuationParentId}`)
      : '';
    let codexContinuationFirstMessage = '';
    if ((runKind === 'solo_continue' || runKind === 'step_continue') && getAgentProvider(String(agentCli || commandPreview || command || '')) === 'codex' && continuationSessionId) {
      const recordedCodexHome = codexHomeFilePath && fs.existsSync(String(codexHomeFilePath))
        ? fs.readFileSync(String(codexHomeFilePath), 'utf8').trim()
        : '';
      const codexHome = recordedCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      codexContinuationFirstMessage = extractFirstCodexUserMessageAfter(codexHome, continuationSessionId, String(startedAt || ''));
    }
    const executionSummary = [
      preGitHash ? `SoloMapPreGitHash: ${preGitHash}` : '',
      continuationMetadataSummary,
      codexContinuationFirstMessage ? `Continuation first message:\n${codexContinuationFirstMessage}` : '',
      userMessage ? `User supplement:\n${userMessage}` : '',
      sessionMode ? `Native session mode: ${sessionMode}` : '',
      nativeSessionSummary,
      `Sentinel captured state: ${status}`,
      isContinuationRun
        ? `Continuation record state: ${nextStatus}`
        : isSoloConversation ? `Solo conversation state: ${nextStatus}` : `Roadmap step state: ${nextStatus}`,
      startedAt ? `Run started at: ${startedAt}` : '',
      `Run finished at: ${finishedAt}`,
      startedAt ? `Run duration ms: ${runDurationMs}` : '',
      failureCode ? `Failure category: ${failureCode}` : '',
      failureReason ? `Failure reason:\n${failureReason}` : '',
      completionReason ? `Completion decision: ${completionReason}` : '',
      reviewResult ? formatAgentReviewResult(reviewResult) : '',
      isReviewRun && reviewOfExecutionLogId ? `Review of execution: ${reviewOfExecutionLogId}` : '',
      stepHandoffSummary ? `Step handoff summary updated: ${getStepMemoryFilePath(workspaceRoot, nodeId)}` : '',
      documentationAudit ? `Documentation harness: ${documentationAudit.summary}` : '',
      runDigestSummary,
      runIndexSummary,
      projectGrowthSummary,
      documentationAudit && documentationAudit.pendingReview.length > 0
        ? `Documentation review needed:\n${documentationAudit.pendingReview.map((item) => `- ${item.path}: ${item.reason}`).join('\n')}`
        : '',
      `Workspace changes:`,
      changedFilesSummary,
      `Touched project files:`,
      touchedFilesSummary,
      outputTail ? `Agent output tail:\n${outputTail}` : 'Agent output tail: No captured output.'
    ].filter(Boolean).join('\n\n');
    const updatedExistingConversation = executionLogId
      ? syncEngine.updateAgentExecution(
        Number(executionLogId),
        agentCli || commandPreview || command || 'Unknown CLI',
        resolvedCommand,
        executionSummary,
        nextStatus
      )
      : false;
    if (!updatedExistingConversation) {
      syncEngine.logAgentExecution(
        nodeId,
        agentCli || commandPreview || command || 'Unknown CLI',
        resolvedCommand,
        executionSummary,
        nextStatus
      );
    }

    if (shouldStartReview && !isContinuationRun && !hasAgentReviewForExecution(nodeId, Number(executionLogId || 0))) {
      const requestedReviewerCli = String(reviewerCliPath || agentCli || '').trim();
      const reviewerCli = resolveAgentCli(requestedReviewerCli || String(agentCli || 'agy'), requestedReviewerCli ? '' : String(agentCli || 'agy'));
      if (commandExists(reviewerCli)) {
        startAgentReviewRun({
          workspaceRoot,
          nodeId,
          runKind: String(runKind || 'step'),
          reviewerCli,
          mainAgentCli: String(agentCli || commandPreview || command || 'Unknown CLI'),
          mainExecutionLogId: Number(executionLogId || 0),
          mainResolvedCommand: resolvedCommand,
          userMessage: String(userMessage || ''),
          mainStatus: reviewDeferredCompletion ? 'Completed' : nextStatus,
          completionReason,
          changedFilesSummary,
          touchedFilesSummary,
          outputTail,
          targetStatus: reviewDeferredCompletion ? 'Completed' : nextStatus,
          globalDataPath: String(globalDataPath || ''),
          taskPermissionMode: 'auto'
        });
      } else {
        syncEngine.logAgentExecution(
          nodeId,
          requestedReviewerCli || reviewerCli,
          requestedReviewerCli || reviewerCli,
          [
            'Agent review could not start.',
            `Review of execution: ${executionLogId || 0}`,
            'Failure category: reviewer_cli_not_found',
            `Failure reason:\nReview Agent CLI not found. Tried: ${getAgentCliCandidates(requestedReviewerCli || String(agentCli || 'agy'), requestedReviewerCli ? '' : String(agentCli || 'agy')).join(', ')}.`
          ].join('\n\n'),
          'Failed'
        );
        postNodeConversations(nodeId);
      }
    }

    if (workspaceRoot && shouldRefreshRoadmap) {
      await syncEngine.initAndSync();
      if (preserveCompletedNode && nodeId !== roadmapRevisionId && syncEngine.getNodes().some((node) => node.id === nodeId)) {
        syncEngine.updateNode(nodeId, {
          status: 'Completed',
          completedAt: currentNode?.completedAt || new Date().toISOString()
        });
      }
    }

    sendNodesToWebview();
    refreshSidebarProjectCards();
    postNodeConversations(nodeId);
    if (extensionContextRef) {
      scheduleAutomationTasksAfterRun(extensionContextRef, {
        workspaceRoot,
        nodeId,
        runKind: String(runKind || (isSoloConversation ? 'solo' : 'step')),
        nextStatus,
        failureCode,
        executionLogId: Number(executionLogId || 0),
        agentCli: String(agentCli || commandPreview || command || ''),
        userMessage: String(userMessage || ''),
        isReviewRun,
        isContinuationRun
      });
    }
    if (isContinuationRun) {
      vscode.window.showInformationMessage('Continuation conversation was recorded.');
    } else if (!isSoloConversation && nextStatus === 'Completed' && !hasRecordedWorkspaceChanges(changedFilesSummary, touchedFilesSummary)) {
      vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
    } else if (isSoloConversation) {
      vscode.window.showInformationMessage(`Solo conversation finished with state: ${nextStatus}`);
    } else {
      vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${nextStatus}`);
    }

    agentTerminalNamesByConversationId.delete(Number(executionLogId || 0));
    setTimeout(() => {
      const currentStatus = readAgentStatus(statusFilePath);
      const belongsToProcessedRun = currentStatus
        && Number(currentStatus.executionLogId || 0) === Number(executionLogId || 0)
        && String(currentStatus.status || '') === String(status || '');
      if (belongsToProcessedRun && fs.existsSync(statusFilePath)) {
        fs.writeFileSync(statusFilePath, JSON.stringify({
          ...currentStatus,
          status: 'Processed',
          processedAt: new Date().toISOString()
        }), 'utf8');
      }
    }, 1000);
  } catch (e) {
    // JSON might be partially written; watcher or poller will retry.
  }
}

/**
 * Sets up watcher plus polling fallback for agent status changes.
 */
function setupFileSentinelWatcher(workspaceRoot: string) {
  if (watcher) {
    watcher.dispose();
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, `{.agent_status.json,.solopreneur/${agentStatusDirName}/*.json}`)
  );

  const handleSentinelChange = () => {
    for (const statusFilePath of getAgentStatusFilePaths(workspaceRoot)) {
      void processAgentStatusFile(statusFilePath);
    }
  };
  watcher.onDidChange(handleSentinelChange);
  watcher.onDidCreate(handleSentinelChange);
  statusPoller = setInterval(handleSentinelChange, 2000);
  handleSentinelChange();
}

/**
 * Formulates the premium glassmorphic Webview page bundle.
 */
export function deactivate() {
  if (watcher) {
    watcher.dispose();
  }
  if (statusPoller) {
    clearInterval(statusPoller);
  }
}
