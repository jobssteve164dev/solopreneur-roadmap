import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
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
  cliPath: string;
  language: string;
  globalPrompt: string;
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
const hiddenProjectsKey = 'solopreneur.hiddenProjects';
const roadmapRevisionId = '__roadmap_revision__';
const agentTerminalBaseName = 'SoloMap Agent Console';
let activeAgentTerminalName = '';
let agentTerminalCounter = 0;

export async function activate(context: vscode.ExtensionContext) {
  console.log('SoloMap extension is now active!');

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
    async (nodeId, userMessage = '', agentCli = '') => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleRunAgent(context, nodeId, userMessage, agentCli);
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
    cliPath: saved.cliPath || config.get('cliPath') || 'agy',
    language: saved.language || config.get('language') || 'zh',
    globalPrompt: saved.globalPrompt ?? config.get('globalPrompt') ?? ''
  };
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: SolopreneurSettings): Promise<void> {
  const nextSettings: SolopreneurSettings = {
    cliPath: settings.cliPath || 'agy',
    language: settings.language === 'en' ? 'en' : 'zh',
    globalPrompt: String(settings.globalPrompt || '').trim()
  };
  await context.globalState.update(settingsKey, nextSettings);

  const config = vscode.workspace.getConfiguration('solopreneur');
  await config.update('cliPath', nextSettings.cliPath, vscode.ConfigurationTarget.Global);
  await config.update('language', nextSettings.language, vscode.ConfigurationTarget.Global);
  await config.update('globalPrompt', nextSettings.globalPrompt, vscode.ConfigurationTarget.Global);
}

