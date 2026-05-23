import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as childProcess from 'child_process';
import { SyncEngine } from './db/syncEngine';
import { RoadmapNode } from './db/types';
import { SolopreneurSidebarProvider } from './sidebarProvider';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;
let statusPoller: NodeJS.Timeout | null = null;
let sidebarProvider: SolopreneurSidebarProvider | null = null;
let activeProjectRoot: string | null = null;

interface SolopreneurSettings {
  apiProvider: string;
  apiKey: string;
  cliPath: string;
  language: string;
}

interface SolopreneurProject {
  name: string;
  path: string;
}

interface AgentStepSession {
  agentCli: string;
  provider: string;
  sessionId: string;
  updatedAt: string;
}

interface StepSessionState {
  version: number;
  nodeId: string;
  sessions: Record<string, AgentStepSession>;
}

const settingsKey = 'solopreneur.settings';
const projectsKey = 'solopreneur.projects';
const selectedProjectKey = 'solopreneur.selectedProjectPath';

export async function activate(context: vscode.ExtensionContext) {
  console.log('Solopreneur Roadmaps extension is now active!');

  // Register command to show roadmap webview
  const showRoadmapDisposable = vscode.commands.registerCommand(
    'solopreneur.showRoadmap',
    async () => {
      await openRoadmapPanel(context);
    }
  );
  context.subscriptions.push(showRoadmapDisposable);

  // Register settings saved broadcast command to keep Sidebar and Webview synced
  const settingsSavedDisposable = vscode.commands.registerCommand(
    'solopreneur.settingsSavedBroadcast',
    () => {
      if (sidebarProvider) {
        sidebarProvider.sendSettings();
        sidebarProvider.sendProjects();
      }
      if (activePanel) {
        activePanel.webview.postMessage({
          command: 'settingsLoaded',
          settings: getPersistedSettings(context)
        });
        activePanel.webview.postMessage({
          command: 'projectsLoaded',
          projects: getProjectState(context)
        });
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
    async (nodeId) => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleRunAgent(context, nodeId, '');
      }
    },
    async (prompt) => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleGenerateRoadmap(context, prompt);
      }
    },
    () => getPersistedSettings(context),
    async (settings) => {
      await updatePersistedSettings(context, settings);
    },
    () => getProjectState(context),
    async (projectPath) => {
      await selectProject(context, projectPath);
    },
    async () => {
      await addProjectFromDialog(context);
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
}

function getPersistedSettings(context: vscode.ExtensionContext): SolopreneurSettings {
  const config = vscode.workspace.getConfiguration('solopreneur');
  const saved = context.globalState.get<Partial<SolopreneurSettings>>(settingsKey) || {};
  return {
    apiProvider: saved.apiProvider || config.get('apiProvider') || 'Gemini',
    apiKey: saved.apiKey || config.get('apiKey') || '',
    cliPath: saved.cliPath || config.get('cliPath') || 'agy',
    language: saved.language || config.get('language') || 'zh'
  };
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: SolopreneurSettings): Promise<void> {
  const nextSettings: SolopreneurSettings = {
    apiProvider: settings.apiProvider || 'Gemini',
    apiKey: settings.apiKey || '',
    cliPath: settings.cliPath || 'agy',
    language: settings.language === 'en' ? 'en' : 'zh'
  };
  await context.globalState.update(settingsKey, nextSettings);

  const config = vscode.workspace.getConfiguration('solopreneur');
  await config.update('apiProvider', nextSettings.apiProvider, vscode.ConfigurationTarget.Global);
  await config.update('apiKey', nextSettings.apiKey, vscode.ConfigurationTarget.Global);
  await config.update('cliPath', nextSettings.cliPath, vscode.ConfigurationTarget.Global);
  await config.update('language', nextSettings.language, vscode.ConfigurationTarget.Global);
}

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function getProjects(context: vscode.ExtensionContext): SolopreneurProject[] {
  const savedProjects = context.globalState.get<SolopreneurProject[]>(projectsKey) || [];
  const workspaceRoot = getWorkspaceRoot();
  const projects = [...savedProjects];

  if (workspaceRoot && !projects.some((project) => project.path === workspaceRoot)) {
    projects.unshift({
      name: projectName(workspaceRoot),
      path: workspaceRoot
    });
  }

  return projects.filter((project, index, all) =>
    project.path && all.findIndex((candidate) => candidate.path === project.path) === index
  );
}

function getSelectedProjectPath(context: vscode.ExtensionContext): string {
  const projects = getProjects(context);
  const savedSelected = context.globalState.get<string>(selectedProjectKey) || '';
  if (savedSelected && projects.some((project) => project.path === savedSelected)) {
    return savedSelected;
  }
  return projects[0]?.path || '';
}

function getProjectState(context: vscode.ExtensionContext): { projects: SolopreneurProject[]; selectedProjectPath: string } {
  const projects = getProjects(context);
  return {
    projects,
    selectedProjectPath: getSelectedProjectPath(context)
  };
}

async function saveProjects(context: vscode.ExtensionContext, projects: SolopreneurProject[]): Promise<void> {
  await context.globalState.update(projectsKey, projects);
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
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
  if (statusPoller) {
    clearInterval(statusPoller);
    statusPoller = null;
  }
  await ensureSyncEngine(context);
  sendProjectsToWebviews(context);
  sendNodesToWebview();
}

function buildSolopreneurDirectoryReadme(): string {
  return [
    '# Solopreneur Project Data',
    '',
    '这个目录由 Solopreneur Roadmap 插件自动创建，用来保存当前项目的路线图、Agent 对话记录、执行日志和环节交接总结。',
    '',
    '## 为什么数据放在项目里',
    '',
    '- 项目数据跟随项目文件夹走，不依赖插件后端服务。',
    '- 换一台机器、换一个 IDE、重新安装插件后，只要项目文件还在，Solopreneur 就能重新加载这些数据。',
    '- 这个目录可以交给 Git/GitHub 管理，让路线图、交接总结和执行记录成为项目历史的一部分。',
    '',
    '## 主要文件',
    '',
    '- `roadmap.csv`：路线图主数据，包括环节、依赖、状态和 Agent prompt。',
    '- `step-memory/`：每个路线图环节的 JSON 交接总结。没有可续接的 Agent 原生会话时，下一轮 Agent 对话会读取这里的结构化上下文。',
    '- `step-sessions/`：每个路线图环节按 Agent 保存原生会话 ID。后续对话会优先续接同一个 Agent 会话。',
    '- `project_journal.db`：本地 SQLite 执行日志，保存更完整的 Agent 对话和历史记录。',
    '- `agent-runs/`：每次 Agent 调用的输出、文件变更摘要和完成判断。',
    '- `.agent_status.json`：临时运行状态文件，通常会被插件自动清理。',
    '',
    '## 请不要随意删除',
    '',
    '删除这个目录会导致 Solopreneur 无法恢复该项目的路线图、状态、对话历史和环节交接总结。需要清理体积时，优先只清理 `agent-runs/` 中很旧的运行记录，并保留 `roadmap.csv` 和 `step-memory/`。',
    '',
    '## Git 建议',
    '',
    '如果你希望项目在多台机器或多个 IDE 间保持一致，可以把 `.solopreneur/` 提交到 Git。这样 Solopreneur 的项目上下文会跟项目代码一起迁移。'
  ].join('\n');
}

function ensureSolopreneurReadme(solopreneurDir: string): void {
  const readmePath = path.join(solopreneurDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, buildSolopreneurDirectoryReadme(), 'utf8');
  }
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
    projects.push({
      name: projectName(folder),
      path: folder
    });
    await saveProjects(context, projects);
  }

  await context.globalState.update(selectedProjectKey, folder);
  syncEngine = null;
  activeProjectRoot = null;
  await ensureSyncEngine(context);
  const projectIdea = await vscode.window.showInputBox({
    title: '告诉 Solopreneur 这个项目的想法',
    prompt: '用于生成定制路线图。留空则使用默认路线图。',
    placeHolder: '例如：给独立咨询顾问使用的轻量 CRM，先做本地优先的 MVP...'
  });
  if (projectIdea && projectIdea.trim()) {
    await handleGenerateRoadmap(context, projectIdea.trim());
  }
  sendProjectsToWebviews(context);
  sendNodesToWebview();
}

function sendProjectsToWebviews(context: vscode.ExtensionContext): void {
  const projects = getProjectState(context);
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'projectsLoaded',
      projects
    });
  }
  if (sidebarProvider) {
    sidebarProvider.sendProjects();
  }
}

/**
 * Ensures the sync engine is initialized if a workspace is open.
 */
