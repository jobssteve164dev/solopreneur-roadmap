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
        await handleRunAgent(context, nodeId);
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
    cliPath: saved.cliPath || config.get('cliPath') || 'antigravity-cli',
    language: saved.language || config.get('language') || 'zh'
  };
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: SolopreneurSettings): Promise<void> {
  const nextSettings: SolopreneurSettings = {
    apiProvider: settings.apiProvider || 'Gemini',
    apiKey: settings.apiKey || '',
    cliPath: settings.cliPath || 'antigravity-cli',
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
  await ensureSyncEngine(context);
  sendProjectsToWebviews(context);
  sendNodesToWebview();
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

        case 'runAgent':
          await handleRunAgent(context, message.nodeId);
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
              conversations: syncEngine.getAgentExecutions(message.nodeId)
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
          childProcess.execFile(cliToTest, ['--version'], (error: any, stdout: string, stderr: string) => {
            const success = !error;
            let msg = error ? error.message : (stdout.trim() || stderr.trim());
            if (!success) {
              msg = 'Command not found or failed';
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

  const result = childProcess.spawnSync('sh', ['-lc', `command -v ${shellQuote(trimmed)}`], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function resolveAgentCli(agentCli: string, configuredCliPath: string): string {
  const requestedCli = (agentCli || '').trim();
  const configuredCli = (configuredCliPath || '').trim();
  const defaultCliNames = new Set(['', 'antigravity-cli', 'codex-cli']);
  const preferredCli = defaultCliNames.has(requestedCli) ? configuredCli : requestedCli;
  const candidates = [
    preferredCli,
    requestedCli,
    configuredCli,
    'codex',
    'antigravity-cli',
    'codex-cli'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }

  return preferredCli || 'codex';
}

function buildAgentCommand(agentCli: string, agentPrompt: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPrompt = shellQuote(agentPrompt);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} exec -C ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }

  return `${quotedCli} run --task ${quotedPrompt}`;
}

function buildAgentShellScript(
  agentCommand: string,
  workspaceRoot: string,
  nodeId: string,
  agentCli: string
): { finalCommand: string; outputFilePath: string; changesFilePath: string } {
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId);
  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const runningStatus = JSON.stringify({ nodeId, status: 'Running', command: agentCli, outputFilePath, changesFilePath });
  const completedStatus = JSON.stringify({ nodeId, status: 'Completed', command: agentCli, outputFilePath, changesFilePath });
  const failedStatus = JSON.stringify({ nodeId, status: 'Failed', command: agentCli, outputFilePath, changesFilePath });
  const script = [
    `mkdir -p ${shellQuote(runDir)}`,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    `(${agentCommand}) 2>&1 | tee ${shellQuote(outputFilePath)}`,
    `status=\${PIPESTATUS[0]}`,
    `git -C ${shellQuote(workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
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

function buildLocalRoadmap(prompt: string, cliPath: string): RoadmapNode[] {
  const now = new Date().toISOString();
  const safePrompt = prompt.trim() || 'New solopreneur project';
  return [
    {
      id: '1',
      title: 'Define the product promise',
      description: `Turn "${safePrompt}" into a concrete offer, target user, success metric, and first release boundary.`,
      stage: 'Business Planning',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: `Create a concise product brief for "${safePrompt}". Write it to docs/product-brief.md with target users, core promise, MVP boundary, risks, and acceptance criteria.`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '2',
      title: 'Create the implementation plan',
      description: 'Convert the product brief into a build sequence with files, milestones, and verification commands.',
      stage: 'Product & MVP',
      dependencies: '1',
      agentCli: cliPath,
      agentPrompt: `Read docs/product-brief.md and create docs/implementation-plan.md for "${safePrompt}". Include milestones, expected files, verification commands, and a small first vertical slice.`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '3',
      title: 'Build the first vertical slice',
      description: 'Implement the smallest usable product path and leave runnable verification notes.',
      stage: 'Product & MVP',
      dependencies: '2',
      agentCli: cliPath,
      agentPrompt: `Implement the first vertical slice described in docs/implementation-plan.md. Keep changes local to this workspace, update README.md with how to run it, and run the narrowest relevant verification command.`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '4',
      title: 'Prepare launch assets',
      description: 'Create basic launch copy and a handoff checklist grounded in the shipped slice.',
      stage: 'Marketing & Growth',
      dependencies: '3',
      agentCli: cliPath,
      agentPrompt: `Create docs/launch-checklist.md for "${safePrompt}" based on the current files. Include positioning copy, release checklist, known gaps, and the next measurable growth action.`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    }
  ];
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(context: vscode.ExtensionContext, nodeId: string) {
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
  const agentCli = resolveAgentCli(node.agentCli, configuredCliPath);

  if (!commandExists(agentCli)) {
    vscode.window.showErrorMessage(`Agent CLI not found: ${agentCli}. Set Solopreneur CLI Command or Path to an installed executable such as codex.`);
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
  const agentCommand = buildAgentCommand(agentCli, node.agentPrompt, workspaceRoot);
  const { finalCommand } = buildAgentShellScript(agentCommand, workspaceRoot, nodeId, agentCli);

  // Log command launch to database
  syncEngine.logAgentExecution(
    nodeId,
    agentCli,
    agentCommand,
    'Launched command in integrated terminal',
    'Running'
  );

  terminal.sendText(finalCommand);
}

/**
 * Sets up a file system watcher to detect agent status changes written to .agent_status.json
 */
function setupFileSentinelWatcher(workspaceRoot: string) {
  if (watcher) {
    watcher.dispose();
  }

  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');

  // Watch `.agent_status.json` for modifications or creation
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.agent_status.json')
  );

  const handleSentinelChange = () => {
    if (!fs.existsSync(statusFilePath)) {
      return;
    }

    try {
      const fileContent = fs.readFileSync(statusFilePath, 'utf8').trim();
      if (!fileContent) {
        return; // Empty file (created but not written yet)
      }

      const statusData = JSON.parse(fileContent);
      const { nodeId, status, command, outputFilePath, changesFilePath } = statusData;

      if (!nodeId || !status || status === 'Running') {
        return; // Ignored states
      }

      if (syncEngine) {
        // Update node status
        const completedAt = status === 'Completed' ? new Date().toISOString() : '';
        syncEngine.updateNode(nodeId, {
          status: status,
          completedAt: completedAt,
        });

        // Log to SQL
        const outputTail = getOutputTail(outputFilePath);
        const changedFilesSummary = getChangedFilesSummary(changesFilePath);
        const executionSummary = [
          `Sentinel captured state: ${status}`,
          `Workspace changes:`,
          changedFilesSummary,
          outputTail ? `Agent output tail:\n${outputTail}` : 'Agent output tail: No captured output.'
        ].join('\n\n');
        syncEngine.logAgentExecution(
          nodeId,
          command || 'Unknown CLI',
          'Completed execution in terminal',
          executionSummary,
          status
        );

        // Notify Webview
        sendNodesToWebview();
        if (status === 'Completed' && changedFilesSummary === 'No workspace file changes detected.') {
          vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
        } else {
          vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${status}`);
        }

        // Remove sentinel file after read to clean up workspace
        setTimeout(() => {
          if (fs.existsSync(statusFilePath)) {
            fs.unlinkSync(statusFilePath);
          }
        }, 1000);
      }
    } catch (e) {
      // JSON might be partially written, ignore and wait for completed write
    }
  };

  watcher.onDidChange(handleSentinelChange);
  watcher.onDidCreate(handleSentinelChange);
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

  const systemInstruction = `You are Solopreneur AI, a master software architect and product manager.
Your task is to generate a visual software roadmap as a JSON array of tasks based on the user's project description.

Return ONLY a valid JSON array of roadmap nodes. Do NOT wrap it in HTML, do NOT add any markdown formatting (like \`\`\`json), and do NOT include any introductory or concluding text. Your entire response must be a single parseable JSON array.

Each node in the array must strictly conform to the following JSON structure:
{
  "id": "unique_string_number_e.g_1_2_3",
  "title": "Short concise task title",
  "description": "Clear explanation of what needs to be done",
  "stage": "Business Planning" | "Brand & Setup" | "Product & MVP" | "Marketing & Growth",
  "dependencies": "comma_separated_dependency_ids_or_empty_string",
  "agentCli": "${cliPath}",
  "agentPrompt": "The specific instruction prompt to send to the AI agent to execute this task"
}

Guidelines:
1. Break down the project roadmap strictly into standard stages representing the 4 pillars of Cofounder-2:
   - "Business Planning": Market analysis, competitive analysis, business vision definition, strategy roadmaps.
   - "Brand & Setup": Visual brand VI, domain suggestions, LLC administrative incorporation paperwork, organizational charts.
   - "Product & MVP": Project scaffolds, backend schemas, premium React frontend layouts, staging server deployments.
   - "Marketing & Growth": outbound pipeline lead generation, SEO copy writing, client conversion tracking.
2. Create a logical progression of 4 to 6 tasks.
3. Make sure dependencies are correctly set. For example, "2" depends on "1", "3" depends on "2", etc.
4. Set "agentCli" to the exact string: "${cliPath}".
5. Create extremely descriptive "agentPrompt" prompts so that when the agent is executed, it has enough detail to build the subsystem correctly.`;

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
          stage: node.stage || 'Business Planning',
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
        <input type="text" id="ai-prompt" placeholder="Describe your solopreneur project...">
        <button id="btn-generate">Generate AI Roadmap</button>
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
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. antigravity-cli">
      <div id="help-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>antigravity-cli</code> or <code>codex-cli</code>) or the absolute path to its executable.
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
    const btnGenerate = document.getElementById('btn-generate');
    const aiPromptInput = document.getElementById('ai-prompt');
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
    const nodeConversations = {};
    const i18n = {
      zh: {
        title: '🎯 独立项目 AI 路线图',
        addProject: '添加项目文件夹',
        promptPlaceholder: '描述你的项目想法...',
        generate: '生成 AI 路线图',
        settingsTitle: '⚙️ 设置',
        language: '界面语言',
        provider: 'AI 服务',
        apiKey: 'API Key',
        apiKeyPlaceholder: '输入 API Key...',
        apiKeyHelp: 'Gemini 或 OpenAI 需要填写；使用 VS Code Copilot 时不需要。',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 antigravity-cli、codex）或可执行文件绝对路径。',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。先描述项目想法，然后生成路线图。',
        startConversation: '发起 Agent 对话',
        conversationHistory: 'Agent 对话历史',
        noConversations: '这个环节还没有 Agent 对话。',
        command: '命令',
        output: '输出',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        status: { Pending: '待处理', Running: '进行中', Completed: '已完成', Failed: '失败' }
      },
      en: {
        title: '🎯 Solopreneur AI Roadmap',
        addProject: 'Add project folder',
        promptPlaceholder: 'Describe your solopreneur project...',
        generate: 'Generate AI Roadmap',
        settingsTitle: '⚙️ Solopreneur Settings',
        language: 'Language',
        provider: 'AI Provider',
        apiKey: 'API Key',
        apiKeyPlaceholder: 'Enter API Key...',
        apiKeyHelp: 'Required for Gemini or OpenAI. Not needed for VS Code Copilot.',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as antigravity-cli or codex, or an absolute executable path.',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Describe your project and generate a roadmap.',
        startConversation: 'Start Agent Conversation',
        conversationHistory: 'Agent Conversation History',
        noConversations: 'No Agent conversations for this step yet.',
        command: 'Command',
        output: 'Output',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        status: { Pending: 'Pending', Running: 'Running', Completed: 'Completed', Failed: 'Failed' }
      }
    };

    function t(key) {
      return i18n[currentLanguage][key] || i18n.en[key] || key;
    }

    function statusText(status) {
      return (i18n[currentLanguage].status || {})[status] || status;
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      btnAddProject.title = t('addProject');
      aiPromptInput.placeholder = t('promptPlaceholder');
      btnGenerate.textContent = t('generate');
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
          currentNodes = message.nodes || [];
          renderRoadmap(message.nodes);
          break;
        case 'settingsLoaded':
          settingProvider.value = message.settings.apiProvider || 'Gemini';
          settingKey.value = message.settings.apiKey || '';
          settingCliPath.value = message.settings.cliPath || 'antigravity-cli';
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
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
          break;
        case 'nodeConversationsLoaded':
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

    btnGenerate.addEventListener('click', () => {
      const prompt = aiPromptInput.value.trim();
      if (!prompt) return;
      
      vscode.postMessage({
        command: 'generateRoadmap',
        prompt: prompt
      });
      aiPromptInput.value = '';
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
        const promptHtml = expanded ? \`
          <div class="node-expanded-body">
            <div class="node-desc">\${escapeHtml(node.description)}</div>
            <div class="node-agent-prompt">
              <strong>\${escapeHtml(node.agentCli)}:</strong> \${escapeHtml(node.agentPrompt)}
            </div>
            <div class="conversation-panel">
              <div class="conversation-title">\${t('conversationHistory')}</div>
              \${renderConversations(node.id, conversations)}
            </div>
          </div>
        \` : '';

        row.innerHTML = \`
          <div class="node-card status-\${node.status} \${expanded ? 'expanded' : 'collapsed'}" data-node-card-id="\${escapeHtml(node.id)}">
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
                <span class="status-badge \${node.status}">\${statusText(node.status)}</span>
                <button class="btn-run" data-run-node-id="\${escapeHtml(node.id)}">
                  ⚡ \${t('startConversation')}
                </button>
              </div>
            </div>
          </div>
        \`;
        const card = row.querySelector('[data-node-card-id]');
        if (card) {
          card.addEventListener('click', (event) => {
            if (event.target.closest('button') || event.target.closest('[data-conversation-id]')) {
              return;
            }
            toggleNode(node.id);
          });
        }
        const runButton = row.querySelector('[data-run-node-id]');
        if (runButton) {
          runButton.addEventListener('click', (event) => {
            event.stopPropagation();
            triggerRun(node.id);
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
        return \`
          <div class="conversation-item" data-conversation-id="\${escapeHtml(conversationId)}">
            <div class="conversation-row">
              <div class="conversation-meta">
                <span class="conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
                <span class="conversation-time">\${escapeHtml(when)}</span>
              </div>
              <span class="status-badge \${escapeHtml(conversation.status || '')}">\${statusText(conversation.status)}</span>
            </div>
            \${open ? \`
              <div class="conversation-detail">
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

    function toggleNode(nodeId) {
      expandedNodeId = expandedNodeId === nodeId ? '' : nodeId;
      activeConversationId = '';
      if (expandedNodeId && !nodeConversations[nodeId]) {
        vscode.postMessage({ command: 'getNodeConversations', nodeId });
      }
      renderRoadmap(currentNodes);
    }

    function triggerRun(nodeId) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId
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
}