function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function getProjects(context: vscode.ExtensionContext): SolopreneurProject[] {
  const savedProjects = context.globalState.get<SolopreneurProject[]>(projectsKey) || [];
  const hiddenProjects = new Set(context.globalState.get<string[]>(hiddenProjectsKey) || []);
  const workspaceRoot = getWorkspaceRoot();
  const projects = [...savedProjects];

  if (workspaceRoot && !hiddenProjects.has(workspaceRoot) && !projects.some((project) => project.path === workspaceRoot)) {
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

async function setProjectHidden(context: vscode.ExtensionContext, projectPath: string, hidden: boolean): Promise<void> {
  const hiddenProjects = new Set(context.globalState.get<string[]>(hiddenProjectsKey) || []);
  if (hidden) {
    hiddenProjects.add(projectPath);
  } else {
    hiddenProjects.delete(projectPath);
  }
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
    '- `project_journal.db`：本地 SQLite 执行日志，保存更完整的 Agent 对话和历史记录。',
    '- `agent-runs/`：每次 Agent 调用的输出、文件变更摘要和完成判断。',
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
    '- 阅读 `.solopreneur/roadmap-methodology.md`，路线图必须覆盖其中定义的四层方法论。',
    '- 理解这个项目当前想做什么、面向谁、当前文件里已经有哪些线索。',
    '',
    '## 你的唯一交付物',
    '- 直接重写 `.solopreneur/roadmap.csv`。',
    '- 不要只在终端输出路线图建议。',
    '- 不要把本文件内容、提示词模板或解释性说明写回 CSV。',
    '',
    '## CSV 硬约束',
    '1. 保留 CSV 表头，字段顺序必须严格是：`id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`。',
    '2. 生成 4 到 6 个环节。',
    '3. 标题、描述、agentPrompt 全部使用中文。',
    '4. `stage` 只能使用：`问题与客户发现`、`产品与 MVP`、`营销与销售`、`反馈与规模化`。',
    `5. 每一行 \`agentCli\` 都写 \`${cliPath}\`。`,
    '6. `dependencies` 必须反映真实前置关系；第一步留空，后续按需要依赖前面环节的 id。',
    '7. `status` 全部写 `Pending`，`completedAt` 留空，`createdAt` 写当前 ISO 时间。',
    '8. 四个方法论阶段都必须至少出现一次：问题与客户发现、产品与 MVP、营销与销售、反馈与规模化。',
    '9. 每个 `agentPrompt` 都必须要求后续 Agent 直接创建或修改项目本地文件，并在适用时执行最窄验证命令。',
    '10. 不要生成空泛咨询任务；每个环节都必须有看得见的本地交付物。',
    '',
    '## 结束前自检',
    '- 重新读取 `.solopreneur/roadmap.csv`。',
    '- 确认列名、环节数量、stage 枚举、依赖关系都正确。',
    '- 确认 CSV 中没有残留“生成初始路线图”、本文件原文或提示词模板。'
  ].join('\n');
}

function buildRoadmapMethodologyInstructions(): string {
  return [
    '# SoloMap Roadmap Methodology',
    '',
    'SoloMap 路线图不是普通任务清单。它必须帮助独立开发者沿着一条完整的项目推进路径行动：',
    '',
    '```text',
    '发现问题 -> 打造产品 -> 卖给客户 -> 持续改进',
    '```',
    '',
    '## 必须覆盖的四个阶段',
    '',
    '1. `问题与客户发现`：明确值得解决的问题、目标用户、验证方式和第一步行动。',
    '2. `产品与 MVP`：把问题转成可运行、可验证的产品切片，包括需求、架构、数据、测试、部署或维护。',
    '3. `营销与销售`：让产品被发现、理解、信任并产生转化，包括品牌、官网、发布、销售或需求生成。',
    '4. `反馈与规模化`：建立 Build -> Sell -> Learn -> Improve 循环，包括数据、客户反馈、支持、单位经济模型或扩张机会。',
    '',
    '## 生成路线图时的判断标准',
    '',
    '- 不要只生成工程开发任务。',
    '- 不要只生成研究、分析、规划这类无本地交付物的任务。',
    '- 每个阶段至少有一个可执行环节。',
    '- 每个环节都必须能通过 Agent 对话推进，并产生本地文件、验证结果、市场材料或反馈记录。',
    '- 每个环节都必须能被完成标准判断：交付物是什么、证据在哪里、是否还需要下一轮推进。',
    '- 如果项目还没有代码，也要先产出项目文档、访谈问题、MVP 边界或发布材料等可提交文件。',
    '- 路线图应该让用户始终知道下一步，而不是让用户阅读一份静态计划。',
    '',
    '## 推荐循环',
    '',
    '```text',
    '项目想法 -> 方法论路线图 -> 下一步动作 -> Agent 对话 -> 本地交付 -> 状态闭环 -> 路线图更新',
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

function ensureCompletionCriteriaForNodes(workspaceRoot: string, nodes: RoadmapNode[]): RoadmapNode[] {
  if (!workspaceRoot) {
    return nodes;
  }
  return nodes.map((node) => {
    const filePath = getStepMemoryFilePath(workspaceRoot, node.id || '');
    const legacyFilePath = getLegacyStepMemoryFilePath(workspaceRoot, node.id || '');
    const memory = readStepMemoryObject(filePath);
    const existingCriteria = normalizeStringList(memory.completionCriteria);
    const completionCriteria = existingCriteria.length > 0 ? existingCriteria : buildCompletionCriteriaForNode(node);
    if (existingCriteria.length === 0) {
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

function normalizeSupplementFiles(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  const normalized = files
    .map((file) => String(file || '').trim())
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 10);
  return normalized;
}

function filterProjectRelativeFiles(workspaceRoot: string, files: string[]): string[] {
  return normalizeSupplementFiles(files).filter((relativePath) => {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relativeToRoot = path.relative(workspaceRoot, absolutePath);
    return Boolean(relativeToRoot)
      && !relativeToRoot.startsWith('..')
      && !path.isAbsolute(relativeToRoot)
      && fs.existsSync(absolutePath)
      && fs.statSync(absolutePath).isFile();
  });
}

async function chooseSupplementFilesForNode(nodeId: string): Promise<void> {
  if (!activeProjectRoot || !activePanel) {
    vscode.window.showErrorMessage('Choose a project folder before attaching task files.');
    return;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: 'Attach Files',
    defaultUri: vscode.Uri.file(activeProjectRoot)
  });

  const files = (selected || [])
    .map((uri) => {
      const absolutePath = uri.fsPath;
      const relativeToRoot = path.relative(activeProjectRoot as string, absolutePath);
      if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        return '';
      }
      return relativeToRoot.split(path.sep).join('/');
    })
    .filter(Boolean);

  activePanel.webview.postMessage({
    command: 'supplementFilesSelected',
    nodeId,
    files
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
    projects.push({
      name: projectName(folder),
      path: folder
    });
    await saveProjects(context, projects);
  }
  await setProjectHidden(context, folder, false);

  await context.globalState.update(selectedProjectKey, folder);
  syncEngine = null;
  activeProjectRoot = null;
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
  ensureRoadmapMethodologyInstructions(solopreneurDir);
  ensureBootstrapRoadmapInstructions(solopreneurDir, getPersistedSettings(context).cliPath || 'agy');

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
  try {
    await syncEngine.initAndSync();
    activeProjectRoot = projectRoot;
    ensureCompletionCriteriaForNodes(projectRoot, syncEngine.getNodes());
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
    'SoloMap: AI Roadmap & Agent Task Flow',
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
          await handleRunAgent(context, message.nodeId, message.userMessage || '', message.agentCli || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runRoadmapRevision':
          await handleRoadmapRevision(context, message.userMessage || '', message.agentCli || '');
          break;

        case 'chooseSupplementFiles':
          await chooseSupplementFilesForNode(message.nodeId);
          break;

        case 'retryConversation':
          await handleRetryConversation(context, message.nodeId, Number(message.conversationId || 0));
          break;

        case 'showAgentTerminal':
          showAgentTerminal();
          break;

        case 'continueNativeConversation':
          await handleContinueNativeConversation(context, message.nodeId, Number(message.conversationId || 0));
          break;

        case 'stopAgentRun':
          await stopAgentRun(message.nodeId, Number(message.conversationId || 0));
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
            cliPath: message.cliPath,
            language: message.language,
            globalPrompt: message.globalPrompt
          });
          vscode.window.showInformationMessage('SoloMap settings saved successfully!');
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

        case 'removeProject':
          await removeProject(context, message.projectPath);
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
  const nodes = syncEngine
    ? ensureCompletionCriteriaForNodes(activeProjectRoot || '', syncEngine.getNodes())
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

function resolveExecutablePath(command: string): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return '';
  }
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
    return trimmed;
  }
  const result = childProcess.spawnSync('bash', ['-lc', `command -v ${shellQuote(trimmed)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const resolved = String(result.stdout || '').trim().split('\n')[0];
  return resolved || trimmed;
}

function getAgentCliFamily(command: string): string {
  const name = path.basename((command || '').trim()).toLowerCase();
  if (['codex', 'codex-cli'].includes(name)) return 'codex';
  if (['claude', 'claude-code', 'claude-code-cli'].includes(name)) return 'claude';
  if (['opencode', 'open-code', 'open-code-cli'].includes(name)) return 'opencode';
  if (['', 'agy', 'antigravity', 'antigravity-cli'].includes(name)) return 'antigravity';
  return name;
}

function getKnownAgentCliCandidates(family: string): string[] {
  if (family === 'codex') return ['codex', 'codex-cli'];
  if (family === 'claude') return ['claude', 'claude-code', 'claude-code-cli'];
  if (family === 'opencode') return ['opencode', 'open-code', 'open-code-cli'];
  if (family === 'antigravity') return ['agy', 'antigravity', 'antigravity-cli'];
  return family ? [family] : [];
}

function getAgentCliCandidates(agentCli: string, configuredCliPath: string): string[] {
  const requestedCli = (agentCli || '').trim();
  const configuredCli = (configuredCliPath || '').trim();
  const requestedFamily = getAgentCliFamily(requestedCli);
  const configuredFamily = getAgentCliFamily(configuredCli);
  const preferredFamily = requestedCli ? requestedFamily : configuredFamily;
  const familyOrder = [
    preferredFamily,
    configuredFamily,
    requestedFamily,
    'antigravity',
    'codex',
    'claude',
    'opencode'
  ].filter(Boolean);
  const candidates = [
    configuredCli,
    requestedCli,
    ...familyOrder.flatMap(getKnownAgentCliCandidates)
  ];

  return candidates.filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function resolveAgentCli(agentCli: string, configuredCliPath: string): string {
  const candidates = getAgentCliCandidates(agentCli, configuredCliPath);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return resolveExecutablePath(candidate);
    }
  }

  return candidates[0] || 'agy';
}

function getAgentProvider(agentCli: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return 'codex';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return 'claude';
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return 'opencode';
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
    return `${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --add-dir=${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --add-dir ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run ${quotedPrompt})`;
  }

  return `${quotedCli} run --task ${quotedPrompt}`;
}

function buildAgentCommandForPromptFile(agentCli: string, promptFilePath: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPromptFile = shellQuote(promptFilePath);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check -`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --add-dir=${shellQuote(workspaceRoot)} @prompt-file:${quotedPromptFile}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --add-dir ${shellQuote(workspaceRoot)} "$(cat ${quotedPromptFile})"`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run "$(cat ${quotedPromptFile})")`;
  }

  return `${quotedCli} run --task @prompt-file:${quotedPromptFile}`;
}

function buildAgentCommandFromShellVar(agentCli: string, promptVarName: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const promptExpression = `"$${promptVarName}"`;

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `printf %s ${promptExpression} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check -`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --add-dir=${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --add-dir ${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `${quotedCli} run ${promptExpression}`;
  }

  return `${quotedCli} run --task ${promptExpression}`;
}

function buildNativeContinueCommand(agentCli: string, sessionId: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedSessionId = shellQuote(sessionId);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} resume -C ${shellQuote(workspaceRoot)} ${quotedSessionId}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --conversation ${quotedSessionId} --prompt-interactive --add-dir=${shellQuote(workspaceRoot)}`;
  }

  return `${quotedCli} ${quotedSessionId}`;
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
  if (content.startsWith('{')) {
    const memory = readStepMemoryObject(sourceFilePath);
    const entries = parseStepHandoffEntries(content);
    if (Object.keys(memory).length > 0) {
      return JSON.stringify({
        version: 1,
        format: String(memory.format || 'solopreneur.stepHandoff'),
        description: String(memory.description || 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.'),
        ...(
          normalizeStringList(memory.completionCriteria).length > 0
            ? { completionCriteria: normalizeStringList(memory.completionCriteria) }
            : {}
        ),
        ...(
          normalizeStringList(memory.lastCompletionEvidence).length > 0
            ? { lastCompletionEvidence: normalizeStringList(memory.lastCompletionEvidence) }
            : {}
        ),
        entries
      }, null, 2);
    }
  }
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
  const existingObject = readStepMemoryObject(filePath);
  const normalizedEntry = normalizeStepHandoffEntry(entry);
  const entries = normalizedEntry ? [normalizedEntry, ...parseStepHandoffEntries(existing)] : parseStepHandoffEntries(existing);
  const completionCriteria = normalizeStringList(existingObject.completionCriteria);
  const existingCompletionEvidence = normalizeStringList(existingObject.lastCompletionEvidence);
  const entryEvidence = normalizedEntry
    ? [
      ...normalizeStringList(normalizedEntry.changedFiles),
      String(normalizedEntry.completionReason || '').trim()
    ].filter(Boolean)
    : [];
  const lastCompletionEvidence = entryEvidence.length > 0
    ? [...entryEvidence, ...existingCompletionEvidence].filter((item, index, all) => all.indexOf(item) === index).slice(0, 8)
    : existingCompletionEvidence;
  const nextContent = JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.',
    ...(completionCriteria.length > 0 ? { completionCriteria } : {}),
    ...(lastCompletionEvidence.length > 0 ? { lastCompletionEvidence } : {}),
    entries: parseStepHandoffEntries(buildStepHandoffSummary(entries))
  }, null, 2).slice(0, 12000);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return nextContent;
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
  globalPrompt = ''
): string {
  const normalizedUserMessage = userMessage.trim();
  const normalizedGlobalPrompt = globalPrompt.trim();
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
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
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
  globalPrompt = ''
): string {
  const normalizedUserMessage = userMessage.trim();
  const globalPromptInstructions = globalPrompt.trim()
    ? [
      '用户设置的全局默认要求：',
      globalPrompt.trim(),
      '如与本次路线图调整要求冲突，始终以本次路线图调整要求为准。'
    ].join('\n')
    : '';
  return [
    '你正在 SoloMap 中调整当前项目路线图。',
    '本轮唯一交付物是根据用户的最新目标，直接更新项目目录中的 `.solopreneur/roadmap.csv`。',
    '',
    `项目目录：${workspaceRoot}`,
    '',
    '本次路线图调整要求（最高优先级）：',
    normalizedUserMessage,
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行要求：',
    '1. 先读取当前 `.solopreneur/roadmap.csv`、`.solopreneur/roadmap-methodology.md` 和项目已有文件，理解已经完成的工作与仍待推进的事项。',
    '2. 直接重写 `.solopreneur/roadmap.csv`，让后续环节反映本次调整要求；不要把本段提示词、解释文字或执行日志写进 CSV。',
    '3. 除非用户明确要求推翻已完成工作，否则保留已完成环节的事实和状态，并围绕新方向调整待推进环节、依赖与 Agent 任务。',
    '4. CSV 必须保留字段 `id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`；每个依赖必须指向存在的环节 ID，且不能自依赖。',
    '5. 路线图必须保持方法论覆盖：问题与客户发现、产品与 MVP、营销与销售、反馈与规模化四个阶段都至少出现一次，不能只剩工程任务。',
    '6. 完成后重新读取 CSV，确认每个环节都有明确标题、描述和可执行的 Agent 任务，再正常退出 CLI。'
  ].join('\n');
}

function buildAgentShellScript(
  agentCli: string,
  conversationPrompt: string,
  workspaceRoot: string,
  nodeId: string,
  executionLogId: number,
  userMessage: string,
  completionDecisionFilePath?: string,
  nativeSessionId = '',
  directExecutionCommand = '',
  runKind = 'step',
  roadmapBackupFilePath = ''
): { finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId);
  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');
  const outputFilePath = path.join(runDir, 'output.log');
  const commandFilePath = path.join(runDir, 'command.txt');
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runScriptPath = path.join(runDir, 'run-agent.sh');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const workspaceSnapshotPath = path.join(runDir, 'workspace-before.json');
  const startedAtFilePath = path.join(runDir, 'started_at');
  const sessionFilePath = path.join(runDir, 'session.json');
  const decisionFilePath = completionDecisionFilePath || path.join(runDir, 'completion.json');
  const agentProvider = getAgentProvider(agentCli);
  const sessionKey = getAgentSessionKey(agentCli);
  const sessionMode = nativeSessionId.trim() ? 'fresh-with-reference' : 'fresh';
  const startedAt = new Date().toISOString();
  const commandPreview = `${agentCli} [${sessionMode}]`;
  const loggedCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot);
  const executionCommand = directExecutionCommand || buildAgentCommandFromShellVar(agentCli, 'agent_prompt', workspaceRoot);
  const statusBase = { nodeId, runKind, roadmapBackupFilePath, agentCli, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode, startedAt };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_exit_failed', failureReason: 'Agent CLI exited before completing this task.' });
  const noChangesStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'no_deliverable_changes', failureReason: 'Agent exited without project file changes or a completion decision.' });
  const sessionCaptureScript = buildSessionCaptureScript(agentProvider, workspaceRoot, startedAtFilePath, outputFilePath, sessionFilePath);
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(workspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(workspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const terminalExecutionScript = [
    'export agent_prompt;',
    `(${executionCommand}) 2>&1 | tee ${shellQuote(outputFilePath)};`,
    'status=${PIPESTATUS[0]}'
  ].join(' ');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(promptFilePath, conversationPrompt, 'utf8');
  fs.writeFileSync(commandFilePath, loggedCommand, 'utf8');
  const script = [
    `cd ${shellQuote(workspaceRoot)}`,
    'export TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" FORCE_COLOR="${FORCE_COLOR:-1}"',
    `mkdir -p ${shellQuote(runDir)}`,
    `touch ${shellQuote(startedAtFilePath)}`,
    workspaceSnapshotScript,
    `printf %s ${shellQuote(JSON.stringify({ markCompleted: false }))} > ${shellQuote(decisionFilePath)}`,
    `printf %s ${shellQuote(runningStatus)} > ${shellQuote(statusFilePath)}`,
    `agent_prompt=$(cat ${shellQuote(promptFilePath)})`,
    terminalExecutionScript,
    sessionCaptureScript,
    `git -C ${shellQuote(workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `if [ $status -eq 0 ] && [ ! -s ${shellQuote(changesFilePath)} ] && [ ! -s ${shellQuote(touchedFilesPath)} ] && ! grep -q '"markCompleted"[[:space:]]*:[[:space:]]*true' ${shellQuote(decisionFilePath)} 2>/dev/null; then status=125; printf '\\nSoloMap: Agent exited without project file changes or a completion decision. Marking this run as failed so it can be retried.\\n' >> ${shellQuote(outputFilePath)}; printf %s ${shellQuote(noChangesStatus)} > ${shellQuote(statusFilePath)}; elif [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
  ].join('; ');
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

function getOutputTail(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .trim();
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
      title: '生成初始路线图',
      description: `基于当前项目文件和你对“${safePrompt}”的理解，直接重写 .solopreneur/roadmap.csv，生成这个项目真正要执行的定制化路线图。`,
      stage: '问题与客户发现',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md 和 .solopreneur/roadmap-methodology.md，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后按指令文件中的自检要求重新读取并校验该 CSV。',
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '2',
      title: '验证问题与目标客户',
      description: `把“${safePrompt}”整理成清晰的问题假设、目标用户、验证方式和第一版边界。`,
      stage: '问题与客户发现',
      dependencies: '1',
      agentCli: cliPath,
      agentPrompt: `为“${safePrompt}”创建 docs/problem-discovery.md，包含问题假设、目标用户、验证问题、MVP 边界、风险和下一步行动。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '3',
      title: '构建第一个可用切片',
      description: '把问题假设转成可运行、可验证的最小产品切片。',
      stage: '产品与 MVP',
      dependencies: '2',
      agentCli: cliPath,
      agentPrompt: `阅读 docs/problem-discovery.md，为“${safePrompt}”实现或规划第一个可用 MVP 切片，产出项目文件或 docs/mvp-slice.md，并记录最窄验证命令。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '4',
      title: '准备首轮市场触达',
      description: '把产品承诺转成品牌、官网、发布或销售材料，让潜在用户能理解并反馈。',
      stage: '营销与销售',
      dependencies: '3',
      agentCli: cliPath,
      agentPrompt: '基于当前产品切片创建 docs/launch-message.md，包含一句话定位、官网首屏文案、发布帖、首批触达渠道和用户反馈入口。',
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    },
    {
      id: '5',
      title: '建立反馈与改进循环',
      description: '把首轮反馈、数据和支持信号转成下一轮 Build -> Sell -> Learn -> Improve 动作。',
      stage: '反馈与规模化',
      dependencies: '4',
      agentCli: cliPath,
      agentPrompt: `基于当前文件，为“${safePrompt}”创建 docs/learning-loop.md，包含反馈收集方式、关键指标、支持信号、单位经济假设和下一轮改进任务。`,
      status: 'Pending',
      createdAt: now,
      completedAt: '',
    }
  ];
}

function postNodeConversations(nodeId: string): void {
  if (syncEngine && activePanel) {
    activePanel.webview.postMessage({
      command: 'nodeConversationsLoaded',
      nodeId,
      conversations: syncEngine.getAgentExecutions(nodeId),
      projectPath: activeProjectRoot || ''
    });
  }
}

function makeAgentTerminalName(label: string): string {
  agentTerminalCounter += 1;
  const cleanLabel = String(label || 'run').replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 40) || 'run';
  return `${agentTerminalBaseName} · ${cleanLabel} · ${agentTerminalCounter}`;
}

function findActiveAgentTerminal(): vscode.Terminal | undefined {
  const terminals = [...vscode.window.terminals];
  if (activeAgentTerminalName) {
    const active = terminals.find((candidate) => candidate.name === activeAgentTerminalName);
    if (active) {
      return active;
    }
  }
  return terminals.reverse().find((candidate) => candidate.name.startsWith(agentTerminalBaseName));
}

function createAgentTerminal(workspaceRoot: string, label: string): vscode.Terminal {
  const terminalName = makeAgentTerminalName(label);
  activeAgentTerminalName = terminalName;
  return vscode.window.createTerminal({
    name: terminalName,
    iconPath: new vscode.ThemeIcon('robot'),
    color: new vscode.ThemeColor('terminal.ansiCyan'),
    cwd: workspaceRoot,
  });
}

function showAgentTerminal(): void {
  const terminal = findActiveAgentTerminal();
  if (terminal) {
    terminal.show(true);
    return;
  }
  vscode.window.showInformationMessage('No active SoloMap Agent terminal is available.');
}

function extractNativeSessionIdFromExecutionOutput(output: string): string {
  const text = String(output || '');
  const match = text.match(/Native Agent session saved:[^\n]*\(([0-9a-fA-F-]{36})\)/);
  return match ? match[1] : '';
}

async function handleContinueNativeConversation(context: vscode.ExtensionContext, nodeId: string, conversationId: number): Promise<void> {
  void context;
  if (!syncEngine || !activeProjectRoot || !nodeId || !conversationId) {
    return;
  }

  if (hasRunningAgentConversation(activeProjectRoot, syncEngine.getNodes())) {
    vscode.window.showWarningMessage('Another Agent conversation is running. Open or stop it before continuing a native session.');
    return;
  }

  const conversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId));
  if (!conversation) {
    vscode.window.showErrorMessage(`Conversation ${conversationId} not found for step ${nodeId}.`);
    return;
  }

  const sessionId = extractNativeSessionIdFromExecutionOutput(conversation.output || '');
  if (!sessionId) {
    vscode.window.showInformationMessage('No native Agent session ID was recorded for this conversation.');
    return;
  }

  const agentCli = resolveAgentCli(conversation.agentCli || '', '');
  if (!commandExists(agentCli)) {
    vscode.window.showErrorMessage(`Agent CLI not found for native continuation: ${conversation.agentCli || agentCli}`);
    return;
  }

  const terminal = createAgentTerminal(activeProjectRoot, `native-${sessionId.slice(0, 8)}`);
  terminal.show(true);
  terminal.sendText(buildNativeContinueCommand(agentCli, sessionId, activeProjectRoot));
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

function hasRunningAgentConversation(workspaceRoot: string, nodes: RoadmapNode[]): boolean {
  if (nodes.some((candidate) => candidate.status === 'Running')) {
    return true;
  }
  if (syncEngine?.getAgentExecutions(roadmapRevisionId).some((conversation) => conversation.status === 'Running')) {
    return true;
  }
  const status = readAgentStatus(path.join(workspaceRoot, '.agent_status.json'));
  return Boolean(status && status.status === 'Running');
}

async function stopAgentRun(nodeId: string, conversationId: number): Promise<void> {
  if (!syncEngine || !activeProjectRoot || !nodeId) {
    return;
  }
  const statusFilePath = path.join(activeProjectRoot, '.agent_status.json');
  const runningStatus = readAgentStatus(statusFilePath);
  const conversation = syncEngine.getAgentExecutions(nodeId).find((entry) => Number(entry.id) === Number(conversationId));
  if (!conversation || conversation.status !== 'Running') {
    vscode.window.showInformationMessage('This Agent conversation is no longer running.');
    return;
  }

  const terminal = findActiveAgentTerminal();
  terminal?.dispose();
  const failureReason = 'Stopped by user.';
  const finishedAt = new Date().toISOString();
  if (runningStatus && runningStatus.nodeId === nodeId && Number(runningStatus.executionLogId) === Number(conversationId)) {
    if (runningStatus.outputFilePath) {
      fs.appendFileSync(runningStatus.outputFilePath, '\nSoloMap: Task stopped by user.\n', 'utf8');
    }
    fs.writeFileSync(statusFilePath, JSON.stringify({
      ...runningStatus,
      status: 'Failed',
      failureCode: 'stopped_by_user',
      failureReason,
      finishedAt
    }), 'utf8');
    await processAgentStatusFile(statusFilePath);
    return;
  }

  if (nodeId !== roadmapRevisionId) {
    syncEngine.updateNode(nodeId, { status: 'Failed', completedAt: '' });
  }
  syncEngine.updateAgentExecution(
    conversationId,
    conversation.agentCli,
    conversation.command,
    `${conversation.output}\n\nFailure category: stopped_by_user\n\nFailure reason:\n${failureReason}\n\nRun finished at: ${finishedAt}`,
    'Failed'
  );
  sendNodesToWebview();
  postNodeConversations(nodeId);
  vscode.window.showInformationMessage(`Agent task [${nodeId}] was stopped.`);
}

async function handleRoadmapRevision(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = ''): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const revisionRequest = userMessage.trim();
  if (!revisionRequest) {
    vscode.window.showWarningMessage('Describe how you want to adjust the roadmap before sending.');
    return;
  }
  const nodes = syncEngine.getNodes();
  if (hasRunningAgentConversation(activeProjectRoot, nodes)) {
    vscode.window.showWarningMessage('Another Agent conversation is running. Open or stop it before adjusting the roadmap.');
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

  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', 'roadmap-revision');
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  const conversationPrompt = buildRoadmapRevisionPrompt(revisionRequest, activeProjectRoot, settings.globalPrompt);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, activeProjectRoot);
  const executionLogId = syncEngine.logAgentExecution(
    roadmapRevisionId,
    agentCli,
    agentCommand,
    [
      'Roadmap revision started.',
      `Run started at: ${new Date().toISOString()}`,
      `User supplement:\n${revisionRequest}`
    ].join('\n\n'),
    'Running'
  );
  postNodeConversations(roadmapRevisionId);

  const { finalCommand } = buildAgentShellScript(
    agentCli,
    conversationPrompt,
    activeProjectRoot,
    roadmapRevisionId,
    executionLogId,
    revisionRequest,
    undefined,
    '',
    '',
    'roadmap_revision',
    roadmapBackupFilePath
  );
  const terminal = createAgentTerminal(activeProjectRoot, `revision-${executionLogId}`);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(context: vscode.ExtensionContext, nodeId: string, userMessage: string, selectedAgentCli = '', supplementFiles: string[] = []) {
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
  if (hasRunningAgentConversation(workspaceRoot, nodes)) {
    vscode.window.showWarningMessage('Another Agent conversation is running. Open or stop it before starting a new one.');
    return;
  }

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

  // Update node status to Running
  syncEngine.updateNode(nodeId, { status: 'Running' });
  sendNodesToWebview();

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
    nativeSessionId,
    attachedFiles,
    settings.globalPrompt
  );
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot);

  const launchSummary = [
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
    agentCommand,
    launchSummary,
    'Running'
  );
  postNodeConversations(nodeId);

  const { finalCommand } = buildAgentShellScript(agentCli, conversationPrompt, workspaceRoot, nodeId, executionLogId, userMessage.trim(), completionDecisionFilePath, nativeSessionId);

  const terminal = createAgentTerminal(workspaceRoot, `step-${nodeId}-${executionLogId}`);
  terminal.show(true);
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
  if (nodeId === roadmapRevisionId) {
    await handleRoadmapRevision(context, retryUserMessage, conversation.agentCli || '');
    return;
  }
  await handleRunAgent(context, nodeId, retryUserMessage, conversation.agentCli || '');
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
    const requiredMethodologyStages = ['问题与客户发现', '产品与 MVP', '营销与销售', '反馈与规模化'];
    const validStages = new Set(requiredMethodologyStages);
    const bootstrapMarkers = [
      '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
      '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
      '保留 CSV 表头且字段顺序必须严格是',
      '生成初始路线图',
      '.solopreneur/bootstrap-roadmap-instructions.md',
      '不要把本文件内容、提示词模板或解释性说明写回 CSV'
    ];

    if (parsed.errors.length > 0) {
      return { valid: false, reason: '生成后的 roadmap.csv 仍然无法被稳定解析。' };
    }
    if (nodes.length < 4 || nodes.length > 6) {
      return { valid: false, reason: '生成后的路线图环节数量不在 4 到 6 个之间。' };
    }
    if (nodes.some((node) => !node.title || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '生成后的路线图存在缺少标题、描述或 agentPrompt 的环节。' };
    }
    if (nodes.some((node) => !validStages.has(node.stage))) {
      return { valid: false, reason: '生成后的路线图存在非法 stage 值。' };
    }
    const presentStages = new Set(nodes.map((node) => node.stage));
    const missingStages = requiredMethodologyStages.filter((stage) => !presentStages.has(stage));
    if (missingStages.length > 0) {
      return { valid: false, reason: `生成后的路线图缺少方法论阶段：${missingStages.join('、')}。` };
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
    const requiredMethodologyStages = ['问题与客户发现', '产品与 MVP', '营销与销售', '反馈与规模化'];
    const presentStages = new Set(nodes.map((node) => String(node.stage || '').trim()));
    const missingStages = requiredMethodologyStages.filter((stage) => !presentStages.has(stage));
    if (missingStages.length > 0) {
      return { valid: false, reason: `调整后的路线图缺少方法论阶段：${missingStages.join('、')}。` };
    }
    const ids = nodes.map((node) => node.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      return { valid: false, reason: '调整后的路线图存在重复环节 ID。' };
    }
    if (nodes.some((node) => !node.title || !node.description || !node.agentPrompt)) {
      return { valid: false, reason: '调整后的路线图存在缺少标题、描述或 Agent 任务的环节。' };
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
    const { nodeId, runKind, roadmapBackupFilePath, status, agentCli, command, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath, sessionFilePath, sessionMode, startedAt } = statusData;

    if (!nodeId || !status || status === 'Running' || !syncEngine) {
      return;
    }

    let nextStatus = status as RoadmapNode['status'];
    let completionReason = '';
    let failureCode = String(statusData.failureCode || '').trim();
    let failureReason = String(statusData.failureReason || '').trim();
    const currentNode = syncEngine.getNodes().find((candidate) => candidate.id === nodeId) || null;
    if (status === 'In Progress' && completionDecisionFilePath && fs.existsSync(completionDecisionFilePath)) {
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
    const workspaceRoot = activeProjectRoot || (statusFilePath ? path.dirname(statusFilePath) : '');
    const roadmapCsvChanged = didRoadmapCsvChange(changedFilesSummary, touchedFilesSummary);
    // Preserve an explicit user completion if an in-flight Agent run reports back afterward.
    let shouldWriteNodeStatus = currentNode?.status !== 'Completed';
    let shouldRefreshRoadmap = false;
    if (workspaceRoot && runKind === 'roadmap_revision') {
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
    if (shouldWriteNodeStatus) {
      const completedAt = nextStatus === 'Completed' ? new Date().toISOString() : '';
      syncEngine.updateNode(nodeId, {
        status: nextStatus,
        completedAt,
      });
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
    const handoffEntry = workspaceRoot && runKind !== 'roadmap_revision'
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
      startedAt ? `Run started at: ${startedAt}` : '',
      `Run finished at: ${finishedAt}`,
      startedAt ? `Run duration ms: ${runDurationMs}` : '',
      failureCode ? `Failure category: ${failureCode}` : '',
      failureReason ? `Failure reason:\n${failureReason}` : '',
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

    if (workspaceRoot && shouldRefreshRoadmap) {
      await syncEngine.initAndSync();
    }

    sendNodesToWebview();
    postNodeConversations(nodeId);
    if (nextStatus === 'Completed' && !hasRecordedWorkspaceChanges(changedFilesSummary, touchedFilesSummary)) {
      vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
    } else {
      vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${nextStatus}`);
    }

    setTimeout(() => {
      const currentStatus = readAgentStatus(statusFilePath);
      const belongsToProcessedRun = currentStatus
        && Number(currentStatus.executionLogId || 0) === Number(executionLogId || 0)
        && String(currentStatus.status || '') === String(status || '');
      if (belongsToProcessedRun && fs.existsSync(statusFilePath)) {
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

  const handleSentinelChange = () => {
    void processAgentStatusFile(statusFilePath);
  };
  watcher.onDidChange(handleSentinelChange);
  watcher.onDidCreate(handleSentinelChange);
  statusPoller = setInterval(handleSentinelChange, 2000);
  handleSentinelChange();
}

/**
 * Formulates the premium glassmorphic Webview page bundle.
 */
function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // In MVP, we embed a fully functional React + CSS app direct inside the iframe
  // which uses modern styling guidelines (glassmorphism, glowing connections, inter font).
  const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously (Prevent network blocks on slow connections) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
  <link rel="stylesheet" href="${codiconsUri}">
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

    * {
      box-sizing: border-box;
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
      gap: 16px;
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
      min-width: 0;
    }

    .project-select {
      width: clamp(150px, 18vw, 240px);
      min-width: 0;
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

    .btn-project-remove {
      background: rgba(255, 23, 68, 0.10);
      color: #ffe1e8;
      border: 1px solid rgba(255, 23, 68, 0.22);
      padding: 8px 10px;
      min-width: 34px;
    }

    .btn-project-remove:hover {
      box-shadow: 0 4px 15px rgba(255, 23, 68, 0.28);
      background: rgba(255, 23, 68, 0.18);
    }

    .btn-roadmap-revision {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .btn-roadmap-revision:hover,
    .btn-roadmap-revision.active {
      background: #00e5ff;
      border-color: #00e5ff;
      color: #000;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
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

    .codicon {
      font-size: 16px;
      line-height: 1;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
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
      padding: clamp(18px, 4vw, 40px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 30px;
    }

    .roadmap-revision-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .roadmap-revision-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .roadmap-revision-body .conversation-composer {
      margin-top: 0;
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
      max-width: min(920px, 100%);
      min-width: 0;
      z-index: 2;
    }

    .node-card {
      width: 100%;
      min-width: 0;
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
      min-width: 0;
    }

    .node-summary {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
      min-width: 0;
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
      min-width: 0;
      max-width: 100%;
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

    .completion-criteria {
      margin-top: 8px;
      background: rgba(0, 229, 255, 0.06);
      border: 1px solid rgba(0, 229, 255, 0.16);
      border-radius: 8px;
      padding: 9px 10px;
    }

    .completion-criteria-title {
      font-size: 11px;
      font-weight: 800;
      color: #67e8f9;
      margin-bottom: 6px;
    }

    .completion-criteria-list {
      margin: 0;
      padding-left: 18px;
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.45;
    }

    .completion-criteria-list li + li {
      margin-top: 4px;
    }

    .node-actions {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
      flex-shrink: 0;
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

    .conversation-panel {
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-composer {
      background: rgba(0, 0, 0, 0.20);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .conversation-compose {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .conversation-compose input {
      flex: 1;
      width: auto;
      min-width: 0;
    }

    .conversation-tool-btn {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .conversation-tool-btn:hover {
      color: #000;
      background: #00e5ff;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
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
      flex-shrink: 0;
    }

    .btn-send-conversation {
      min-width: 42px;
      height: 34px;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }

    .conversation-compose input:disabled,
    .conversation-agent-select:disabled,
    .btn-send-conversation:disabled,
    .conversation-tool-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .conversation-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .conversation-attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 4px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      font-size: 11px;
    }

    .conversation-attachment-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(360px, 48vw);
    }

    .conversation-attachment-remove {
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.10);
      color: var(--text-main);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
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
      min-width: 0;
      max-width: 100%;
    }

    .conversation-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
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
      flex: 1 1 auto;
    }

    .conversation-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
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

    .conversation-control-btn {
      background: rgba(56, 189, 248, 0.10);
      border: 1px solid rgba(56, 189, 248, 0.28);
      color: #d7f3ff;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-control-btn.stop {
      background: rgba(255, 23, 68, 0.10);
      border-color: rgba(255, 23, 68, 0.32);
      color: #ffd7df;
    }

    .conversation-control-btn:hover {
      background: rgba(56, 189, 248, 0.20);
    }

    .conversation-control-btn.stop:hover {
      background: rgba(255, 23, 68, 0.20);
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

    .conversation-runtime {
      color: #38bdf8;
      font-size: 11px;
    }

    .conversation-summary {
      color: var(--text-main);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }

    .conversation-detail {
      border-top: 1px solid var(--border-glass);
      padding: 10px;
      color: var(--text-muted);
      font-size: 12px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-outcome {
      margin: 0 0 10px;
      padding: 8px 9px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.08);
      color: var(--text-main);
      line-height: 1.45;
    }

    .conversation-outcome.failed {
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .conversation-detail pre {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-height: 260px;
      overflow: auto;
      margin: 6px 0 0;
      font-size: 11px;
      color: #cbd5e1;
      max-width: 100%;
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
      max-height: calc(100vh - 110px);
      overflow-y: auto;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .roadmap-revision-popover {
      position: absolute;
      top: 75px;
      right: 68px;
      width: clamp(340px, 42vw, 560px);
      max-width: calc(100vw - 32px);
      background: rgba(15, 17, 26, 0.96);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 14px;
      z-index: 100;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.52);
      display: none;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 110px);
      overflow-y: auto;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .roadmap-revision-popover.open {
      display: flex;
    }

    .roadmap-revision-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .roadmap-revision-header h3 {
      margin: 0;
      font-size: 14px;
      color: #00e5ff;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .btn-close-revision {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .btn-close-revision:hover {
      color: #ff1744;
      box-shadow: none;
      transform: none;
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

    .settings-textarea {
      min-height: 76px;
      resize: vertical;
      line-height: 1.45;
    }

    .settings-input:focus, .settings-select:focus, .settings-textarea:focus {
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
      padding: 4px;
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      flex-shrink: 0;
    }

    .btn-gear:hover {
      color: #00e5ff;
      transform: rotate(30deg) scale(1.1);
    }

    @media (max-width: 720px) {
      header {
        padding: 12px 14px;
        flex-wrap: wrap;
        align-items: flex-start;
      }

      .controls {
        width: 100%;
        gap: 8px;
        justify-content: flex-end;
      }

      .project-select {
        flex: 1 1 160px;
        width: auto;
      }

      .roadmap-canvas {
        padding: 18px 12px;
        gap: 22px;
      }

      .node-summary,
      .conversation-row {
        flex-direction: column;
        align-items: stretch;
      }

      .node-actions {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .conversation-compose {
        flex-wrap: wrap;
      }

      .conversation-compose input {
        flex: 1 1 100%;
      }

      .conversation-agent-select {
        flex: 1 1 160px;
        width: auto;
      }

      .btn-send-conversation {
        flex: 0 0 42px;
      }

      .conversation-actions {
        justify-content: flex-start;
      }

      .settings-overlay,
      .roadmap-revision-popover {
        top: 118px;
        left: 12px;
        right: 12px;
        width: auto;
        max-width: none;
      }
    }

    @media (max-width: 430px) {
      h1 {
        font-size: 18px;
      }

      .controls {
        justify-content: flex-start;
      }

      .btn-project-add,
      .btn-project-remove,
      .btn-roadmap-revision {
        width: 34px;
        min-width: 34px;
      }

      .node-card {
        padding: 16px;
      }

      .node-title {
        font-size: 14px;
      }

      .status-badge,
      .btn-run {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <h1 class="brand-title"><span class="codicon codicon-map"></span><span id="app-title">SoloMap</span></h1>
      <div class="controls">
        <select class="project-select" id="project-select"></select>
        <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
        <button class="btn-project-remove" id="btn-remove-project" title="Remove project"><span class="codicon codicon-trash"></span></button>
        <button class="btn-roadmap-revision" id="btn-toggle-roadmap-revision" title="Revise Roadmap"><span class="codicon codicon-git-compare"></span></button>
        <button class="btn-gear" id="btn-toggle-settings" title="SoloMap Settings"><span class="codicon codicon-settings-gear"></span></button>
      </div>
    </header>

    <div class="roadmap-canvas" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>
  </div>

  <div class="roadmap-revision-popover" id="roadmap-revision-panel">
    <div class="roadmap-revision-header">
      <h3><span class="codicon codicon-git-compare"></span><span id="roadmap-revision-title">Revise Roadmap</span></h3>
      <button class="btn-close-revision" id="btn-close-roadmap-revision" title="Close"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="roadmap-revision-body" id="roadmap-revision-body"></div>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-settings-gear"></span> <span id="settings-title">SoloMap Settings</span></h3>
      <button class="btn-close-settings" id="btn-close-settings"><span class="codicon codicon-close"></span></button>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-language">Language</label>
      <select class="settings-select" id="setting-language">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. agy, codex, claude, opencode">
      <div id="help-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code>, <code>codex</code>, <code>claude</code>, <code>opencode</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-prompt">Default Agent Instructions</label>
      <textarea class="settings-input settings-textarea" id="setting-global-prompt" placeholder="e.g. Always keep changes minimal and run the narrowest relevant test."></textarea>
      <div id="help-global-prompt" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Injected into every task conversation. Instructions added in a step conversation take priority.
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli"><span class="codicon codicon-debug-start"></span><span id="text-test-cli">Test CLI</span></button>
      <button class="settings-action-btn save-btn" id="btn-save-settings"><span class="codicon codicon-save"></span><span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const projectSelect = document.getElementById('project-select');
    const btnAddProject = document.getElementById('btn-add-project');
    const btnRemoveProject = document.getElementById('btn-remove-project');
    const btnToggleRoadmapRevision = document.getElementById('btn-toggle-roadmap-revision');
    const btnCloseRoadmapRevision = document.getElementById('btn-close-roadmap-revision');
    const roadmapRevisionPanel = document.getElementById('roadmap-revision-panel');
    const roadmapRevisionBody = document.getElementById('roadmap-revision-body');

    // Settings Panel elements
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliPath = document.getElementById('setting-clipath');
    const settingLanguage = document.getElementById('setting-language');
    const settingGlobalPrompt = document.getElementById('setting-global-prompt');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let expandedNodeId = '';
    let activeConversationId = '';
    let activeProjectPath = '';
    let currentCliPath = 'agy';
    const roadmapRevisionId = '__roadmap_revision__';
    let roadmapRevisionExpanded = false;
    const nodeConversations = {};
    const nodeSupplementFiles = {};
    const i18n = {
      zh: {
        title: 'SoloMap',
        addProject: '添加项目文件夹',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        removeProject: '删除项目',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、claude、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。请添加项目文件夹，或重新打开当前项目。',
        startConversation: '发起 Agent 对话',
        conversationHistory: 'Agent 对话历史',
        noConversations: '这个环节还没有 Agent 对话。',
        conversationPlaceholder: '补充这次要 Agent 注意的要求...',
        agentSelector: '选择 Agent',
        attachFiles: '选择补充文件',
        attachedFiles: '补充文件',
        removeAttachment: '移除',
        send: '发送',
        retry: '重试',
        continueNative: '继续',
        openTerminal: '打开终端',
        stopRun: '停止',
        elapsed: '已运行',
        duration: '耗时',
        runResult: '本轮结果',
        stillWorking: 'Agent 正在执行这次对话。',
        awaitingNextConversation: '本轮已结束，环节仍可继续推进。',
        stepCompleted: 'Agent 判断该环节已完成。',
        changedCount: '本轮修改文件数',
        agentConclusion: 'Agent 结论',
        failureLabel: '失败原因',
        completionCriteria: '完成标准',
        completeConfirm: '确认这个环节已经达到以下完成标准？',
        failureCategories: {
          cli_not_found: '未找到所选 Agent CLI。',
          stopped_by_user: '任务已由用户停止。',
          no_deliverable_changes: 'Agent 已退出，但没有检测到文件修改或完成判断。',
          roadmap_validation_failed: '生成的路线图未通过结构校验。',
          roadmap_not_updated: 'Agent 未更新路线图，原路线图保持不变。',
          completion_state_invalid: 'Agent 返回的完成状态无法读取。',
          agent_exit_failed: 'Agent CLI 在交付任务前退出。'
        },
        command: '命令',
        output: '输出',
        changedFiles: '修改文件',
        openFile: '打开',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        markComplete: '完成环节',
        reviseRoadmap: '调整路线图',
        reviseRoadmapPlaceholder: '描述目标、优先级或方向发生了什么变化...',
        revisionHistory: '路线图调整历史',
        noRevisionConversations: '还没有路线图调整记录。',
        sendRevision: '发送调整',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败' }
      },
      en: {
        title: 'SoloMap',
        addProject: 'Add project folder',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        removeProject: 'Remove project',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, claude, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; guidance in the current conversation takes priority.',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Add a project folder or reopen the current project.',
        startConversation: 'Start Agent Conversation',
        conversationHistory: 'Agent Conversation History',
        noConversations: 'No Agent conversations for this step yet.',
        conversationPlaceholder: 'Add guidance for this Agent run...',
        agentSelector: 'Choose Agent',
        attachFiles: 'Attach files',
        attachedFiles: 'Attached files',
        removeAttachment: 'Remove',
        send: 'Send',
        retry: 'Retry',
        continueNative: 'Continue',
        openTerminal: 'Open terminal',
        stopRun: 'Stop',
        elapsed: 'Elapsed',
        duration: 'Duration',
        runResult: 'Run result',
        stillWorking: 'The Agent is running this conversation.',
        awaitingNextConversation: 'This run ended; the step can continue.',
        stepCompleted: 'The Agent marked this step complete.',
        changedCount: 'Files changed in this run',
        agentConclusion: 'Agent conclusion',
        failureLabel: 'Failure reason',
        completionCriteria: 'Completion criteria',
        completeConfirm: 'Confirm this step has met these completion criteria?',
        failureCategories: {
          cli_not_found: 'The selected Agent CLI was not found.',
          stopped_by_user: 'The task was stopped by the user.',
          no_deliverable_changes: 'The Agent exited without detected file changes or a completion decision.',
          roadmap_validation_failed: 'The generated roadmap failed structure validation.',
          roadmap_not_updated: 'The Agent did not update the roadmap; the previous roadmap was kept.',
          completion_state_invalid: 'The Agent completion state could not be read.',
          agent_exit_failed: 'The Agent CLI exited before delivering the task.'
        },
        command: 'Command',
        output: 'Output',
        changedFiles: 'Changed Files',
        openFile: 'Open',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        markComplete: 'Complete Step',
        reviseRoadmap: 'Revise Roadmap',
        reviseRoadmapPlaceholder: 'Describe what changed in your goal, priority, or direction...',
        revisionHistory: 'Roadmap Revision History',
        noRevisionConversations: 'No roadmap revisions yet.',
        sendRevision: 'Send revision',
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

    function failureCategoryText(category) {
      return (i18n[currentLanguage].failureCategories || {})[category] || '';
    }

    function extractNativeSessionId(output) {
      const match = String(output || '').match(/Native Agent session saved:[^\\n]*\\(([0-9a-fA-F-]{36})\\)/);
      return match ? match[1] : '';
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function resetProjectScopedState(projectPath, clearNodes) {
      activeProjectPath = projectPath || '';
      expandedNodeId = '';
      roadmapRevisionExpanded = false;
      activeConversationId = '';
      if (roadmapRevisionPanel) roadmapRevisionPanel.classList.remove('open');
      if (btnToggleRoadmapRevision) btnToggleRoadmapRevision.classList.remove('active');
      if (roadmapRevisionBody) roadmapRevisionBody.innerHTML = '';
      Object.keys(nodeConversations).forEach(key => delete nodeConversations[key]);
      Object.keys(nodeSupplementFiles).forEach(key => delete nodeSupplementFiles[key]);
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      btnAddProject.title = t('addProject');
      btnRemoveProject.title = t('removeProject');
      btnToggleRoadmapRevision.title = t('reviseRoadmap');
      setText('settings-title', t('settingsTitle'));
      setText('roadmap-revision-title', t('reviseRoadmap'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-global-prompt', t('globalPrompt'));
      settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderRoadmap(currentNodes);
      renderRoadmapRevisionPanel(currentNodes);
    }

    const currentProjects = { projects: [], selectedProjectPath: '' };

    // Toggle Settings panel visibility
    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'flex') {
        settingsPanel.style.display = 'none';
      } else {
        roadmapRevisionExpanded = false;
        roadmapRevisionPanel.classList.remove('open');
        btnToggleRoadmapRevision.classList.remove('active');
        settingsPanel.style.display = 'flex';
        vscode.postMessage({ command: 'getSettings' });
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    btnToggleRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = !roadmapRevisionExpanded;
      activeConversationId = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (roadmapRevisionExpanded) {
        settingsPanel.style.display = 'none';
        cliTestBadge.style.display = 'none';
        if (!nodeConversations[roadmapRevisionId]) {
          vscode.postMessage({ command: 'getNodeConversations', nodeId: roadmapRevisionId });
        }
      }
      renderRoadmapRevisionPanel(currentNodes);
    });

    btnCloseRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = false;
      activeConversationId = '';
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      renderRoadmapRevisionPanel(currentNodes);
    });

    settingLanguage.addEventListener('change', () => {
      currentLanguage = settingLanguage.value;
      applyLanguage();
    });

    // Request nodes and settings on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });
    vscode.postMessage({ command: 'getProjects' });
    if (typeof setInterval === 'function') {
      setInterval(() => {
        if (expandedNodeId && currentNodes.some(node => node.status === 'Running')) {
          renderRoadmap(currentNodes);
        }
        const revisionRunning = (nodeConversations[roadmapRevisionId] || [])
          .some(conversation => conversation.status === 'Running');
        if (roadmapRevisionExpanded && revisionRunning) {
          renderRoadmapRevisionPanel(currentNodes);
        }
      }, 1000);
    }

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
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'settingsLoaded':
          settingCliPath.value = message.settings.cliPath || 'agy';
          settingGlobalPrompt.value = message.settings.globalPrompt || '';
          currentCliPath = settingCliPath.value || 'agy';
          settingLanguage.value = message.settings.language || 'zh';
          currentLanguage = settingLanguage.value;
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
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'supplementFilesSelected':
          nodeSupplementFiles[message.nodeId] = mergeSupplementFiles(
            nodeSupplementFiles[message.nodeId] || [],
            message.files || []
          );
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
        cliPath: settingCliPath.value.trim(),
        language: settingLanguage.value,
        globalPrompt: settingGlobalPrompt.value.trim()
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

    btnRemoveProject.addEventListener('click', () => {
      if (!projectSelect.value) return;
      vscode.postMessage({ command: 'removeProject', projectPath: projectSelect.value });
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

    function getCompletionCriteria(node) {
      const criteria = Array.isArray(node.completionCriteria)
        ? node.completionCriteria.map(item => String(item || '').trim()).filter(Boolean)
        : [];
      if (criteria.length > 0) return criteria;
      return [node.description || node.agentPrompt || ''];
    }

    function renderCompletionCriteria(node) {
      const criteria = getCompletionCriteria(node).filter(Boolean);
      if (!criteria.length) return '';
      return \`
        <div class="completion-criteria" data-completion-criteria-id="\${escapeHtml(node.id)}">
          <div class="completion-criteria-title">\${escapeHtml(t('completionCriteria'))}</div>
          <ol class="completion-criteria-list">
            \${criteria.map(item => \`<li>\${escapeHtml(item)}</li>\`).join('')}
          </ol>
        </div>
      \`;
    }

    function confirmStepCompletion(node) {
      const criteriaText = getCompletionCriteria(node)
        .filter(Boolean)
        .map((item, index) => (index + 1) + '. ' + item)
        .join('\\n');
      return confirm(t('completeConfirm') + (criteriaText ? '\\n\\n' + criteriaText : ''));
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
        const supplementFiles = nodeSupplementFiles[node.id] || [];
        const conversationDisabled = node.status === 'Running' ? 'disabled' : '';
        const promptHtml = expanded ? \`
          <div class="node-expanded-body">
            <div class="node-desc">\${escapeHtml(node.description)}</div>
            <div class="node-agent-prompt">
              <strong>\${escapeHtml(node.agentCli)}:</strong> \${escapeHtml(node.agentPrompt)}
            </div>
            \${renderCompletionCriteria(node)}
            <div class="conversation-composer">
              <div class="conversation-compose">
                <button class="conversation-tool-btn" data-attach-node-id="\${escapeHtml(node.id)}" title="\${t('attachFiles')}" \${conversationDisabled}>
                  <span class="codicon codicon-attach"></span>
                </button>
                <input type="text" class="conversation-input" data-conversation-input-id="\${escapeHtml(node.id)}" placeholder="\${t('conversationPlaceholder')}" \${conversationDisabled}>
                <select class="conversation-agent-select" data-agent-select-id="\${escapeHtml(node.id)}" title="\${t('agentSelector')}" \${conversationDisabled}>
                  \${renderAgentOptions(node)}
                </select>
                <button class="btn-send-conversation" data-send-node-id="\${escapeHtml(node.id)}" title="\${t('send')}" \${conversationDisabled}>
                  <span class="codicon codicon-send"></span>
                </button>
              </div>
              \${renderSupplementFiles(node.id, supplementFiles)}
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
            triggerRun(node.id, input ? input.value : '', agentSelect ? agentSelect.value : '', nodeSupplementFiles[node.id] || []);
            if (input) input.value = '';
            nodeSupplementFiles[node.id] = [];
            renderRoadmap(currentNodes);
          });
        }
        row.querySelectorAll('[data-attach-node-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: node.id });
          });
        });
        row.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const file = item.getAttribute('data-remove-supplement-file');
            nodeSupplementFiles[node.id] = (nodeSupplementFiles[node.id] || []).filter(candidate => candidate !== file);
            renderRoadmap(currentNodes);
          });
        });
        const completeButton = row.querySelector('[data-complete-node-id]');
        if (completeButton) {
          completeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (confirmStepCompletion(node)) {
              vscode.postMessage({ command: 'completeNode', nodeId: node.id });
            }
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
        row.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'showAgentTerminal' });
          });
        });
        row.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'continueNativeConversation',
              nodeId: node.id,
              conversationId: item.getAttribute('data-continue-native-conversation-id')
            });
          });
        });
        row.querySelectorAll('[data-stop-agent-run]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'stopAgentRun',
              nodeId: node.id,
              conversationId: item.getAttribute('data-stop-agent-run')
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

    function renderRoadmapRevisionPanel(nodes) {
      if (!roadmapRevisionPanel || !roadmapRevisionBody) {
        return;
      }
      const conversations = nodeConversations[roadmapRevisionId] || [];
      const revisionRunning = conversations.some(conversation => conversation.status === 'Running')
        || (nodes || []).some(node => node.status === 'Running');
      const disabled = revisionRunning ? 'disabled' : '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (!roadmapRevisionExpanded) {
        roadmapRevisionBody.innerHTML = '';
        return;
      }
      roadmapRevisionBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose">
            <input type="text" class="conversation-input" data-roadmap-revision-input placeholder="\${escapeHtml(t('reviseRoadmapPlaceholder'))}" \${disabled}>
            <select class="conversation-agent-select" data-roadmap-revision-agent title="\${escapeHtml(t('agentSelector'))}" \${disabled}>
              \${renderAgentOptions({ agentCli: currentCliPath || 'agy' })}
            </select>
            <button class="btn-send-conversation" data-send-roadmap-revision title="\${escapeHtml(t('sendRevision'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('revisionHistory'))}</div>
          \${renderConversations(roadmapRevisionId, conversations, t('noRevisionConversations'))}
        </div>
      \`;
      const sendButton = roadmapRevisionBody.querySelector('[data-send-roadmap-revision]');
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
          const agentSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-agent]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'runRoadmapRevision',
            userMessage: request,
            agentCli: agentSelect ? agentSelect.value : ''
          });
          input.value = '';
        });
      }
      bindConversationActions(roadmapRevisionBody, roadmapRevisionId);
    }

    function bindConversationActions(container, nodeId) {
      container.querySelectorAll('[data-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          activeConversationId = activeConversationId === item.getAttribute('data-conversation-id')
            ? ''
            : item.getAttribute('data-conversation-id');
          renderRoadmap(currentNodes);
          if (nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
          }
        });
      });
      container.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'retryConversation',
            nodeId,
            conversationId: item.getAttribute('data-retry-conversation-id')
          });
        });
      });
      container.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'showAgentTerminal' });
        });
      });
      container.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'continueNativeConversation',
            nodeId,
            conversationId: item.getAttribute('data-continue-native-conversation-id')
          });
        });
      });
      container.querySelectorAll('[data-stop-agent-run]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'stopAgentRun',
            nodeId,
            conversationId: item.getAttribute('data-stop-agent-run')
          });
        });
      });
      container.querySelectorAll('[data-open-file-path]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const relativePath = item.getAttribute('data-open-file-path');
          if (relativePath) {
            vscode.postMessage({ command: 'openProjectFile', relativePath });
          }
        });
      });
    }

    function renderConversations(nodeId, conversations, emptyLabel = t('noConversations')) {
      if (!conversations || conversations.length === 0) {
        return '<div class="conversation-empty">' + escapeHtml(emptyLabel) + '</div>';
      }

      const items = conversations.map(conversation => {
        const conversationId = nodeId + ':' + conversation.id;
        const open = activeConversationId === conversationId;
        const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
        const summary = summarizeConversation(conversation);
        const duration = formatConversationDuration(conversation);
        const runtimeLabel = duration
          ? (conversation.status === 'Running' ? t('elapsed') : t('duration')) + ': ' + duration
          : '';
        const retryButton = conversation.status === 'Failed'
          ? \`<button class="conversation-retry-btn" data-retry-conversation-id="\${escapeHtml(conversation.id)}">\${t('retry')}</button>\`
          : '';
        const continueButton = conversation.status !== 'Running' && extractNativeSessionId(conversation.output)
          ? \`<button class="conversation-control-btn" data-continue-native-conversation-id="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('continueNative'))}">\${t('continueNative')}</button>\`
          : '';
        const runningButtons = conversation.status === 'Running'
          ? \`
            <button class="conversation-control-btn" data-show-agent-terminal title="\${escapeHtml(t('openTerminal'))}">\${t('openTerminal')}</button>
            <button class="conversation-control-btn stop" data-stop-agent-run="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('stopRun'))}">\${t('stopRun')}</button>
          \`
          : '';
        return \`
          <div class="conversation-item" data-conversation-id="\${escapeHtml(conversationId)}">
            <div class="conversation-row">
              <div class="conversation-meta">
                <span class="conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
                <span class="conversation-summary">\${escapeHtml(summary)}</span>
                <span class="conversation-time">\${escapeHtml(when)}</span>
                \${runtimeLabel ? \`<span class="conversation-runtime">\${escapeHtml(runtimeLabel)}</span>\` : ''}
              </div>
              <div class="conversation-actions">
                \${runningButtons}
                \${continueButton}
                \${retryButton}
                <span class="status-badge \${statusClass(conversation.status)}">\${statusText(conversation.status)}</span>
              </div>
            </div>
            \${open ? \`
              <div class="conversation-detail">
                \${renderConversationOutcome(conversation)}
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

    function formatDurationMs(durationMs) {
      const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      if (minutes > 0) return minutes + 'm ' + remainder + 's';
      return remainder + 's';
    }

    function formatConversationDuration(conversation) {
      const output = String(conversation.output || '');
      const storedDuration = output.match(/Run duration ms:\\s*(\\d+)/);
      if (storedDuration) {
        return formatDurationMs(Number(storedDuration[1]));
      }
      if (conversation.status !== 'Running' || !conversation.timestamp) {
        return '';
      }
      return formatDurationMs(Date.now() - new Date(conversation.timestamp).getTime());
    }

    function renderConversationOutcome(conversation) {
      const output = String(conversation.output || '');
      const failureCategory = (output.match(/Failure category:\\s*([^\\n]+)/) || [])[1] || '';
      const failureReason = (output.match(/Failure reason:\\n([\\s\\S]*?)(?:\\n\\n|$)/) || [])[1] || '';
      const files = extractConversationFiles(output);
      let result = '';
      if (conversation.status === 'Running') {
        result = t('stillWorking');
      } else if (conversation.status === 'Failed') {
        result = failureCategoryText(failureCategory.trim()) || failureReason.trim() || statusText(conversation.status);
      } else if (conversation.status === 'Completed') {
        result = t('stepCompleted');
      } else {
        result = t('awaitingNextConversation');
      }
      if (files.length > 0 && conversation.status !== 'Running') {
        result += ' ' + t('changedCount') + ': ' + files.length + '.';
      }
      const label = conversation.status === 'Failed' ? t('failureLabel') : t('runResult');
      const conclusion = conversation.status === 'Running' ? '' : extractAgentConclusion(output);
      return \`
        <div class="conversation-outcome \${conversation.status === 'Failed' ? 'failed' : ''}">
          <strong>\${escapeHtml(label)}:</strong> \${escapeHtml(result)}
          \${conclusion ? \`<div><strong>\${escapeHtml(t('agentConclusion'))}:</strong> \${escapeHtml(conclusion)}</div>\` : ''}
        </div>
      \`;
    }

    function extractAgentConclusion(output) {
      const match = String(output || '').match(/Agent output tail:\\n([\\s\\S]*)$/);
      if (!match || !match[1]) {
        return '';
      }
      return match[1]
        .split('\\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('SoloMap:'))
        .slice(-3)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .slice(0, 240);
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
      addOption('claude');
      addOption('opencode');
      addOption('antigravity');
      addOption('antigravity-cli');
      addOption('codex-cli');
      return options.map(option => \`
        <option value="\${escapeHtml(option.value)}">\${escapeHtml(option.label)}</option>
      \`).join('');
    }

    function mergeSupplementFiles(existing, incoming) {
      const seen = new Set();
      return [...(existing || []), ...(incoming || [])]
        .map(file => String(file || '').trim())
        .filter(Boolean)
        .filter(file => {
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        })
        .slice(0, 10);
    }

    function renderSupplementFiles(nodeId, files) {
      if (!files || files.length === 0) {
        return '';
      }
      return \`
        <div class="conversation-attachments" aria-label="\${escapeHtml(t('attachedFiles'))}">
          \${files.map(file => \`
            <span class="conversation-attachment-chip" title="\${escapeHtml(file)}">
              <span>\${escapeHtml(file)}</span>
              <button
                class="conversation-attachment-remove"
                data-remove-supplement-file="\${escapeHtml(file)}"
                title="\${escapeHtml(t('removeAttachment'))}"
              >
                <span class="codicon codicon-close"></span>
              </button>
            </span>
          \`).join('')}
        </div>
      \`;
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

    function triggerRun(nodeId, userMessage, agentCli, supplementFiles) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId,
        userMessage: userMessage || '',
        agentCli: agentCli || '',
        supplementFiles: supplementFiles || []
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