async function ensureSyncEngine(context: vscode.ExtensionContext): Promise<boolean> {
  const projectRoot = getSelectedProjectPath(context);
  if (syncEngine && activeProjectRoot === projectRoot) {
    return true;
  }

  if (!projectRoot) {
    return false;
  }
  const solopreneurDir = path.join(projectRoot, '.solopreneur');

  if (!fs.existsSync(solopreneurDir)) {
    fs.mkdirSync(solopreneurDir, { recursive: true });
  }
  ensureSolopreneurReadme(solopreneurDir);

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
  try {
    await syncEngine.initAndSync();
    activeProjectRoot = projectRoot;
    setupFileSentinelWatcher(projectRoot);
    // Refresh sidebar when successfully initialized
    if (sidebarProvider) {
      sidebarProvider.sendNodesToWebview();
      sidebarProvider.sendProjects();
    }
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to initialize Roadmap database: ${error}`);
    return false;
  }
}

async function openRoadmapPanel(context: vscode.ExtensionContext) {
  const initialized = await ensureSyncEngine(context);
  if (!initialized) {
    vscode.window.showErrorMessage('Choose a project folder before launching the Roadmap.');
    return;
  }

  const projectRoot = getSelectedProjectPath(context);

  // If panel already exists, reveal it
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.One);
    return;
  }

  // Create Webview Panel
  activePanel = vscode.window.createWebviewPanel(
    'solopreneurRoadmap',
    'Solopreneur AI Roadmap',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    }
  );

  // Load basic HTML into Webview
  activePanel.webview.html = getWebviewHtml(activePanel.webview, context);

  // Handle messages from Webview
  activePanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'getNodes':
          sendNodesToWebview();
          break;

        case 'updateNode':
          if (syncEngine) {
            syncEngine.updateNode(message.nodeId, message.updates);
            sendNodesToWebview();
          }
          break;

        case 'completeNode':
          if (syncEngine) {
            syncEngine.updateNode(message.nodeId, {
              status: 'Completed',
              completedAt: new Date().toISOString()
            });
            sendNodesToWebview();
          }
          break;

        case 'runAgent':
          await handleRunAgent(context, message.nodeId, message.userMessage || '', message.agentCli || '');
          break;

        case 'retryConversation':
          await handleRetryConversation(context, message.nodeId, Number(message.conversationId || 0));
          break;

        case 'openProjectFile':
          if (activeProjectRoot && message.relativePath) {
            const candidatePath = path.resolve(activeProjectRoot, String(message.relativePath));
            const relativeToRoot = path.relative(activeProjectRoot, candidatePath);
            if (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot) && fs.existsSync(candidatePath)) {
              const doc = await vscode.workspace.openTextDocument(candidatePath);
              await vscode.window.showTextDocument(doc, { preview: false });
            }
          }
          break;

        case 'generateRoadmap':
          await handleGenerateRoadmap(context, message.prompt);
          break;

        case 'getSettings':
          if (activePanel) {
            activePanel.webview.postMessage({
              command: 'settingsLoaded',
              settings: getPersistedSettings(context)
            });
          }
          break;

        case 'updateSettings':
          await updatePersistedSettings(context, {
            apiProvider: message.apiProvider,
            apiKey: message.apiKey,
            cliPath: message.cliPath,
            language: message.language
          });
          vscode.window.showInformationMessage('Solopreneur settings saved successfully!');
          // Broadcast to sync both Webviews
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;

        case 'getNodeConversations':
          if (syncEngine && activePanel) {
            activePanel.webview.postMessage({
              command: 'nodeConversationsLoaded',
              nodeId: message.nodeId,
              conversations: syncEngine.getAgentExecutions(message.nodeId),
              projectPath: activeProjectRoot || ''
            });
          }
          break;

        case 'getProjects':
          activePanel?.webview.postMessage({
            command: 'projectsLoaded',
            projects: getProjectState(context)
          });
          break;

        case 'selectProject':
          await selectProject(context, message.projectPath);
          break;

        case 'addProject':
          await addProjectFromDialog(context);
          break;

        case 'testCli':
          const cliToTest = resolveAgentCli('antigravity-cli', message.cliPath || '');
          childProcess.execFile(cliToTest, getCliVersionArgs(cliToTest), (error: any, stdout: string, stderr: string) => {
            const success = !error;
            let msg = error ? error.message : formatCliTestMessage(cliToTest, stdout, stderr);
            if (!success) {
              const candidates = getAgentCliCandidates('antigravity-cli', message.cliPath || '').join(', ');
              msg = `Command not found or failed. Tried: ${candidates}`;
            }
            if (activePanel) {
              activePanel.webview.postMessage({
                command: 'cliTestResult',
                success,
                message: msg
              });
            }
          });
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  // Set up File Sentinel Watcher for agent completion (.agent_status.json)
  setupFileSentinelWatcher(projectRoot);

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

/**
 * Sends current node and edge states back to the Webview frontend.
 */
function sendNodesToWebview() {
  if (syncEngine) {
    const nodes = syncEngine.getNodes();
    if (activePanel) {
      activePanel.webview.postMessage({
        command: 'nodesUpdated',
        nodes: nodes,
        projectPath: activeProjectRoot || '',
      });
    }
    if (sidebarProvider) {
      sidebarProvider.sendNodesToWebview();
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandExists(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
    return fs.existsSync(trimmed);
  }

  const result = childProcess.spawnSync('bash', ['-lc', `command -v ${shellQuote(trimmed)}`], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function getAgentCliCandidates(agentCli: string, configuredCliPath: string): string[] {
  const requestedCli = (agentCli || '').trim();
  const configuredCli = (configuredCliPath || '').trim();
  const requestedName = path.basename(requestedCli).toLowerCase();
  const configuredName = path.basename(configuredCli).toLowerCase();
  const antigravityNames = new Set(['', 'agy', 'antigravity', 'antigravity-cli']);
  const codexNames = new Set(['codex', 'codex-cli']);
  const wantsCodex = codexNames.has(requestedName) || codexNames.has(configuredName);
  const wantsAntigravity = antigravityNames.has(requestedName) || antigravityNames.has(configuredName);
  const candidates = wantsCodex && !wantsAntigravity
    ? [configuredCli, requestedCli, 'codex', 'codex-cli', 'agy', 'antigravity', 'antigravity-cli']
    : [configuredCli, requestedCli, 'agy', 'antigravity', 'antigravity-cli', 'codex', 'codex-cli'];

  return candidates.filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function resolveAgentCli(agentCli: string, configuredCliPath: string): string {
  const candidates = getAgentCliCandidates(agentCli, configuredCliPath);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || 'agy';
}

function getAgentProvider(agentCli: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return 'codex';
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return 'antigravity';
  }
  return executableName || 'unknown';
}

function getAgentSessionKey(agentCli: string): string {
  return getAgentProvider(agentCli);
}

function getStepSessionFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-sessions', `${nodeId}.json`);
}

function readStepSessionState(filePath: string, nodeId: string): StepSessionState {
  const emptyState: StepSessionState = {
    version: 1,
    nodeId,
    sessions: {}
  };
  if (!filePath || !fs.existsSync(filePath)) {
    return emptyState;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    return {
      version: 1,
      nodeId: String(parsed.nodeId || nodeId),
      sessions
    };
  } catch {
    return emptyState;
  }
}

function getStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): AgentStepSession | null {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const session = state.sessions[getAgentSessionKey(agentCli)];
  return session && session.sessionId ? session : null;
}

function updateStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string, sessionId: string): StepSessionState {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  state.version = 1;
  state.nodeId = nodeId;
  state.sessions[sessionKey] = {
    agentCli,
    provider: getAgentProvider(agentCli),
    sessionId,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function clearStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): boolean {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  if (!state.sessions[sessionKey]) {
    return false;
  }
  delete state.sessions[sessionKey];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return true;
}

function buildAgentCommand(agentCli: string, agentPrompt: string, workspaceRoot: string, nativeSessionId = ''): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPrompt = shellQuote(agentPrompt);
  void nativeSessionId;

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} exec -C ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --print-timeout=30m --add-dir=${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }

  return `${quotedCli} run --task ${quotedPrompt}`;
}

function getCliVersionArgs(agentCli: string): string[] {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return ['--version'];
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return ['--version'];
  }
  return ['--version'];
}

function formatCliTestMessage(agentCli: string, stdout: string, stderr: string): string {
  const version = (stdout.trim() || stderr.trim() || 'available').split('\n')[0];
  return `${agentCli} · ${version}`;
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
      sessionWriter
    ].join('; ');
  }

  if (provider === 'codex') {
    return [
      `session_id=""`,
      `session_source=""`,
      `session_id=$(grep -Eo '"id"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"|session[_ -]?id[^0-9a-fA-F]*[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | grep -Eo '[0-9a-fA-F-]{36}' | tail -1 || true)`,
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
    `session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true)`,
    `session_source="generic-output"`,
    sessionWriter
  ].join('; ');
}

function buildWorkspaceSnapshotScript(workspaceRoot: string, snapshotFilePath: string): string {
  return `node -e ${shellQuote([
    'const fs=require("fs");',
    'const path=require("path");',
    'const root=process.argv[1];',
    'const out=process.argv[2];',
    'const skip=new Set([".git",".solopreneur","node_modules"]);',
    'const snapshot={};',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'if(skip.has(entry.name)) continue;',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
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
    'const skip=new Set([".git",".solopreneur","node_modules"]);',
    'let before={};',
    'try{ before=JSON.parse(fs.readFileSync(beforeFile,"utf8"))||{}; } catch {}',
    'const after={};',
    'function walk(dir){',
    'for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    'if(skip.has(entry.name)) continue;',
    'const full=path.join(dir,entry.name);',
    'const rel=path.relative(root,full).replace(/\\\\/g,"/");',
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

function getStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.json`);
}

function getLegacyStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.md`);
}

function readStepHandoffSummary(filePath: string): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const sourceFilePath = filePath && fs.existsSync(filePath)
    ? filePath
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? legacyFilePath
      : '';
  if (!sourceFilePath) {
    return '暂无交接总结。';
  }

  const content = fs.readFileSync(sourceFilePath, 'utf8').trim();
  return buildStepHandoffSummary(parseStepHandoffEntries(content)) || '暂无交接总结。';
}

function compactLine(value: string, maxLength: number): string {
  const compacted = (value || '').replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted;
}

function buildRunHandoffEntry(
  status: string,
  changedFilesSummary: string,
  outputTail: string,
  completionReason: string
): Record<string, unknown> {
  const changedFiles = changedFilesSummary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .filter((line) => !/^No (workspace|git|project) /i.test(line));

  const usefulSignals = outputTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^\s*(npm|node|git|>|\[|\{)/i.test(line) &&
      !line.includes('Refreshing run status')
    )
    .slice(-12)
    .join('\n');

  return {
    timestamp: new Date().toISOString(),
    status,
    changedFiles: changedFiles.length > 0 ? changedFiles : [],
    usefulSignals: usefulSignals ? compactLine(usefulSignals, 1200) : compactLine(outputTail, 1200) || '',
    completionReason: completionReason || (status === 'Completed' ? '该环节已完成。' : '该环节仍需后续推进。')
  };
}

function normalizeStepHandoffEntry(entry: any): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const changedFiles = Array.isArray(entry.changedFiles)
    ? entry.changedFiles.map((line: unknown) => String(line || '').trim()).filter(Boolean).slice(0, 12)
    : String(entry.changedFiles || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
  return {
    timestamp: String(entry.timestamp || new Date().toISOString()),
    status: String(entry.status || 'In Progress'),
    changedFiles,
    usefulSignals: compactLine(String(entry.usefulSignals || ''), 1200),
    completionReason: compactLine(String(entry.completionReason || ''), 600)
  };
}

function parseLegacyMarkdownHandoffEntry(entry: string): Record<string, unknown> | null {
  const cleaned = entry.replace(/\n# 环节交接总结[\s\S]*$/g, '').trim();
  const header = cleaned.match(/^##\s+([^\n]+?)\s+·\s+([^\n]+)\n/);
  if (!header) {
    return null;
  }
  const section = (title: string) => {
    const match = cleaned.match(new RegExp(`### ${title}\\n([\\s\\S]*?)(?=\\n\\n### |$)`));
    return match ? match[1].trim() : '';
  };
  const changedFiles = section('本轮文件变化')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^No (workspace|git|project) /i.test(line))
    .slice(0, 12);
  return {
    timestamp: header[1].trim(),
    status: header[2].trim(),
    changedFiles,
    usefulSignals: compactLine(section('本轮关键信号'), 1200),
    completionReason: compactLine(section('完成判断'), 600)
  };
}

function handoffEntryDedupeKey(entry: Record<string, unknown>): string {
  return JSON.stringify({
    status: entry.status || '',
    changedFiles: entry.changedFiles || [],
    usefulSignals: entry.usefulSignals || '',
    completionReason: entry.completionReason || ''
  });
}

function parseStepHandoffEntries(content: string): Record<string, unknown>[] {
  const body = (content || '').trim();
  if (!body || body === '暂无交接总结。') {
    return [];
  }

  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      const rawEntries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
      const seen = new Set<string>();
      const entries: Record<string, unknown>[] = [];
      for (const rawEntry of rawEntries) {
        const entry = normalizeStepHandoffEntry(rawEntry);
        if (!entry) continue;
        const key = handoffEntryDedupeKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
      }
      return entries.slice(0, 10);
    } catch {
      return [];
    }
  }

  const normalized = body
    .replace(/^# 环节交接总结[\s\S]*?(?=\n##\s+\d{4}-\d{2}-\d{2}T|\n##\s+\d{4}-\d{2}-\d{2}\s|$)/, '')
    .trim();
  if (!normalized) {
    return [];
  }

  const rawEntries = normalized
    .split(/\n\n---\n\n|(?=\n##\s+\d{4}-\d{2}-\d{2}(?:T|\s))/)
    .map((entry) => entry.trim())
    .filter((entry) => /^##\s+\d{4}-\d{2}-\d{2}(?:T|\s)/.test(entry));

  const seen = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  for (const entry of rawEntries) {
    const parsedEntry = parseLegacyMarkdownHandoffEntry(entry);
    if (!parsedEntry) continue;
    const key = handoffEntryDedupeKey(parsedEntry);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(parsedEntry);
    }
  }
  return entries;
}

function buildStepHandoffSummary(entries: Record<string, unknown>[]): string {
  const seen = new Set<string>();
  const validEntries = entries
    .map((entry) => normalizeStepHandoffEntry(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const key = handoffEntryDedupeKey(entry);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 10);
  if (validEntries.length === 0) {
    return '';
  }
  return JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Only real Agent run handoff entries are kept here. Newest first, max 10.',
    entries: validEntries
  }, null, 2);
}

function updateStepHandoffSummary(filePath: string, entry: Record<string, unknown>): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const existing = filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? fs.readFileSync(legacyFilePath, 'utf8')
      : '';
  const normalizedEntry = normalizeStepHandoffEntry(entry);
  const entries = normalizedEntry ? [normalizedEntry, ...parseStepHandoffEntries(existing)] : parseStepHandoffEntries(existing);
  const nextContent = buildStepHandoffSummary(entries).slice(0, 12000);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return nextContent;
}

function buildAgentConversationPrompt(
  node: RoadmapNode,
  userMessage: string,
  workspaceRoot: string,
  stepMemoryFilePath = '',
  agentRunsDir = '',
  completionDecisionFilePath = '',
  previousSessionId = ''
): string {
  const normalizedUserMessage = userMessage.trim();
  const supplement = userMessage.trim()
    ? `\n\n用户对本次对话的补充要求：\n${userMessage.trim()}`
    : '';
  const memoryFile = stepMemoryFilePath || getStepMemoryFilePath(workspaceRoot, node.id || '');
  const runsDir = agentRunsDir || path.join(workspaceRoot, '.solopreneur', 'agent-runs', node.id || '');
  const memoryInstructions = [
    '开始前必须先读取 Solopreneur 为本环节保存的项目上下文文件：',
    `- 环节交接 JSON：${memoryFile}`,
    `- 环节运行记录目录：${runsDir}`,
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

  return [
    '你正在 Solopreneur Roadmap 的一个路线图环节中工作。',
    '请把这次调用当成该环节的一次 agent 对话，而不是必须一次性完成整个环节。',
    '这是本次调用的唯一任务。不要执行与本环节无关的仓库记忆、历史会话或其他待办事项。',
    '',
    `项目目录：${workspaceRoot}`,
    `环节：${node.title}`,
    `阶段：${node.stage}`,
    `环节说明：${node.description}`,
    `当前环节状态：${node.status}`,
    '',
    userPriorityInstructions,
    '',
    '本次任务：',
    node.agentPrompt,
    supplement,
    ...(priorSessionInstructions ? ['', priorSessionInstructions] : []),
    memoryInstructions,
    '',
    '闭环要求：',
    '1. 直接在项目目录中完成本次能交付的文件改动或文档产出。除非用户明确要求，否则不要只输出计划或总结。',
    '2. 不要等待用户二次确认；如果任务过大，先交付一个可验证的小闭环，并在输出末尾说明下一次建议继续做什么。',
    '3. 运行你认为最窄且必要的验证命令；如果无法运行，说明原因。',
    '4. 完成后正常退出 CLI 进程。扩展会根据进程退出码记录本轮对话是否成功。',
    completionDecisionFilePath
      ? `5. 如果你判断整个路线图环节已经达到完成标准，请写入文件 ${completionDecisionFilePath}，内容必须是 JSON：{"markCompleted":true,"reason":"一句话说明为什么这个环节已完成"}。如果还需要后续对话，不要写这个文件。`
      : '5. 如果你判断整个路线图环节已经达到完成标准，请在最终输出中明确说明。'
  ].join('\n');
}

function buildAgentShellScript(
  agentCommand: string,
  workspaceRoot: string,
  nodeId: string,
  agentCli: string,
  executionLogId: number,
  userMessage: string,
  completionDecisionFilePath?: string,
  nativeSessionId = ''
): { finalCommand: string; outputFilePath: string; changesFilePath: string } {
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId);
  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const startedAtFilePath = path.join(runDir, 'started_at');
  const sessionFilePath = path.join(runDir, 'session.json');
  const decisionFilePath = completionDecisionFilePath || path.join(runDir, 'completion.json');
  const agentProvider = getAgentProvider(agentCli);
  const sessionKey = getAgentSessionKey(agentCli);
  const sessionMode = nativeSessionId.trim() ? 'fresh-with-reference' : 'fresh';
  const commandPreview = `${agentCli} [${sessionMode}]`;
  const runningStatus = JSON.stringify({ nodeId, status: 'Running', agentCli, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode });
  const completedStatus = JSON.stringify({ nodeId, status: 'In Progress', agentCli, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode });
  const failedStatus = JSON.stringify({ nodeId, status: 'Failed', agentCli, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode });
  const sessionCaptureScript = buildSessionCaptureScript(agentProvider, workspaceRoot, startedAtFilePath, outputFilePath, sessionFilePath);
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(workspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(workspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    `mkdir -p ${shellQuote(runDir)}`,
    `touch ${shellQuote(startedAtFilePath)}`,
    workspaceSnapshotScript,
    `printf %s ${shellQuote(agentCommand)} > ${shellQuote(commandFilePath)}`,
    `printf %s ${shellQuote(JSON.stringify({ markCompleted: false }))} > ${shellQuote(decisionFilePath)}`,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    `(${agentCommand}) 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `status=\${PIPESTATUS[0]}`,
    sessionCaptureScript,
    `git -C ${shellQuote(workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `if grep -qi 'timed out waiting for response\\|Error: timed out' ${shellQuote(outputFilePath)} 2>/dev/null; then status=124; fi`,
    `if [ ! -s ${shellQuote(changesFilePath)} ] && [ ! -s ${shellQuote(touchedFilesPath)} ] && ! grep -q '"markCompleted"[[:space:]]*:[[:space:]]*true' ${shellQuote(decisionFilePath)} 2>/dev/null; then status=125; printf '\\nSolopreneur: Agent exited without project file changes or a completion decision. Marking this run as failed so it can be retried.\\n' >> ${shellQuote(outputFilePath)}; fi`,
    `if [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].join('; ');

  return {
    finalCommand: `bash -lc ${shellQuote(script)}`,
    outputFilePath,
    changesFilePath
  };
}

function getOutputTail(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (content.length <= 4000) {
    return content;
  }

  return content.slice(-4000);
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
      title: '明确产品承诺',
      description: `把“${safePrompt}”整理成清晰的目标用户、核心承诺、成功指标和第一版边界。`,
      stage: '商业规划',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: `为“${safePrompt}”创建一份简洁的产品简报，写入 docs/product-brief.md，包含目标用户、核心承诺、MVP 边界、风险和验收标准。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '2',
      title: '制定实现计划',
      description: '把产品简报转成可执行的构建顺序、关键文件、里程碑和验证命令。',
      stage: '产品与 MVP',
      dependencies: '1',
      agentCli: cliPath,
      agentPrompt: `阅读 docs/product-brief.md，为“${safePrompt}”创建 docs/implementation-plan.md，包含里程碑、预期文件、验证命令和第一个最小可用切片。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '3',
      title: '构建第一个可用切片',
      description: '实现最小可用产品路径，并留下可运行、可验证的交付说明。',
      stage: '产品与 MVP',
      dependencies: '2',
      agentCli: cliPath,
      agentPrompt: '实现 docs/implementation-plan.md 中定义的第一个垂直切片。改动保持在当前工作区内，更新 README.md 的运行方式，并执行最窄的相关验证命令。',
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '4',
      title: '准备发布素材',
      description: '基于已经交付的切片，准备基础发布文案、检查清单和下一步增长动作。',
      stage: '营销与增长',
      dependencies: '3',
      agentCli: cliPath,
      agentPrompt: `基于当前文件，为“${safePrompt}”创建 docs/launch-checklist.md，包含定位文案、发布检查清单、已知缺口和下一个可衡量增长动作。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    }
  ];
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(context: vscode.ExtensionContext, nodeId: string, userMessage: string, selectedAgentCli = '') {
  if (!syncEngine) {
    return;
  }

  const nodes = syncEngine.getNodes();
  const node = nodes.find((n) => n.id === nodeId);

  if (!node) {
    vscode.window.showErrorMessage(`Node ${nodeId} not found`);
    return;
  }

  const unmetDependencies = (node.dependencies || '')
    .split(',')
    .map((dep) => dep.trim())
    .filter(Boolean)
    .filter((dep) => nodes.find((candidate) => candidate.id === dep)?.status !== 'Completed');

  if (unmetDependencies.length > 0) {
    vscode.window.showErrorMessage(`Complete prerequisite task(s) first: ${unmetDependencies.join(', ')}`);
    return;
  }

  const workspaceRoot = activeProjectRoot || '';
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Choose a project folder before running an Agent task.');
    return;
  }

  // Resolve CLI path from config if applicable
  const configuredCliPath = getPersistedSettings(context).cliPath;
  const requestedAgentCli = (selectedAgentCli || node.agentCli || configuredCliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath);

  if (!commandExists(agentCli)) {
    const candidates = getAgentCliCandidates(requestedAgentCli, selectedAgentCli ? '' : configuredCliPath).join(', ');
    vscode.window.showErrorMessage(`Agent CLI not found. Tried: ${candidates}. Set Solopreneur CLI Command or Path to an installed executable such as agy or codex.`);
    return;
  }

  // Update node status to Running
  syncEngine.updateNode(nodeId, { status: 'Running' });
  sendNodesToWebview();

  // Create or retrieve agent terminal
  let terminal = vscode.window.terminals.find((t) => t.name === 'Solopreneur Agent Console');
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: 'Solopreneur Agent Console',
      iconPath: new vscode.ThemeIcon('robot'),
      cwd: workspaceRoot,
    });
  }

  terminal.show(true);

  // Command execution with sentinel file generation on success or fail
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId);
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  const storedSession = getStoredAgentSession(workspaceRoot, nodeId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const stepMemoryFilePath = getStepMemoryFilePath(workspaceRoot, nodeId);
  const conversationPrompt = buildAgentConversationPrompt(
    node,
    userMessage,
    workspaceRoot,
    stepMemoryFilePath,
    runDir,
    completionDecisionFilePath,
    nativeSessionId
  );
  const agentCommand = buildAgentCommand(agentCli, conversationPrompt, workspaceRoot, nativeSessionId);

  const launchSummary = [
    'Agent conversation started.',
    nativeSessionId
      ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
      : `Starting a new native ${getAgentProvider(agentCli)} session.`,
    userMessage.trim() ? `User supplement:\n${userMessage.trim()}` : ''
  ].filter(Boolean).join('\n\n');
  const executionLogId = syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    agentCommand,
    launchSummary,
    'Running'
  );
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'nodeConversationsLoaded',
      nodeId,
      conversations: syncEngine.getAgentExecutions(nodeId),
      projectPath: activeProjectRoot || ''
    });
  }

  const { finalCommand } = buildAgentShellScript(agentCommand, workspaceRoot, nodeId, agentCli, executionLogId, userMessage.trim(), completionDecisionFilePath, nativeSessionId);

  terminal.sendText(finalCommand);
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
  await handleRunAgent(context, nodeId, retryUserMessage, conversation.agentCli || '');
}

function processAgentStatusFile(statusFilePath: string): void {
  if (!fs.existsSync(statusFilePath)) {
    return;
  }

  try {
    const fileContent = fs.readFileSync(statusFilePath, 'utf8').trim();
    if (!fileContent) {
      return;
    }

    const statusData = JSON.parse(fileContent);
    const { nodeId, status, agentCli, command, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath, sessionFilePath, sessionMode } = statusData;

    if (!nodeId || !status || status === 'Running' || !syncEngine) {
      return;
    }

    let nextStatus = status as RoadmapNode['status'];
    let completionReason = '';
    if (status === 'In Progress' && completionDecisionFilePath && fs.existsSync(completionDecisionFilePath)) {
      try {
        const completionDecision = JSON.parse(fs.readFileSync(completionDecisionFilePath, 'utf8'));
        if (completionDecision.markCompleted === true) {
          nextStatus = 'Completed';
          completionReason = completionDecision.reason || 'Agent marked this roadmap step complete.';
        }
      } catch (error) {
        completionReason = 'Agent completion decision file could not be parsed.';
      }
    }

    const completedAt = nextStatus === 'Completed' ? new Date().toISOString() : '';
    syncEngine.updateNode(nodeId, {
      status: nextStatus,
      completedAt,
    });

    const outputTail = getOutputTail(outputFilePath);
    const changedFilesSummary = getChangedFilesSummary(changesFilePath);
    const touchedFilesSummary = getTouchedFilesSummary(touchedFilesPath);
    const workspaceRoot = activeProjectRoot || (statusFilePath ? path.dirname(statusFilePath) : '');
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
    const handoffEntry = workspaceRoot
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
    const executionSummary = [
      userMessage ? `User supplement:\n${userMessage}` : '',
      sessionMode ? `Native session mode: ${sessionMode}` : '',
      nativeSessionSummary,
      `Sentinel captured state: ${status}`,
      `Roadmap step state: ${nextStatus}`,
      completionReason ? `Completion decision: ${completionReason}` : '',
      stepHandoffSummary ? `Step handoff summary updated: ${getStepMemoryFilePath(workspaceRoot, nodeId)}` : '',
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

    sendNodesToWebview();
    if (activePanel) {
      activePanel.webview.postMessage({
        command: 'nodeConversationsLoaded',
        nodeId,
        conversations: syncEngine.getAgentExecutions(nodeId),
        projectPath: activeProjectRoot || ''
      });
    }
    if (nextStatus === 'Completed' && !hasRecordedWorkspaceChanges(changedFilesSummary, touchedFilesSummary)) {
      vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
    } else {
      vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${nextStatus}`);
    }

    setTimeout(() => {
      if (fs.existsSync(statusFilePath)) {
        fs.unlinkSync(statusFilePath);
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

  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.agent_status.json')
  );

  const handleSentinelChange = () => processAgentStatusFile(statusFilePath);
  watcher.onDidChange(handleSentinelChange);
  watcher.onDidCreate(handleSentinelChange);
  statusPoller = setInterval(handleSentinelChange, 2000);
  handleSentinelChange();
}

/**
 * Helper to make robust, zero-dependency https POST requests
 */
function httpsRequest(url: string, options: https.RequestOptions, postData?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function cleanAndParseJson(text: string): any {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9]*\n?/, '');
    cleaned = cleaned.replace(/\n?```$/, '');
  }
  cleaned = cleaned.trim();
  if (!cleaned.startsWith('[')) {
    const match = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      cleaned = match[0];
    }
  }
  return JSON.parse(cleaned);
}

/**
 * Handles AI Generation of the Roadmap using LLM API
 */
async function handleGenerateRoadmap(context: vscode.ExtensionContext, prompt: string) {
  if (!syncEngine) {
    return;
  }

  const savedSettings = getPersistedSettings(context);
  let apiProvider = savedSettings.apiProvider;
  const apiKey = savedSettings.apiKey;
  const cliPath = resolveAgentCli('antigravity-cli', savedSettings.cliPath);

  if (apiProvider !== 'VS Code Copilot (Native)' && !apiKey) {
    if ((vscode as any).lm && (vscode as any).lm.selectChatModels) {
      apiProvider = 'VS Code Copilot (Native)';
    } else {
      const localNodes = buildLocalRoadmap(prompt, cliPath);
      syncEngine.setNodes(localNodes);
      sendNodesToWebview();
      vscode.window.showWarningMessage(`No API key is configured for ${apiProvider}; generated a local starter roadmap so the project can continue.`);
      return;
    }
  }

  const systemInstruction = `You are Solopreneur AI, a product strategist and software delivery planner for solo builders.
Your task is to generate a customized local-first project roadmap as a JSON array of tasks based on the user's project idea and requirements.

Return ONLY a valid JSON array of roadmap nodes. Do NOT wrap it in HTML, do NOT add any markdown formatting (like \`\`\`json), and do NOT include any introductory or concluding text. Your entire response must be a single parseable JSON array.

Each node in the array must strictly conform to the following JSON structure:
{
  "id": "unique_string_number_e.g_1_2_3",
  "title": "Short concise task title in Chinese",
  "description": "Clear explanation in Chinese of what outcome this roadmap step should achieve",
  "stage": "商业规划" | "品牌与设置" | "产品与 MVP" | "营销与增长",
  "dependencies": "comma_separated_dependency_ids_or_empty_string",
  "agentCli": "${cliPath}",
  "agentPrompt": "A concrete Chinese instruction prompt to send to the AI agent for this step"
}

Guidelines:
1. The roadmap must always follow this clear framework, customized to the user's idea:
   - "商业规划": target user, promise, market position, MVP boundary, risks, acceptance criteria.
   - "品牌与设置": naming/voice, README/project docs, workspace structure, lightweight operating assets.
   - "产品与 MVP": implementation plan, first vertical slice, local run path, verification commands.
   - "营销与增长": launch checklist, initial copy, distribution experiment, measurable next action.
2. Create a logical progression of 4 to 6 tasks. Each task should be small enough to support multiple Agent conversations.
3. Make sure dependencies are correctly set. For example, "2" depends on "1", "3" depends on "2", etc. Dependencies should reflect actual prerequisite outcomes.
4. Set "agentCli" to the exact string: "${cliPath}".
5. Create descriptive but action-oriented "agentPrompt" prompts. Each prompt should ask the agent to write or modify concrete local project files and run narrow verification where relevant.
6. Do not generate vague consulting tasks. Every roadmap step must have a visible local deliverable.`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating your project roadmap with AI...',
      cancellable: false,
    },
    async (progress) => {
      try {
        let responseText = '';

        if (apiProvider === 'VS Code Copilot (Native)') {
          const models = await vscode.lm.selectChatModels();
          if (models.length === 0) {
            throw new Error('No Copilot Chat models available. Please ensure GitHub Copilot Chat extension is active.');
          }
          const model = models.find((m) => m.id.includes('gpt-4') || m.id.includes('gemini')) || models[0];
          const messages = [
            new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, `${systemInstruction}\n\nProject Description: ${prompt}`)
          ];
          const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
          for await (const chunk of response.text) {
            responseText += chunk;
          }
        } else if (apiProvider === 'Gemini') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
          const postData = JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `User Project Description: ${prompt}`
                  }
                ]
              }
            ],
            systemInstruction: {
              parts: [
                {
                  text: systemInstruction
                }
              ]
            },
            generationConfig: {
              responseMimeType: "application/json"
            }
          });

          const responseStr = await httpsRequest(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              }
            },
            postData
          );

          const resJson = JSON.parse(responseStr);
          if (resJson.candidates && resJson.candidates[0] && resJson.candidates[0].content && resJson.candidates[0].content.parts[0]) {
            responseText = resJson.candidates[0].content.parts[0].text;
          } else {
            throw new Error('Invalid response structure received from Gemini API');
          }
        } else if (apiProvider === 'OpenAI') {
          const url = 'https://api.openai.com/v1/chat/completions';
          const postData = JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: systemInstruction
              },
              {
                role: 'user',
                content: `Project Description: ${prompt}`
              }
            ]
          });

          const responseStr = await httpsRequest(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              }
            },
            postData
          );

          const resJson = JSON.parse(responseStr);
          if (resJson.choices && resJson.choices[0] && resJson.choices[0].message) {
            responseText = resJson.choices[0].message.content;
          } else {
            throw new Error('Invalid response structure received from OpenAI API');
          }
        }

        const cleanJson = cleanAndParseJson(responseText);
        if (!Array.isArray(cleanJson)) {
          throw new Error('LLM did not return a valid array of roadmap tasks');
        }

        // Map response to proper RoadmapNode types
        const now = new Date().toISOString();
        const customNodes: RoadmapNode[] = cleanJson.map((node: any, idx: number) => ({
          id: node.id || String(idx + 1),
          title: node.title || `Task ${idx + 1}`,
          description: node.description || '',
          stage: node.stage || '商业规划',
          dependencies: node.dependencies || '',
          agentCli: node.agentCli || cliPath,
          agentPrompt: node.agentPrompt || '',
          status: 'Pending',
          createdAt: now,
          completedAt: '',
        }));

        if (syncEngine) {
          syncEngine.setNodes(customNodes);
          sendNodesToWebview();
          vscode.window.showInformationMessage('AI Roadmap generated successfully!');
        }
      } catch (error: any) {
        const localNodes = buildLocalRoadmap(prompt, cliPath);
        syncEngine?.setNodes(localNodes);
        sendNodesToWebview();
        vscode.window.showWarningMessage(`AI roadmap generation failed, so Solopreneur created a local starter roadmap instead: ${error.message || error}`);
      }
    }
  );
}

/**
 * Formulates the premium glassmorphic Webview page bundle.
 */
function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // In MVP, we embed a fully functional React + CSS app direct inside the iframe
  // which uses modern styling guidelines (glassmorphism, glowing connections, inter font).
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solopreneur Roadmap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously (Prevent network blocks on slow connections) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
  </noscript>
  
  <style>
    :root {
      --bg-dark: #0f111a;
      --bg-glass: rgba(22, 28, 45, 0.6);
      --border-glass: rgba(255, 255, 255, 0.08);
      --glow-blue: rgba(0, 229, 255, 0.8);
      --glow-green: rgba(0, 230, 118, 0.8);
      --glow-red: rgba(255, 23, 68, 0.8);
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--vscode-editor-background, var(--bg-dark));
      color: var(--text-main);
      overflow-x: hidden;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }

    /* Premium Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: rgba(15, 17, 26, 0.7);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-glass);
      z-index: 10;
    }

    h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      margin: 0;
      font-weight: 800;
      background: linear-gradient(135deg, #00e5ff 0%, #7c4dff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .project-select {
      width: 180px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      color: var(--text-main);
      font-family: inherit;
      outline: none;
    }

    .btn-project-add {
      padding: 8px 10px;
      min-width: 34px;
    }

    input[type="text"] {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px 12px;
      color: var(--text-main);
      font-family: inherit;
      width: 250px;
      outline: none;
      transition: all 0.3s ease;
    }

    input[type="text"]:focus {
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    button {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(0, 229, 255, 0.4);
    }

    /* Roadmap Canvas */
    .roadmap-canvas {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at 50% 50%, rgba(20, 25, 45, 0.6) 0%, rgba(10, 12, 22, 0.95) 100%);
      overflow: auto;
      padding: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 30px;
    }

    /* Node Stack (Unified Roadmap Flow layout) */
    .flow-line {
      position: absolute;
      width: 4px;
      background: linear-gradient(to bottom, #00e5ff, #7c4dff);
      top: 60px;
      bottom: 60px;
      z-index: 1;
    }

    .node-row {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      max-width: 800px;
      z-index: 2;
    }

    .node-card {
      width: 100%;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      gap: 16px;
      flex-direction: column;
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      cursor: pointer;
    }

    .node-card:hover {
      transform: scale(1.01) translateY(-2px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      border-color: rgba(255,255,255,0.15);
    }

    /* Status indicators */
    .node-card.status-Pending {
      border-left: 5px solid #64748b;
    }
    .node-card.status-Running {
      border-left: 5px solid #00e5ff;
      animation: pulse-border 2s infinite;
    }
    .node-card.status-In-Progress {
      border-left: 5px solid #facc15;
      box-shadow: 0 0 15px rgba(250, 204, 21, 0.08);
    }
    .node-card.status-Completed {
      border-left: 5px solid #00e676;
      box-shadow: 0 0 15px rgba(0, 230, 118, 0.1);
    }
    .node-card.status-Failed {
      border-left: 5px solid #ff1744;
      box-shadow: 0 0 15px rgba(255, 23, 68, 0.1);
    }

    @keyframes pulse-border {
      0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(0, 229, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
    }

    .node-badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
      align-self: flex-start;
    }

    .stage-Business-Planning { color: #818cf8; }
    .stage-Brand---Setup { color: #f472b6; }
    .stage-Product---MVP { color: #38bdf8; }
    .stage-Marketing---Growth { color: #34d399; }

    .node-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .node-summary {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .node-headline {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .node-expand-icon {
      color: var(--text-muted);
      font-size: 12px;
      margin-right: 2px;
    }

    .node-expanded-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
      padding-top: 12px;
      border-top: 1px solid var(--border-glass);
    }

    .node-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }

    .node-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .node-agent-prompt {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 11px;
      color: #38bdf8;
      border-left: 2px solid #38bdf8;
      margin-top: 6px;
    }

    .node-actions {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
    }

    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
    }

    .status-badge.Pending { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
    .status-badge.Running { background: rgba(0, 229, 255, 0.15); color: #00e5ff; }
    .status-badge.In-Progress { background: rgba(250, 204, 21, 0.15); color: #facc15; }
    .status-badge.Completed { background: rgba(0, 230, 118, 0.15); color: #00e676; }
    .status-badge.Failed { background: rgba(255, 23, 68, 0.15); color: #ff1744; }

    .btn-run {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-run:hover {
      background: #00e5ff;
      color: #000;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
    }

    .node-card.status-Running .btn-run {
      pointer-events: none;
      opacity: 0.5;
      background: rgba(255,255,255,0.02);
      color: var(--text-muted);
    }

    .conversation-panel {
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
    }

    .conversation-compose {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .conversation-compose input {
      flex: 1;
      width: auto;
      min-width: 0;
    }

    .conversation-agent-select {
      width: 132px;
      min-width: 120px;
      height: 34px;
      background: rgba(0, 0, 0, 0.24);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      border-radius: 6px;
      padding: 0 8px;
      font-size: 12px;
    }

    .btn-send-conversation {
      min-width: 78px;
      white-space: nowrap;
    }

    .conversation-compose input:disabled,
    .conversation-agent-select:disabled,
    .btn-send-conversation:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .conversation-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .conversation-empty {
      color: var(--text-muted);
      font-size: 12px;
      padding: 8px 0;
    }

    .conversation-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .conversation-item {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      overflow: hidden;
    }

    .conversation-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    .conversation-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .conversation-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .conversation-retry-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-retry-btn:hover {
      background: rgba(255, 23, 68, 0.16);
      border-color: rgba(255, 23, 68, 0.4);
      color: #ffd7df;
      box-shadow: none;
      transform: none;
    }

    .conversation-cli {
      color: #38bdf8;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-time {
      color: var(--text-muted);
      font-size: 11px;
    }

    .conversation-summary {
      color: var(--text-main);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(520px, 58vw);
    }

    .conversation-detail {
      border-top: 1px solid var(--border-glass);
      padding: 10px;
      color: var(--text-muted);
      font-size: 12px;
    }

    .conversation-detail pre {
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 260px;
      overflow: auto;
      margin: 6px 0 0;
      font-size: 11px;
      color: #cbd5e1;
    }

    .conversation-files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 8px 0 12px;
    }

    .conversation-file-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      text-decoration: none;
      font-size: 11px;
      cursor: pointer;
    }

    .conversation-file-link:hover {
      background: rgba(56, 189, 248, 0.16);
    }

    /* Settings Overlay Styles */
    .settings-overlay {
      position: absolute;
      top: 75px;
      right: 24px;
      width: 320px;
      background: rgba(15, 17, 26, 0.95);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 16px;
      z-index: 100;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: none;
      flex-direction: column;
      gap: 12px;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slide-down {
      from { transform: translateY(-10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .settings-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      margin: 0;
      font-weight: 800;
      color: #00e5ff;
    }

    .btn-close-settings {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 20px;
      font-weight: bold;
      padding: 0 4px;
    }

    .btn-close-settings:hover {
      color: #ff1744;
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .settings-lbl-title {
      font-size: 9.5px;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.5px;
    }

    .settings-input, .settings-select {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    .settings-input:focus, .settings-select:focus {
      border-color: #00e5ff;
    }

    .settings-select option {
      background: #0f111a;
      color: #e2e8f0;
    }

    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 8px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .settings-action-btn.test-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
    }

    .settings-action-btn.test-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .settings-action-btn.save-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
    }

    .settings-action-btn.save-btn:hover {
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
    }

    .cli-badge {
      margin-top: 8px;
      font-size: 11px;
      padding: 6px 8px;
      border-radius: 6px;
      font-weight: 600;
      text-align: center;
      line-height: 1.3;
    }

    .cli-badge.success {
      background: rgba(0, 230, 118, 0.1);
      color: #00e676;
      border: 1px solid rgba(0, 230, 118, 0.15);
    }

    .cli-badge.error {
      background: rgba(255, 23, 68, 0.1);
      color: #ff1744;
      border: 1px solid rgba(255, 23, 68, 0.15);
    }

    .btn-gear {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 20px;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .btn-gear:hover {
      color: #00e5ff;
      transform: rotate(30deg) scale(1.1);
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <h1 id="app-title">🎯 Solopreneur AI Roadmap</h1>
      <div class="controls">
        <select class="project-select" id="project-select"></select>
        <button class="btn-project-add" id="btn-add-project" title="Add project folder">+</button>
        <button class="btn-gear" id="btn-toggle-settings" title="Solopreneur Settings">⚙️</button>
      </div>
    </header>

    <div class="roadmap-canvas" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3 id="settings-title">⚙️ Solopreneur Settings</h3>
      <button class="btn-close-settings" id="btn-close-settings">×</button>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-language">Language</label>
      <select class="settings-select" id="setting-language">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-provider">AI Provider</label>
      <select class="settings-select" id="setting-provider">
        <option value="Gemini">Gemini</option>
        <option value="OpenAI">OpenAI</option>
        <option value="VS Code Copilot (Native)">VS Code Copilot (Native)</option>
      </select>
    </div>

    <div class="settings-field" id="api-key-container">
      <label class="settings-lbl-title" id="label-api-key">API Key</label>
      <input type="password" class="settings-input" id="setting-key" placeholder="Enter API Key...">
      <div id="help-api-key" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Required for standalone providers (Gemini or OpenAI). Not needed for VS Code Copilot (Native).
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. agy">
      <div id="help-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code> or <code>codex</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli">⚡ <span id="text-test-cli">Test CLI</span></button>
      <button class="settings-action-btn save-btn" id="btn-save-settings">💾 <span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const projectSelect = document.getElementById('project-select');
    const btnAddProject = document.getElementById('btn-add-project');

    // Settings Panel elements
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingProvider = document.getElementById('setting-provider');
    const settingKey = document.getElementById('setting-key');
    const apiKeyContainer = document.getElementById('api-key-container');
    const settingCliPath = document.getElementById('setting-clipath');
    const settingLanguage = document.getElementById('setting-language');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let expandedNodeId = '';
    let activeConversationId = '';
    let activeProjectPath = '';
    let currentCliPath = 'agy';
    const nodeConversations = {};
    const i18n = {
      zh: {
        title: '🎯 独立项目 AI 路线图',
        addProject: '添加项目文件夹',
        settingsTitle: '⚙️ 设置',
        language: '界面语言',
        provider: 'AI 服务',
        apiKey: 'API Key',
        apiKeyPlaceholder: '输入 API Key...',
        apiKeyHelp: 'Gemini 或 OpenAI 需要填写；使用 VS Code Copilot 时不需要。',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex）或可执行文件绝对路径。',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。请添加项目文件夹，或重新打开当前项目。',
        startConversation: '发起 Agent 对话',
        conversationHistory: 'Agent 对话历史',
        noConversations: '这个环节还没有 Agent 对话。',
        conversationPlaceholder: '补充这次要 Agent 注意的要求...',
        agentSelector: '选择 Agent',
        send: '发送',
        retry: '重试',
        command: '命令',
        output: '输出',
        changedFiles: '修改文件',
        openFile: '打开',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        markComplete: '完成环节',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败' }
      },
      en: {
        title: '🎯 Solopreneur AI Roadmap',
        addProject: 'Add project folder',
        settingsTitle: '⚙️ Solopreneur Settings',
        language: 'Language',
        provider: 'AI Provider',
        apiKey: 'API Key',
        apiKeyPlaceholder: 'Enter API Key...',
        apiKeyHelp: 'Required for Gemini or OpenAI. Not needed for VS Code Copilot.',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy or codex, or an absolute executable path.',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Add a project folder or reopen the current project.',
        startConversation: 'Start Agent Conversation',
        conversationHistory: 'Agent Conversation History',
        noConversations: 'No Agent conversations for this step yet.',
        conversationPlaceholder: 'Add guidance for this Agent run...',
        agentSelector: 'Choose Agent',
        send: 'Send',
        retry: 'Retry',
        command: 'Command',
        output: 'Output',
        changedFiles: 'Changed Files',
        openFile: 'Open',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        markComplete: 'Complete Step',
        status: { Pending: 'Pending', 'In Progress': 'In Progress', Running: 'Running', Completed: 'Completed', Failed: 'Failed' }
      }
    };

    function t(key) {
      return i18n[currentLanguage][key] || i18n.en[key] || key;
    }

    function statusText(status) {
      return (i18n[currentLanguage].status || {})[status] || status;
    }

    function statusClass(status) {
      return String(status || '').replace(/[^a-zA-Z0-9]/g, '-');
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function resetProjectScopedState(projectPath, clearNodes) {
      activeProjectPath = projectPath || '';
      expandedNodeId = '';
      activeConversationId = '';
      Object.keys(nodeConversations).forEach(key => delete nodeConversations[key]);
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      btnAddProject.title = t('addProject');
      setText('settings-title', t('settingsTitle'));
      setText('label-language', t('language'));
      setText('label-provider', t('provider'));
      setText('label-api-key', t('apiKey'));
      settingKey.placeholder = t('apiKeyPlaceholder');
      setText('help-api-key', t('apiKeyHelp'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderRoadmap(currentNodes);
    }

    const currentProjects = { projects: [], selectedProjectPath: '' };

    // Toggle Settings panel visibility
    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'flex') {
        settingsPanel.style.display = 'none';
      } else {
        settingsPanel.style.display = 'flex';
        vscode.postMessage({ command: 'getSettings' });
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    settingProvider.addEventListener('change', () => {
      if (settingProvider.value === 'VS Code Copilot (Native)') {
        apiKeyContainer.style.display = 'none';
      } else {
        apiKeyContainer.style.display = 'flex';
      }
    });

    settingLanguage.addEventListener('change', () => {
      currentLanguage = settingLanguage.value;
      applyLanguage();
    });

    // Request nodes and settings on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });
    vscode.postMessage({ command: 'getProjects' });

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, false);
          }
          currentNodes = message.nodes || [];
          renderRoadmap(message.nodes);
          break;
        case 'settingsLoaded':
          settingProvider.value = message.settings.apiProvider || 'Gemini';
          settingKey.value = message.settings.apiKey || '';
          settingCliPath.value = message.settings.cliPath || 'agy';
          currentCliPath = settingCliPath.value || 'agy';
          settingLanguage.value = message.settings.language || 'zh';
          currentLanguage = settingLanguage.value;

          if (settingProvider.value === 'VS Code Copilot (Native)') {
            apiKeyContainer.style.display = 'none';
          } else {
            apiKeyContainer.style.display = 'flex';
          }
          applyLanguage();
          break;
        case 'projectsLoaded':
          if (
            message.projects.selectedProjectPath &&
            activeProjectPath &&
            message.projects.selectedProjectPath !== activeProjectPath
          ) {
            resetProjectScopedState(message.projects.selectedProjectPath, true);
            renderRoadmap(currentNodes);
          } else if (message.projects.selectedProjectPath && !activeProjectPath) {
            activeProjectPath = message.projects.selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
          break;
        case 'nodeConversationsLoaded':
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            return;
          }
          nodeConversations[message.nodeId] = message.conversations || [];
          renderRoadmap(currentNodes);
          break;
        case 'cliTestResult':
          cliTestBadge.style.display = 'block';
          if (message.success) {
            cliTestBadge.className = 'cli-badge success';
            cliTestBadge.textContent = t('connectionOk') + message.message;
          } else {
            cliTestBadge.className = 'cli-badge error';
            cliTestBadge.textContent = t('connectionFailed') + message.message;
          }
          break;
      }
    });

    // Save configurations
    btnSaveSettings.addEventListener('click', () => {
      vscode.postMessage({
        command: 'updateSettings',
        apiProvider: settingProvider.value,
        apiKey: settingKey.value.trim(),
        cliPath: settingCliPath.value.trim(),
        language: settingLanguage.value
      });
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    // Test CLI path
    btnTestCli.addEventListener('click', () => {
      cliTestBadge.style.display = 'block';
      cliTestBadge.className = 'cli-badge';
      cliTestBadge.style.background = 'rgba(255,255,255,0.05)';
      cliTestBadge.style.color = 'var(--text-muted)';
      cliTestBadge.textContent = t('testing');

      vscode.postMessage({
        command: 'testCli',
        cliPath: settingCliPath.value.trim()
      });
    });

    projectSelect.addEventListener('change', () => {
      vscode.postMessage({
        command: 'selectProject',
        projectPath: projectSelect.value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    function renderProjects(projects, selectedProjectPath) {
      projectSelect.innerHTML = '';
      if (!projects || projects.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = t('chooseProject');
        projectSelect.appendChild(option);
        return;
      }

      projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.path;
        option.textContent = project.name;
        option.title = project.path;
        if (project.path === selectedProjectPath) {
          option.selected = true;
        }
        projectSelect.appendChild(option);
      });
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderRoadmap(nodes) {
      // Clear canvas keeping the flow line
      const flowLine = canvas.querySelector('.flow-line');
      canvas.innerHTML = '';
      canvas.appendChild(flowLine);

      if (!nodes || nodes.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.style.color = 'var(--text-muted)';
        placeholder.style.marginTop = '40px';
        placeholder.textContent = t('emptyRoadmap');
        canvas.appendChild(placeholder);
        return;
      }

      nodes.forEach(node => {
        const row = document.createElement('div');
        row.className = 'node-row';

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');
        const expanded = expandedNodeId === node.id;
        const conversations = nodeConversations[node.id] || [];
        const conversationDisabled = node.status === 'Running' ? 'disabled' : '';
        const promptHtml = expanded ? \`
          <div class="node-expanded-body">
            <div class="node-desc">\${escapeHtml(node.description)}</div>
            <div class="node-agent-prompt">
              <strong>\${escapeHtml(node.agentCli)}:</strong> \${escapeHtml(node.agentPrompt)}
            </div>
            <div class="conversation-compose">
              <input type="text" class="conversation-input" data-conversation-input-id="\${escapeHtml(node.id)}" placeholder="\${t('conversationPlaceholder')}" \${conversationDisabled}>
              <select class="conversation-agent-select" data-agent-select-id="\${escapeHtml(node.id)}" title="\${t('agentSelector')}" \${conversationDisabled}>
                \${renderAgentOptions(node)}
              </select>
              <button class="btn-send-conversation" data-send-node-id="\${escapeHtml(node.id)}" \${conversationDisabled}>\${t('send')}</button>
            </div>
            <div class="conversation-panel">
              <div class="conversation-title">\${t('conversationHistory')}</div>
              \${renderConversations(node.id, conversations)}
            </div>
          </div>
        \` : '';

        row.innerHTML = \`
          <div class="node-card status-\${statusClass(node.status)} \${expanded ? 'expanded' : 'collapsed'}" data-node-card-id="\${escapeHtml(node.id)}">
            <div class="node-summary">
              <div class="node-content">
                <div class="node-headline">
                  <span class="node-expand-icon">\${expanded ? '▾' : '▸'}</span>
                  <span class="node-badge stage-\${cleanStage}">\${escapeHtml(node.stage)}</span>
                  <span class="node-title">\${escapeHtml(node.title)}</span>
                </div>
                \${promptHtml}
              </div>
              <div class="node-actions">
                <span class="status-badge \${statusClass(node.status)}">\${statusText(node.status)}</span>
                \${node.status !== 'Completed' ? \`<button class="btn-run" data-complete-node-id="\${escapeHtml(node.id)}">\${t('markComplete')}</button>\` : ''}
              </div>
            </div>
          </div>
        \`;
        const card = row.querySelector('[data-node-card-id]');
        if (card) {
          card.addEventListener('click', (event) => {
            if (event.target.closest('button') || event.target.closest('input') || event.target.closest('select') || event.target.closest('[data-conversation-id]')) {
              return;
            }
            toggleNode(node.id);
          });
        }
        const sendButton = row.querySelector('[data-send-node-id]');
        if (sendButton) {
          sendButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const input = row.querySelector('[data-conversation-input-id="' + cssEscape(node.id) + '"]');
            const agentSelect = row.querySelector('[data-agent-select-id="' + cssEscape(node.id) + '"]');
            triggerRun(node.id, input ? input.value : '', agentSelect ? agentSelect.value : '');
            if (input) input.value = '';
          });
        }
        const completeButton = row.querySelector('[data-complete-node-id]');
        if (completeButton) {
          completeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'completeNode', nodeId: node.id });
          });
        }
        row.querySelectorAll('[data-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            activeConversationId = activeConversationId === item.getAttribute('data-conversation-id')
              ? ''
              : item.getAttribute('data-conversation-id');
            renderRoadmap(currentNodes);
          });
        });
        row.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const conversationId = item.getAttribute('data-retry-conversation-id');
            if (!conversationId) return;
            vscode.postMessage({
              command: 'retryConversation',
              nodeId: node.id,
              conversationId
            });
          });
        });
        row.querySelectorAll('[data-open-file-path]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const relativePath = item.getAttribute('data-open-file-path');
            if (!relativePath) return;
            vscode.postMessage({ command: 'openProjectFile', relativePath });
          });
        });
        canvas.appendChild(row);
      });
    }

    function renderConversations(nodeId, conversations) {
      if (!conversations || conversations.length === 0) {
        return '<div class="conversation-empty">' + t('noConversations') + '</div>';
      }

      const items = conversations.map(conversation => {
        const conversationId = nodeId + ':' + conversation.id;
        const open = activeConversationId === conversationId;
        const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
        const summary = summarizeConversation(conversation);
        const retryButton = conversation.status === 'Failed'
          ? \`<button class="conversation-retry-btn" data-retry-conversation-id="\${escapeHtml(conversation.id)}">\${t('retry')}</button>\`
          : '';
        return \`
          <div class="conversation-item" data-conversation-id="\${escapeHtml(conversationId)}">
            <div class="conversation-row">
              <div class="conversation-meta">
                <span class="conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
                <span class="conversation-summary">\${escapeHtml(summary)}</span>
                <span class="conversation-time">\${escapeHtml(when)}</span>
              </div>
              <div class="conversation-actions">
                \${retryButton}
                <span class="status-badge \${statusClass(conversation.status)}">\${statusText(conversation.status)}</span>
              </div>
            </div>
            \${open ? \`
              <div class="conversation-detail">
                \${renderConversationFiles(conversation)}
                <strong>\${t('command')}</strong>
                <pre>\${escapeHtml(conversation.command)}</pre>
                <strong>\${t('output')}</strong>
                <pre>\${escapeHtml(conversation.output)}</pre>
              </div>
            \` : ''}
          </div>
        \`;
      }).join('');
      return '<div class="conversation-list">' + items + '</div>';
    }

    function renderAgentOptions(node) {
      const options = [];
      function addOption(value, label) {
        const normalized = String(value || '').trim();
        if (!normalized || options.some(option => option.value === normalized)) return;
        options.push({ value: normalized, label: label || normalized });
      }
      addOption(node.agentCli || currentCliPath || 'agy');
      addOption(currentCliPath || 'agy');
      addOption('agy');
      addOption('codex');
      addOption('antigravity');
      addOption('antigravity-cli');
      addOption('codex-cli');
      return options.map(option => \`
        <option value="\${escapeHtml(option.value)}">\${escapeHtml(option.label)}</option>
      \`).join('');
    }

    function summarizeConversation(conversation) {
      const output = String(conversation.output || '');
      const userMatch = output.match(/User supplement:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (userMatch && userMatch[1].trim()) {
        return userMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const changedMatch = output.match(/Touched project files:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (changedMatch && changedMatch[1].trim() && !changedMatch[1].includes('No project files')) {
        return changedMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const tailMatch = output.match(/Agent output tail:\\n([\\s\\S]*)$/);
      const fallback = tailMatch ? tailMatch[1] : output;
      return fallback.trim().replace(/\\s+/g, ' ').slice(0, 120) || statusText(conversation.status);
    }

    function extractConversationFiles(output) {
      const text = String(output || '');
      const sections = [
        /Touched project files:\\n([\\s\\S]*?)(?:\\n\\n|$)/,
        /Workspace changes:\\n([\\s\\S]*?)(?:\\n\\nTouched project files:|\\n\\n|$)/
      ];
      const files = [];
      const seen = new Set();
      for (const pattern of sections) {
        const match = text.match(pattern);
        if (!match || !match[1]) continue;
        const lines = match[1].split('\\n').map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (/^No (workspace|git|project) /i.test(line)) continue;
          const normalized = line.replace(/^(?:[AMDRC?U!]{1,2}|[A-Z])\\s+/, '').trim();
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          files.push({ label: line, path: normalized });
        }
      }
      return files;
    }

    function renderConversationFiles(conversation) {
      const files = extractConversationFiles(conversation.output);
      if (!files.length) {
        return '';
      }
      return \`
        <strong>\${escapeHtml(t('changedFiles'))}</strong>
        <div class="conversation-files">
          \${files.map(file => \`
            <button
              class="conversation-file-link"
              data-open-file-path="\${escapeHtml(file.path)}"
              title="\${escapeHtml(file.path)}"
            >
              <span>\${escapeHtml(file.label)}</span>
              <span>\${escapeHtml(t('openFile'))}</span>
            </button>
          \`).join('')}
        </div>
      \`;
    }

    function toggleNode(nodeId) {
      expandedNodeId = expandedNodeId === nodeId ? '' : nodeId;
      activeConversationId = '';
      if (expandedNodeId && !nodeConversations[nodeId]) {
        vscode.postMessage({ command: 'getNodeConversations', nodeId });
      }
      renderRoadmap(currentNodes);
    }

    function cssEscape(value) {
      if (window.CSS && window.CSS.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/"/g, '\\"');
    }

    function triggerRun(nodeId, userMessage, agentCli) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId,
        userMessage: userMessage || '',
        agentCli: agentCli || ''
      });
    }
  </script>
</body>
</html>`;
}

export function deactivate() {
  if (watcher) {
    watcher.dispose();
  }
  if (statusPoller) {
    clearInterval(statusPoller);
  }
}
