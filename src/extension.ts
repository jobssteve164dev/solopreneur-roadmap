import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';
import { SqliteStore } from './db/sqliteStore';
import { AgentConversation, RoadmapNode } from './db/types';
import { SolopreneurSidebarProvider } from './sidebarProvider';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;
let statusPoller: NodeJS.Timeout | null = null;
let sidebarProvider: SolopreneurSidebarProvider | null = null;
let activeProjectRoot: string | null = null;
let syncEngineInitPromise: Promise<boolean> | null = null;
let syncEngineInitProjectRoot = '';

interface SolopreneurSettings {
  cliPath: string;
  language: string;
  globalPrompt: string;
  globalDataPath: string;
}

interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
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

interface SolomapSkillRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  entry?: string;
  packagePath?: string;
  status?: string;
  source?: any;
  activation?: {
    keywords?: string[];
    useWhen?: string[];
    doNotUseWhen?: string[];
    projectTypes?: string[];
    roadmapStages?: string[];
    taskKinds?: string[];
    fileGlobs?: string[];
    manualOnly?: boolean;
  };
  risk?: {
    hasScripts?: boolean;
    hasExecutables?: boolean;
    usesNetwork?: boolean | string;
    writesFiles?: boolean | string;
    requiresUserApprovalToRunScripts?: boolean;
  };
  installedAt?: string;
  updatedAt?: string;
}

interface SolomapSkillRegistry {
  version: number;
  updatedAt: string;
  skills: SolomapSkillRegistryEntry[];
}

interface SolomapMcpRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  source?: any;
  serverPath?: string;
  configPath?: string;
  profiles?: Record<string, any>;
  activation?: {
    keywords?: string[];
    useWhen?: string[];
    doNotUseWhen?: string[];
    projectTypes?: string[];
    taskKinds?: string[];
    manualOnly?: boolean;
  };
  permissions?: {
    tools?: string[];
    resources?: string[];
    prompts?: string[];
    requiresCredentials?: boolean;
    credentialRefs?: string[];
    externalAccess?: boolean | string;
    writeAccess?: boolean | string;
  };
  risk?: {
    level?: string;
    canWriteExternal?: boolean;
    canSendMessages?: boolean;
    canModifyCloudResources?: boolean;
    canAccessSecrets?: boolean;
    requiresExplicitEnable?: boolean;
  };
  installedAt?: string;
  updatedAt?: string;
}

interface SolomapMcpRegistry {
  version: number;
  updatedAt: string;
  connectors: SolomapMcpRegistryEntry[];
}

const settingsKey = 'solopreneur.settings';
const projectsKey = 'solopreneur.projects';
const selectedProjectKey = 'solopreneur.selectedProjectPath';
const hiddenProjectsKey = 'solopreneur.hiddenProjects';
const roadmapRevisionId = '__roadmap_revision__';
const soloConversationId = '__solo__';
const agentTerminalBaseName = 'SoloMap Agent Console';
let activeAgentTerminalName = '';
let agentTerminalCounter = 0;
const FEEDBACK_ISSUE_URL = 'https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new';

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
    async (nodeId, userMessage = '', agentCli = '', supplementFiles: string[] = []) => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleRunAgent(context, nodeId, userMessage, agentCli, normalizeSupplementFiles(supplementFiles));
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
    },
    async (projectPath, userMessage = '', agentCli = '', supplementFiles: string[] = []) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleRunSoloConversation(context, userMessage, agentCli, normalizeSupplementFiles(supplementFiles));
      }
    },
    async (projectPath) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return [];
      }
      return chooseSupplementFilesForProject(projectPath);
    },
    async (projectPath) => {
      return getSoloConversationHistoryForProject(context, projectPath);
    },
    async (projectPath, conversationId) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return;
      }
      if (getSelectedProjectPath(context) !== projectPath) {
        await selectProject(context, projectPath);
      }
      const ready = await ensureSyncEngine(context);
      if (ready && activeProjectRoot === projectPath) {
        await handleContinueNativeConversation(context, soloConversationId, Number(conversationId || 0));
      }
    },
    async (projectPath, scope, attachments) => {
      if (!getProjects(context).some((project) => project.path === projectPath)) {
        vscode.window.showErrorMessage(`Project folder is not registered: ${projectPath}`);
        return [];
      }
      return savePastedImageAttachments(projectPath, scope, attachments);
    },
    async (skillInput) => {
      await handleInstallSolomapSkill(context, skillInput);
    },
    async (mcpInput) => {
      await handleInstallSolomapMcp(context, mcpInput);
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
    globalPrompt: saved.globalPrompt ?? config.get('globalPrompt') ?? '',
    globalDataPath: saved.globalDataPath ?? config.get('globalDataPath') ?? ''
  };
}

async function updatePersistedSettings(context: vscode.ExtensionContext, settings: SolopreneurSettings): Promise<void> {
  const currentSettings = getPersistedSettings(context);
  const nextSettings: SolopreneurSettings = {
    cliPath: settings.cliPath || 'agy',
    language: settings.language === 'en' ? 'en' : 'zh',
    globalPrompt: String(settings.globalPrompt || '').trim(),
    globalDataPath: String(settings.globalDataPath ?? currentSettings.globalDataPath ?? '').trim()
  };
  await context.globalState.update(settingsKey, nextSettings);

  const config = vscode.workspace.getConfiguration('solopreneur');
  await config.update('cliPath', nextSettings.cliPath, vscode.ConfigurationTarget.Global);
  await config.update('language', nextSettings.language, vscode.ConfigurationTarget.Global);
  await config.update('globalPrompt', nextSettings.globalPrompt, vscode.ConfigurationTarget.Global);
  await config.update('globalDataPath', nextSettings.globalDataPath, vscode.ConfigurationTarget.Global);
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
  sendProjectsToWebviews(context);
  if (activePanel) {
    activePanel.webview.postMessage({ command: 'roadmapLoading', projectPath });
  }
  void ensureSyncEngine(context).then((ready) => {
    if (ready) {
      sendNodesToWebview();
    }
  });
}

async function updateProjectMetadata(context: vscode.ExtensionContext, projectPath: string, updates: Partial<Pick<SolopreneurProject, 'type' | 'priority'>>): Promise<void> {
  const projects = getProjects(context);
  const nextProjects = projects.map((project) => {
    if (project.path !== projectPath) {
      return project;
    }
    return {
      ...project,
      ...(updates.type !== undefined ? { type: String(updates.type || '') } : {}),
      ...(updates.priority !== undefined ? { priority: String(updates.priority || '') } : {})
    };
  });
  await saveProjects(context, nextProjects);
  sendProjectsToWebviews(context);
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
    '- 阅读 `.solopreneur/roadmap-methodology.md`，按项目真实目标选择适用的推进框架。',
    '- 理解这个项目当前要交付什么、服务谁、是否需要对外获客或销售，以及当前文件里已经有哪些线索。',
    '',
    '## 你的唯一交付物',
    '- 直接重写 `.solopreneur/roadmap.csv`。',
    '- 不要只在终端输出路线图建议。',
    '- 不要把本文件内容、提示词模板或解释性说明写回 CSV。',
    '',
    '## CSV 硬约束',
    '1. 保留 CSV 表头，字段顺序必须严格是：`id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`。',
    '2. 生成 2 到 8 个环节，数量应服从真实交付路径，不为套模板增加任务。',
    '3. 标题、描述、agentPrompt 全部使用中文。',
    '4. `stage` 使用用户能理解的推进阶段名称；如果这是面向外部用户并需要获客或转化的产品，优先使用：`问题与客户发现`、`产品与 MVP`、`营销与销售`、`反馈与规模化`。',
    `5. 每一行 \`agentCli\` 都写 \`${cliPath}\`。`,
    '6. `dependencies` 必须反映真实前置关系；第一步留空，后续按需要依赖前面环节的 id。',
    '7. `status` 全部写 `Pending`，`completedAt` 留空，`createdAt` 写当前 ISO 时间。',
    '8. 面向外部用户并需要获客或转化的产品，默认覆盖四个方法论阶段；内部工具、迁移、研究、内容或基础设施项目不得被强行改写成营销销售路线。',
    '9. 把 Build -> Sell -> Learn -> Improve 作为底层审查：商业化产品不能只有 Build，必须让用户后续能触达市场、吸收反馈并调整路线图。',
    '10. 不要把四阶段方法论写成用户需要维护的解释任务；它只应用来生成更好的下一步和环节。',
    '11. 每个 `agentPrompt` 都必须要求后续 Agent 直接创建或修改项目本地文件，并在适用时执行最窄验证命令。',
    '12. 不要生成空泛咨询任务；每个环节都必须有看得见的本地交付物。',
    '',
    '## 结束前自检',
    '- 重新读取 `.solopreneur/roadmap.csv`。',
    '- 确认列名、环节数量、stage 表达、依赖关系都正确，并与项目真实目标一致。',
    '- 确认 CSV 中没有残留“生成初始路线图”、本文件原文或提示词模板。'
  ].join('\n');
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

interface PastedImageAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
}

function sanitizeAttachmentScope(scope: string): string {
  const normalized = String(scope || 'conversation')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'conversation';
}

function imageExtensionFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'png';
}

function savePastedImageAttachments(projectRoot: string, scope: string, attachments: PastedImageAttachment[]): string[] {
  if (!projectRoot || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const safeScope = sanitizeAttachmentScope(scope);
  const targetDir = path.join(projectRoot, '.solopreneur', 'attachments', safeScope);
  fs.mkdirSync(targetDir, { recursive: true });

  return attachments.slice(0, 10).map((attachment, index) => {
    const dataUrl = String(attachment?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) {
      return '';
    }
    const mimeType = String(attachment.mimeType || match[1] || 'image/png').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      return '';
    }
    const extension = imageExtensionFromMimeType(mimeType);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const randomId = Math.random().toString(16).slice(2, 8);
    const fileName = `${timestamp}-${randomId}-${index + 1}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
  }).filter(Boolean);
}

async function chooseSupplementFilesForNode(nodeId: string): Promise<void> {
  if (!activeProjectRoot || !activePanel) {
    vscode.window.showErrorMessage('Choose a project folder before attaching task files.');
    return;
  }

  const files = await chooseSupplementFilesForProject(activeProjectRoot);
  activePanel.webview.postMessage({
    command: 'supplementFilesSelected',
    nodeId,
    files
  });
}

async function chooseSupplementFilesForProject(projectRoot: string): Promise<string[]> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: 'Attach Files',
    defaultUri: vscode.Uri.file(projectRoot)
  });

  return (selected || [])
    .map((uri) => {
      const absolutePath = uri.fsPath;
      const relativeToRoot = path.relative(projectRoot, absolutePath);
      if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        return '';
      }
      return relativeToRoot.split(path.sep).join('/');
    })
    .filter(Boolean);
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

async function getSoloConversationHistoryForProject(context: vscode.ExtensionContext, projectPath: string): Promise<AgentConversation[]> {
  if (!getProjects(context).some((project) => project.path === projectPath)) {
    return [];
  }
  if (syncEngine && activeProjectRoot === projectPath) {
    return syncEngine.getAgentExecutions(soloConversationId).slice(0, 1);
  }
  const journalPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const store = new SqliteStore(journalPath, context.extensionPath);
  await store.init();
  try {
    return store.getExecutionLogs(soloConversationId).slice(0, 1);
  } finally {
    store.close();
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

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngineInitProjectRoot = projectRoot;
  syncEngineInitPromise = (async () => {
    const nextSyncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
    try {
      await nextSyncEngine.initAndSync();
      if (getSelectedProjectPath(context) !== projectRoot) {
        return false;
      }
      syncEngine = nextSyncEngine;
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
    } finally {
      syncEngineInitPromise = null;
      syncEngineInitProjectRoot = '';
    }
  })();
  return syncEngineInitPromise;
}

async function openRoadmapPanel(context: vscode.ExtensionContext) {
  // If panel already exists, reveal it
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const projectRoot = getSelectedProjectPath(context);
  if (!projectRoot) {
    vscode.window.showErrorMessage('Choose a project folder before launching the Roadmap.');
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
  activePanel.webview.postMessage({ command: 'roadmapLoading', projectPath: projectRoot });
  activePanel.webview.postMessage({
    command: 'settingsLoaded',
    settings: getPersistedSettings(context)
  });
  activePanel.webview.postMessage({
    command: 'projectsLoaded',
    projects: getProjectState(context)
  });

  // Handle messages from Webview
  activePanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'getNodes':
          if (syncEngine && activeProjectRoot === getSelectedProjectPath(context)) {
            sendNodesToWebview();
          } else {
            activePanel?.webview.postMessage({ command: 'roadmapLoading', projectPath: getSelectedProjectPath(context) });
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

        case 'runAgent':
          await handleRunAgent(context, message.nodeId, message.userMessage || '', message.agentCli || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runRoadmapRevision':
          await handleRoadmapRevision(context, message.userMessage || '', message.agentCli || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'runSoloConversation':
          await handleRunSoloConversation(context, message.userMessage || '', message.agentCli || '', normalizeSupplementFiles(message.supplementFiles));
          break;

        case 'linkSoloConversation':
          linkSoloConversationToNode(Number(message.conversationId || 0), String(message.nodeId || ''));
          break;

        case 'chooseSupplementFiles':
          await chooseSupplementFilesForNode(message.nodeId);
          break;

        case 'savePastedAttachments':
          if (!activeProjectRoot || !activePanel) {
            vscode.window.showErrorMessage('Choose a project folder before attaching images.');
            return;
          }
          activePanel.webview.postMessage({
            command: 'supplementFilesSelected',
            nodeId: message.nodeId,
            files: savePastedImageAttachments(activeProjectRoot, message.nodeId || 'conversation', message.attachments || [])
          });
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
            globalPrompt: message.globalPrompt,
            globalDataPath: message.globalDataPath
          });
          vscode.window.showInformationMessage('SoloMap settings saved successfully!');
          // Broadcast to sync both Webviews
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;

        case 'installSkill':
          await handleInstallSolomapSkill(context, message.skillInput || '');
          break;

        case 'installMcp':
          await handleInstallSolomapMcp(context, message.mcpInput || '');
          break;

        case 'openFeedbackIssue':
          vscode.env.openExternal(vscode.Uri.parse(buildFeedbackIssueUrl(message.title || '', message.body || '')));
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

        case 'updateProjectMetadata':
          await updateProjectMetadata(context, message.projectPath, {
            type: message.projectType,
            priority: message.priority
          });
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildFeedbackIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams();
  const issueTitle = String(title || '').trim();
  const issueBody = String(body || '').trim();
  if (issueTitle) {
    params.set('title', issueTitle);
  }
  if (issueBody) {
    params.set('body', issueBody);
  }
  return `${FEEDBACK_ISSUE_URL}${params.toString() ? `?${params.toString()}` : ''}`;
}

function expandHomePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed === '~') {
    return process.env.HOME || trimmed;
  }
  if (trimmed.startsWith('~/')) {
    return path.join(process.env.HOME || '~', trimmed.slice(2));
  }
  return trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readShellPath(shellPath: string): string[] {
  const shell = expandHomePath(shellPath);
  if (!shell || !fs.existsSync(shell)) {
    return [];
  }
  try {
    const result = childProcess.spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 1800,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0) {
      return [];
    }
    return String(result.stdout || '').split(path.delimiter).filter(Boolean);
  } catch {
    return [];
  }
}

function getExecutableSearchPaths(): string[] {
  const configuredPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shellPaths = [
    ...readShellPath(process.env.SHELL || ''),
    ...readShellPath('/bin/zsh'),
    ...readShellPath('/bin/bash')
  ];
  const home = process.env.HOME || '';
  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, 'bin') : '',
    home ? path.join(home, '.npm-global', 'bin') : '',
    home ? path.join(home, '.npm', 'bin') : '',
    home ? path.join(home, '.yarn', 'bin') : '',
    home ? path.join(home, '.bun', 'bin') : '',
    home ? path.join(home, '.cargo', 'bin') : ''
  ].filter(Boolean);
  return [...configuredPath, ...shellPaths, ...commonPaths]
    .map(expandHomePath)
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function resolveCommandOnSearchPath(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return '';
  }
  const expanded = expandHomePath(trimmed);
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    return isExecutableFile(expanded) ? expanded : '';
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of getExecutableSearchPaths()) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${expanded}${ext}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function commandExists(command: string): boolean {
  return Boolean(resolveCommandOnSearchPath(command));
}

function getGithubRepoSlug(workspaceRoot: string): string {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return '';
  }
  const result = childProcess.spawnSync('git', ['-C', workspaceRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 1800,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const remote = String(result.stdout || '').trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, '') : '';
}

function normalizeIssueLabel(label: string): string {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeIssueCategory(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['bug', 'type: bug', 'kind/bug', 'defect', 'regression', 'perf'])) return 'bug';
  if (has(['tech debt', 'tech-debt', 'debt', 'refactor', 'cleanup', 'maintenance', 'architecture'])) return 'tech-debt';
  if (has(['feature', 'enhancement', 'request', 'feature request', 'feature-request', 'type: feature', 'customer'])) return 'feature-request';
  if (has(['docs', 'documentation', 'readme'])) return 'documentation';
  return 'discussion';
}

function normalizeIssuePriority(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['p0', 'priority: critical', 'critical', 'urgent', 'blocker', 'sev1'])) return 'P0';
  if (has(['p1', 'priority: high', 'high', 'sev2'])) return 'P1';
  if (has(['p2', 'priority: medium', 'medium', 'normal', 'sev3'])) return 'P2';
  return '';
}

function buildGithubIssueContext(workspaceRoot: string, node: RoadmapNode): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const listResult = childProcess.spawnSync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '20',
    '--json',
    'number,title,body,labels,comments,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (listResult.status !== 0) {
    return '';
  }
  let issues: any[] = [];
  try {
    issues = JSON.parse(String(listResult.stdout || '[]'));
  } catch {
    return '';
  }
  const nodeText = `${node.title || ''} ${node.description || ''} ${node.stage || ''}`.toLowerCase();
  const candidates = issues.map((issue) => {
    const labels = Array.isArray(issue.labels) ? issue.labels.map((label: any) => String(label?.name || label || '')) : [];
    const category = normalizeIssueCategory(labels);
    const priority = normalizeIssuePriority(labels);
    const title = String(issue.title || '');
    const score = (priority === 'P0' ? 5 : priority === 'P1' ? 3 : priority === 'P2' ? 1 : 0)
      + (category === 'bug' ? 4 : category === 'tech-debt' ? 2 : 0)
      + (nodeText && title && nodeText.includes(title.toLowerCase().slice(0, 16)) ? 2 : 0)
      + Math.min(Number(issue.comments || 0), 5);
    return { issue, labels, category, priority, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!candidates.length) {
    return '';
  }
  const sections = candidates.map((candidate) => {
    const issueNumber = Number(candidate.issue.number || 0);
    const viewResult = childProcess.spawnSync('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--comments',
      '--json',
      'number,title,body,labels,comments,url'
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let detail = candidate.issue;
    if (viewResult.status === 0) {
      try {
        detail = JSON.parse(String(viewResult.stdout || '{}'));
      } catch {}
    }
    const comments = Array.isArray(detail.comments)
      ? detail.comments.slice(-3).map((comment: any, index: number) => {
        const author = String(comment?.author?.login || `comment-${index + 1}`);
        const body = String(comment?.body || '').trim().replace(/\s+/g, ' ').slice(0, 500);
        return `${index + 1}. ${author}: ${body}`;
      })
      : [];
    return [
      `### Issue #${issueNumber}: ${String(detail.title || '').trim()}`,
      `分类：${candidate.category}${candidate.priority ? ` / ${candidate.priority}` : ''}`,
      `链接：${String(detail.url || '').trim()}`,
      String(detail.body || '').trim() ? `描述：${String(detail.body || '').trim().replace(/\s+/g, ' ').slice(0, 700)}` : '',
      comments.length ? ['最近评论：', ...comments].join('\n') : ''
    ].filter(Boolean).join('\n');
  });
  return ['当前环节关联的 GitHub Issues：', ...sections].join('\n\n');
}

function buildGithubDeliveryContext(workspaceRoot: string): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const releaseResult = childProcess.spawnSync('gh', [
    'release',
    'list',
    '--repo',
    repo,
    '--limit',
    '1',
    '--json',
    'tagName,name,publishedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const runResult = childProcess.spawnSync('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '3',
    '--json',
    'name,displayTitle,status,conclusion,createdAt,updatedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (releaseResult.status !== 0 && runResult.status !== 0) {
    return '';
  }
  let latestRelease = '';
  try {
    const releases = releaseResult.status === 0 ? JSON.parse(String(releaseResult.stdout || '[]')) : [];
    const release = Array.isArray(releases) ? releases[0] : null;
    if (release) {
      latestRelease = [
        `最新 Release：${String(release.tagName || release.name || '').trim()}`,
        String(release.publishedAt || '').trim() ? `发布时间：${String(release.publishedAt).trim()}` : '',
        String(release.url || '').trim() ? `链接：${String(release.url).trim()}` : ''
      ].filter(Boolean).join('\n');
    }
  } catch {}
  let workflowSummary = '';
  try {
    const runs = runResult.status === 0 ? JSON.parse(String(runResult.stdout || '[]')) : [];
    const lines = Array.isArray(runs)
      ? runs.slice(0, 3).map((run: any, index: number) => {
        const name = String(run.displayTitle || run.name || `workflow-${index + 1}`).trim();
        const state = [String(run.status || '').trim(), String(run.conclusion || '').trim()].filter(Boolean).join('/');
        const when = String(run.updatedAt || run.createdAt || '').trim();
        return `${index + 1}. ${name}：${state || 'unknown'}${when ? ` · ${when}` : ''}${run.url ? ` · ${String(run.url).trim()}` : ''}`;
      })
      : [];
    if (lines.length) {
      workflowSummary = ['最近 GitHub Actions：', ...lines].join('\n');
    }
  } catch {}
  const sections = [latestRelease, workflowSummary].filter(Boolean);
  return sections.length ? ['当前项目交付信号：', ...sections].join('\n\n') : '';
}

function resolveExecutablePath(command: string): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return '';
  }
  return resolveCommandOnSearchPath(trimmed) || expandHomePath(trimmed);
}

function getAgentCliFamily(command: string): string {
  const name = path.basename((command || '').trim()).toLowerCase();
  if (['codex', 'codex-cli'].includes(name)) return 'codex';
  if (['claude', 'claude-code', 'claude-code-cli'].includes(name)) return 'claude';
  if (['cursor', 'cursor-cli'].includes(name)) return 'cursor';
  if (['copilot', 'copilot-cli'].includes(name)) return 'copilot';
  if (['opencode', 'open-code', 'open-code-cli'].includes(name)) return 'opencode';
  if (['', 'agy', 'antigravity', 'antigravity-cli'].includes(name)) return 'antigravity';
  return name;
}

function getKnownAgentCliCandidates(family: string): string[] {
  if (family === 'codex') return ['codex', 'codex-cli'];
  if (family === 'claude') return ['claude', 'claude-code', 'claude-code-cli'];
  // Cursor CLI should behave like Codex for SoloMap: non-interactive exec + native resume.
  if (family === 'cursor') return ['cursor', 'cursor-cli', 'codex', 'codex-cli'];
  if (family === 'copilot') return ['copilot', 'copilot-cli'];
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
    'copilot',
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
  if (executableName === 'cursor' || executableName === 'cursor-cli') {
    return 'codex';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return 'claude';
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return 'opencode';
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return 'copilot';
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
    return `${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${quotedPrompt}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --dangerously-skip-permissions --add-dir=${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --dangerously-skip-permissions --add-dir ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${quotedPrompt} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)} --allow-all --no-ask-user --output-format text`;
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
  const promptFileInstruction = `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.`;
  const quotedPromptFileInstruction = shellQuote(promptFileInstruction);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --dangerously-skip-permissions --add-dir=${shellQuote(workspaceRoot)} ${quotedPromptFileInstruction}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --dangerously-skip-permissions --add-dir ${shellQuote(workspaceRoot)} ${quotedPromptFileInstruction}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${quotedPromptFileInstruction} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)} --allow-all --no-ask-user --output-format text`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run ${quotedPromptFileInstruction})`;
  }

  return `${quotedCli} run --task ${quotedPromptFileInstruction}`;
}

function buildAgentCommandFromShellVar(agentCli: string, promptVarName: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const promptExpression = `"$${promptVarName}"`;

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `printf %s ${promptExpression} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli') {
    return `printf %s ${promptExpression} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --print --dangerously-skip-permissions --add-dir=${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p --dangerously-skip-permissions --add-dir ${shellQuote(workspaceRoot)} ${promptExpression}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${promptExpression} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)} --allow-all --no-ask-user --output-format text`;
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
  if (executableName === 'cursor' || executableName === 'cursor-cli') {
    return `${quotedCli} resume -C ${shellQuote(workspaceRoot)} ${quotedSessionId}`;
  }

  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `${quotedCli} --conversation ${quotedSessionId} --prompt-interactive --dangerously-skip-permissions --add-dir=${shellQuote(workspaceRoot)}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} --connect ${quotedSessionId} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)} --allow-all --no-ask-user`;
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
      // Fallback: if provider-specific extraction fails, capture the last UUID in the run output log.
      `if [ -z "$session_id" ]; then session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true); session_source="generic-output"; fi`,
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
      // Fallback: if codex-specific session extraction fails, capture the last UUID in output log.
      `if [ -z "$session_id" ]; then session_id=$(grep -Eo '[0-9a-fA-F-]{36}' ${shellQuote(outputFilePath)} 2>/dev/null | tail -1 || true); session_source="generic-output"; fi`,
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

function normalizeSolomapGlobalPath(workspaceRoot: string, globalDataPath = ''): string {
  const trimmed = String(globalDataPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  const baseRoot = workspaceRoot || process.cwd();
  return path.join(path.dirname(baseRoot), '.solomap-global');
}

function getSolomapMemoryRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'memory');
}

function getSolomapSkillsRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'skills');
}

function getSolomapMcpRoot(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), 'mcp');
}

function getProjectMemoryFilePath(workspaceRoot: string, globalDataPath = ''): string {
  const projectName = path.basename(workspaceRoot || 'project');
  const projectSlug = sanitizeAttachmentScope(projectName.toLowerCase()) || 'project';
  return path.join(getSolomapMemoryRoot(workspaceRoot, globalDataPath), 'projects', `${projectSlug}.md`);
}

function writeFileIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeSolomapMemoryExamples(memoryRoot: string, learningCandidatesDir: string): void {
  const examples: Array<{ filePath: string; content: string }> = [
    {
      filePath: path.join(memoryRoot, 'projects', '_example.md'),
      content: [
        '# Project Memory Example',
        '',
        'Create real project files as `projects/<project-slug>.md`. Keep only stable facts that help future work on that project.',
        '',
        '## Stable Facts',
        '- YYYY-MM-DD: Fact confirmed by current files, tests, logs, or user decision.',
        '',
        '## Decisions',
        '- YYYY-MM-DD: Decision, reason, and impact.',
        '',
        '## Current Handoff',
        '- Goal:',
        '- Confirmed state:',
        '- Next useful action:',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'patterns', '_example.md'),
      content: [
        '# Pattern Example',
        '',
        'Use one file per reusable delivery, implementation, debugging, or verification pattern.',
        '',
        '## Applies When',
        '- Situation where this pattern is useful.',
        '',
        '## Steps',
        '1. Action that reliably helps.',
        '2. Action that verifies the result.',
        '',
        '## Evidence',
        '- Where this pattern was validated.',
        '',
        '## Risks',
        '- When not to apply it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'decisions', '_example.md'),
      content: [
        '# Decision Example',
        '',
        'Use one file per stable cross-project decision.',
        '',
        '## Status',
        '- proposed | accepted | superseded',
        '',
        '## Context',
        '- Why this decision exists.',
        '',
        '## Decision',
        '- What should happen from now on.',
        '',
        '## Impact',
        '- Projects, workflows, or user experience affected.',
        '',
        '## Review Trigger',
        '- When this decision should be revisited.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'domains', '_example.md'),
      content: [
        '# Domain Memory Example',
        '',
        'Use one file per domain that can help multiple projects.',
        '',
        '## Scope',
        '- What this domain memory covers.',
        '',
        '## Stable Knowledge',
        '- Verified domain fact or constraint.',
        '',
        '## Reuse Notes',
        '- How future projects should apply it.',
        '',
        '## Sources',
        '- File, user decision, command output, or trusted source that supports it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'inbox', '_example.md'),
      content: [
        '# Inbox Example',
        '',
        'Use inbox for observations that may become memory but are not verified enough yet.',
        '',
        '## Observation',
        '- What was noticed.',
        '',
        '## Evidence',
        '- Where it came from.',
        '',
        '## Confidence',
        '- low | medium | high',
        '',
        '## Promotion Target',
        '- projects | patterns | decisions | domains | operating-rules | profile',
        '',
        '## Next Check',
        '- What must be verified before promotion.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'active', '_example.md'),
      content: [
        '# Active Session Example',
        '',
        'Use active memory for temporary handoff only. Promote stable information elsewhere before it becomes long-lived.',
        '',
        '## Current Goal',
        '- What is being handled now.',
        '',
        '## Confirmed Facts',
        '- Current facts verified in this session.',
        '',
        '## Next Action',
        '- The next concrete action if work resumes.',
        '',
        '## Open Risks',
        '- Known unresolved risks.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(learningCandidatesDir, '_example.md'),
      content: [
        '# Learning Candidate Example',
        '',
        'Use this area for reusable lessons before they are promoted into long-term memory.',
        '',
        '## Candidate Lesson',
        '- What future agents may reuse.',
        '',
        '## Source Task',
        '- Project, date, and task where it was observed.',
        '',
        '## Evidence',
        '- File, test, log, command output, or user decision that supports it.',
        '',
        '## Applies When',
        '- Conditions where this lesson is useful.',
        '',
        '## Promotion Target',
        '- memory/projects | memory/patterns | memory/decisions | memory/domains | memory/inbox',
        ''
      ].join('\n')
    }
  ];
  examples.forEach((example) => {
    fs.mkdirSync(path.dirname(example.filePath), { recursive: true });
    writeFileIfMissing(example.filePath, example.content);
  });
}

function ensureSolomapMemoryStore(workspaceRoot: string, globalDataPath = ''): { globalRoot: string; memoryRoot: string; projectMemoryFile: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const memoryRoot = path.join(globalRoot, 'memory');
  const projectMemoryFile = getProjectMemoryFilePath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const learningApprovedDir = path.join(globalRoot, 'learning', 'approved');
  const learningRejectedDir = path.join(globalRoot, 'learning', 'rejected');
  const metricsDir = path.join(globalRoot, 'metrics');
  fs.mkdirSync(learningCandidatesDir, { recursive: true });
  fs.mkdirSync(learningApprovedDir, { recursive: true });
  fs.mkdirSync(learningRejectedDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  ['projects', 'patterns', 'decisions', 'domains', 'inbox', 'active'].forEach((dir) => {
    fs.mkdirSync(path.join(memoryRoot, dir), { recursive: true });
  });
  const memoryReadmePath = path.join(memoryRoot, 'README.md');
  const profilePath = path.join(memoryRoot, 'profile.md');
  const operatingRulesPath = path.join(memoryRoot, 'operating-rules.md');
  if (!fs.existsSync(memoryReadmePath)) {
    fs.writeFileSync(memoryReadmePath, [
      '# SoloMap Memory',
      '',
      'This directory stores reusable SoloMap experience across projects.',
      '',
      '- `profile.md`: stable user preferences and collaboration style.',
      '- `operating-rules.md`: reusable execution rules that apply across projects.',
      '- `projects/`: one memory file per project.',
      '- `patterns/`: reusable implementation, debugging, and delivery patterns.',
      '- `decisions/`: confirmed cross-project decisions and their rationale.',
      '- `domains/`: domain knowledge that can help future projects.',
      '- `inbox/`: unverified observations and learning candidates before promotion.',
      '- `active/`: current session handoff and temporary working context.',
      '',
      'Agents should treat memory as context, not as stronger evidence than current files, tests, logs, or the user request.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '# Profile\n\nStable user preferences and collaboration style promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(operatingRulesPath)) {
    fs.writeFileSync(operatingRulesPath, '# Operating Rules\n\nReusable execution rules promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(projectMemoryFile)) {
    fs.writeFileSync(projectMemoryFile, [
      `# ${path.basename(workspaceRoot || 'Project')}`,
      '',
      'Stable project facts, decisions, and handoff context promoted by SoloMap.',
      ''
    ].join('\n'), 'utf8');
  }
  writeFileIfMissing(path.join(metricsDir, 'execution-speed.csv'), 'project,node_id,stage,status,duration_ms,completed_at\n');
  writeFileIfMissing(path.join(metricsDir, 'reuse-rate.csv'), 'project,node_id,reusable_signals,learning_candidates,recorded_at\n');
  writeFileIfMissing(path.join(metricsDir, 'priority-accuracy.csv'), 'project,priority,next_action,outcome,recorded_at\n');
  writeFileIfMissing(path.join(metricsDir, 'monthly-summary.md'), '# Monthly Learning Summary\n\nSoloMap uses this file to collect low-frequency cross-project learning signals.\n');
  writeSolomapMemoryExamples(memoryRoot, learningCandidatesDir);
  return { globalRoot, memoryRoot, projectMemoryFile };
}

function solomapCsvEscape(value: string | number): string {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function countMarkdownFiles(dirPath: string): number {
  try {
    return fs.readdirSync(dirPath).filter((name) => name.endsWith('.md') && name !== '_example.md').length;
  } catch {
    return 0;
  }
}

function appendCsvRecord(filePath: string, header: string, values: Array<string | number>): void {
  writeFileIfMissing(filePath, `${header}\n`);
  fs.appendFileSync(filePath, `${values.map(solomapCsvEscape).join(',')}\n`, 'utf8');
}

function summarizeLearningEvidence(changedFilesSummary: string, touchedFilesSummary: string, outputTail: string): string {
  return [
    changedFilesSummary ? `- Workspace changes: ${changedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    touchedFilesSummary ? `- Touched files: ${touchedFilesSummary.split('\n').filter(Boolean).slice(0, 6).join('; ')}` : '',
    outputTail ? `- Agent output tail was captured in this run.` : ''
  ].filter(Boolean).join('\n') || '- This run completed and updated the SoloMap execution history.';
}

function recordSolomapLearningCycle(
  workspaceRoot: string,
  globalDataPath: string,
  node: RoadmapNode | null,
  nextStatus: string,
  changedFilesSummary: string,
  touchedFilesSummary: string,
  outputTail: string,
  runDurationMs: number,
  finishedAt: string
): void {
  if (!workspaceRoot || !node || !node.id) {
    return;
  }
  const { globalRoot } = ensureSolomapMemoryStore(workspaceRoot, globalDataPath);
  const projectName = path.basename(workspaceRoot);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const metricsDir = path.join(globalRoot, 'metrics');
  const reusableSignals = (() => {
    try {
      return fs.existsSync(path.join(workspaceRoot, '.solopreneur', 'step-memory'))
        ? fs.readdirSync(path.join(workspaceRoot, '.solopreneur', 'step-memory')).length
        : 0;
    } catch {
      return 0;
    }
  })();
  appendCsvRecord(
    path.join(metricsDir, 'execution-speed.csv'),
    'project,node_id,stage,status,duration_ms,completed_at',
    [projectName, node.id, node.stage || '', nextStatus, runDurationMs, finishedAt]
  );
  appendCsvRecord(
    path.join(metricsDir, 'reuse-rate.csv'),
    'project,node_id,reusable_signals,learning_candidates,recorded_at',
    [projectName, node.id, reusableSignals, countMarkdownFiles(learningCandidatesDir), finishedAt]
  );
  appendCsvRecord(
    path.join(metricsDir, 'priority-accuracy.csv'),
    'project,priority,next_action,outcome,recorded_at',
    [projectName, '', node.title || '', nextStatus, finishedAt]
  );

  if (nextStatus !== 'Completed' && nextStatus !== 'In Progress') {
    return;
  }
  const slug = sanitizeAttachmentScope(`${projectName}-${node.id}-${Date.parse(finishedAt) || Date.now()}`);
  const candidatePath = path.join(learningCandidatesDir, `${slug}.md`);
  writeFileIfMissing(candidatePath, [
    `# Learning Candidate: ${node.title || node.id}`,
    '',
    '## Candidate Lesson',
    `- A ${node.stage || 'roadmap'} step produced reusable execution evidence. Review whether this should become a pattern, decision, domain note, or project memory.`,
    '',
    '## Source Task',
    `- Project: ${projectName}`,
    `- Step: ${node.title || node.id}`,
    `- Status: ${nextStatus}`,
    `- Completed at: ${finishedAt}`,
    '',
    '## Evidence',
    summarizeLearningEvidence(changedFilesSummary, touchedFilesSummary, outputTail),
    '',
    '## Applies When',
    `- Future projects have a similar ${node.stage || 'roadmap'} step or need the same delivery pattern.`,
    '',
    '## Promotion Target',
    '- memory/patterns | memory/decisions | memory/domains | memory/projects',
    ''
  ].join('\n'));
}

function buildSolomapLearningContext(workspaceRoot: string, globalDataPath = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  const metricsDir = path.join(globalRoot, 'metrics');
  const candidateCount = countMarkdownFiles(learningCandidatesDir);
  const readTail = (fileName: string) => {
    const filePath = path.join(metricsDir, fileName);
    try {
      return fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(-4).join('\n');
    } catch {
      return '';
    }
  };
  const executionTail = readTail('execution-speed.csv');
  const reuseTail = readTail('reuse-rate.csv');
  return [
    'SoloMap 跨项目学习信号：',
    `- 待审核学习候选：${candidateCount}`,
    executionTail ? `- 最近执行速度记录：\n${executionTail}` : '',
    reuseTail ? `- 最近复用记录：\n${reuseTail}` : '',
    '- 如果当前环节属于 Improve / 复盘 / 调整路线图，应优先参考这些信号来提出下一轮路线图调整。'
  ].filter(Boolean).join('\n');
}

function getSolomapSkillRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), 'registry.json');
}

function ensureSolomapSkillStore(workspaceRoot: string, globalDataPath = ''): { skillsRoot: string; installedRoot: string; runsRoot: string; registryPath: string } {
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  const runsRoot = path.join(skillsRoot, 'runs');
  const registryPath = path.join(skillsRoot, 'registry.json');
  fs.mkdirSync(installedRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), skills: [] }, null, 2), 'utf8');
  }
  return { skillsRoot, installedRoot, runsRoot, registryPath };
}

function readSolomapSkillRegistry(workspaceRoot: string, globalDataPath = ''): SolomapSkillRegistry {
  const registryPath = getSolomapSkillRegistryPath(workspaceRoot, globalDataPath);
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: '', skills: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      skills: Array.isArray(parsed.skills) ? parsed.skills : []
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), skills: [] };
  }
}

function writeSolomapSkillRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapSkillRegistry): void {
  const { registryPath } = ensureSolomapSkillStore(workspaceRoot, globalDataPath);
  const normalized: SolomapSkillRegistry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: Array.isArray(registry.skills) ? registry.skills : []
  };
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
}

function normalizeSkillKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30);
}

function scoreSolomapSkill(skill: SolomapSkillRegistryEntry, contextText: string): { score: number; reasons: string[] } {
  if (!skill || skill.status === 'disabled' || skill.status === 'failed') {
    return { score: 0, reasons: [] };
  }
  if (skill.activation?.manualOnly) {
    return { score: 0, reasons: [] };
  }
  if (skill.risk?.hasScripts || skill.risk?.hasExecutables) {
    return { score: 0, reasons: [] };
  }
  const text = contextText.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  const keywords = normalizeSkillKeywords(skill.activation?.keywords);
  keywords.forEach((keyword) => {
    if (keyword && text.includes(keyword.toLowerCase())) {
      score += 3;
      if (reasons.length < 3) {
        reasons.push(`keyword:${keyword}`);
      }
    }
  });
  normalizeSkillKeywords(skill.activation?.useWhen).forEach((hint) => {
    const hintWords = hint.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((word) => word.length >= 2);
    if (hintWords.some((word) => text.includes(word))) {
      score += 1;
    }
  });
  return { score, reasons };
}

function selectSolomapSkillCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 3): Array<{ skill: SolomapSkillRegistryEntry; reasons: string[] }> {
  const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
  return registry.skills
    .map((skill) => ({ skill, ...scoreSolomapSkill(skill, contextText) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ skill, reasons }) => ({ skill, reasons }));
}

function buildSolomapSkillCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): string {
  const candidates = selectSolomapSkillCandidates(workspaceRoot, globalDataPath, contextText, 3);
  if (candidates.length === 0) {
    return '';
  }
  return [
    '本次任务可能相关的 SoloMap 技能候选：',
    ...candidates.map(({ skill, reasons }, index) => {
      const entry = skill.entry || `installed/${skill.id}/package/SKILL.md`;
      const useWhen = normalizeSkillKeywords(skill.activation?.useWhen).slice(0, 3).join('；');
      const doNotUseWhen = normalizeSkillKeywords(skill.activation?.doNotUseWhen).slice(0, 3).join('；');
      const risk = skill.risk?.hasScripts || skill.risk?.hasExecutables
        ? '包含脚本或可执行文件；除非本轮任务明确需要并说明用途与风险，否则只读取说明，不自动执行。'
        : '默认作为说明型能力读取。';
      return [
        `${index + 1}. ${skill.title || skill.id}`,
        `   - 入口：${path.join(getSolomapSkillsRoot(workspaceRoot, globalDataPath), entry)}`,
        `   - 命中原因：${reasons.join(', ') || '任务上下文相关'}`,
        useWhen ? `   - 适用：${useWhen}` : '',
        doNotUseWhen ? `   - 不适用：${doNotUseWhen}` : '',
        `   - 风险：${risk}`
      ].filter(Boolean).join('\n');
    }),
    '技能使用协议：这些只是候选，不是强制项。开始执行前快速判断是否适用，只读取真正相关的 SKILL.md；如果跳过候选，用一句话说明原因。不要自行安装新 skill。最终输出中简短列出本轮实际使用的 skill。'
  ].join('\n');
}

function buildSkillInstallPrompt(skillInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 skill package。',
    '这是受控安装任务；只能按 SoloMap 指定目录和 schema 落盘，不要安装到各 Agent 自己的全局技能目录作为正式结果。',
    '',
    `用户提供的 skill 来源：${skillInput}`,
    `项目目录：${workspaceRoot}`,
    `SoloMap 全局目录：${globalRoot}`,
    `SoloMap 技能目录：${skillsRoot}`,
    `安装结果 JSON：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/skills/installed/<skill-id>/package/`：完整 skill package，必须包含入口 `SKILL.md`，并保留 scripts、templates、assets、examples 等同级资源。',
    '- `.solomap-global/skills/installed/<skill-id>/solomap.skill.json`：SoloMap 统一技能元数据。',
    '- `.solomap-global/skills/installed/<skill-id>/source.lock.json`：来源、commit、原始 skillPath、安装时间、文件 hash 或目录 hash。',
    '',
    '安装步骤：',
    '1. 解析用户提供的来源。支持 skills.sh URL、GitHub URL、owner/repo、owner/repo@skill、仓库子目录 URL。',
    '2. 下载或克隆来源到临时预览区；如果使用 `npx skills`，必须设置 `DISABLE_TELEMETRY=1`，并把 HOME 指向临时目录，避免污染用户真实 Agent 技能目录。',
    '3. 定位目标 skill package 的实际文件夹；不要只复制 `SKILL.md`。',
    '4. 选择稳定 `skill-id`：优先用 SKILL.md frontmatter 的 `name`，否则用目录名；只允许小写字母、数字和连字符。',
    '5. 将完整 package 写入 `.solomap-global/skills/installed/<skill-id>/package/`。',
    '6. 从 `SKILL.md` 解析 title/name、description、version，并生成 `solomap.skill.json`。至少包含 id、title、description、entry、packagePath、status、source、activation、risk、installedAt、updatedAt。',
    '7. 扫描 package，标记风险：是否包含 scripts、可执行文件、网络访问提示、文件写入提示。默认 `requiresUserApprovalToRunScripts=true`。',
    '8. 写入 `source.lock.json`。',
    '9. 写入安装结果 JSON。',
    '',
    '结果 JSON schema：',
    '{',
    '  "ok": true,',
    '  "skillId": "skill-id",',
    '  "installedPath": ".solomap-global/skills/installed/skill-id",',
    '  "packagePath": ".solomap-global/skills/installed/skill-id/package",',
    '  "entryFile": ".solomap-global/skills/installed/skill-id/package/SKILL.md",',
    '  "solomapSkillJson": ".solomap-global/skills/installed/skill-id/solomap.skill.json",',
    '  "sourceLockJson": ".solomap-global/skills/installed/skill-id/source.lock.json",',
    '  "metadata": { "name": "skill-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "...", "skillPath": "..." },',
    '  "risk": { "hasScripts": false, "hasExecutables": false, "usesNetwork": "unknown", "writesFiles": "unknown", "requiresUserApprovalToRunScripts": true }',
    '}',
    '',
    '如果安装失败，也必须写入结果 JSON：',
    '{ "ok": false, "error": "一句话说明失败原因", "source": { "input": "..." } }',
    '',
    '安全边界：',
    '- 不要删除旧文件或清空目录。',
    '- 不要把 package 安装到 `~/.codex`、`~/.claude`、`~/.agents`、项目源码目录或其他 Agent 私有目录作为正式结果。',
    '- 不要运行 skill package 中的脚本；安装阶段只允许读取、复制、分析。',
    '- 如果来源不清楚或存在多个候选 skill，选择最匹配用户输入的一个；无法判断时写失败结果 JSON，不要猜测安装。',
    '',
    '完成后正常退出 CLI。'
  ].join('\n');
}

function resolveSkillResultPath(globalRoot: string, value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(path.dirname(globalRoot), raw);
}

function pathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function validateAndRegisterSkillInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; skillId?: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const skillsRoot = getSolomapSkillsRoot(workspaceRoot, globalDataPath);
  const installedRoot = path.join(skillsRoot, 'installed');
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: 'Skill install result.json was not created.' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `Skill install result.json is invalid: ${error.message}` };
  }
  if (!result.ok) {
    return { ok: false, message: String(result.error || 'Skill installation failed.') };
  }
  const skillId = sanitizeAttachmentScope(String(result.skillId || result.metadata?.name || '').toLowerCase());
  if (!skillId) {
    return { ok: false, message: 'Skill install result is missing skillId.' };
  }
  const installedPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(skillsRoot, 'installed', skillId));
  const packagePath = resolveSkillResultPath(globalRoot, result.packagePath || path.join(installedPath, 'package'));
  const entryFile = resolveSkillResultPath(globalRoot, result.entryFile || path.join(packagePath, 'SKILL.md'));
  const solomapSkillJson = resolveSkillResultPath(globalRoot, result.solomapSkillJson || path.join(installedPath, 'solomap.skill.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(installedPath, 'source.lock.json'));
  if (!pathInside(installedRoot, installedPath)) {
    return { ok: false, message: 'Skill installedPath is outside SoloMap skills/installed.' };
  }
  if (!pathInside(installedPath, packagePath) || !pathInside(packagePath, entryFile)) {
    return { ok: false, message: 'Skill package path is outside the installed skill directory.' };
  }
  if (![entryFile, solomapSkillJson, sourceLockJson].every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
    return { ok: false, message: 'Skill package is missing SKILL.md, solomap.skill.json, or source.lock.json.' };
  }
  let skillJson: any;
  try {
    skillJson = JSON.parse(fs.readFileSync(solomapSkillJson, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `solomap.skill.json is invalid: ${error.message}` };
  }
  const now = new Date().toISOString();
  const entry: SolomapSkillRegistryEntry = {
    id: skillId,
    title: String(skillJson.title || skillJson.name || result.metadata?.name || skillId),
    description: String(skillJson.description || result.metadata?.description || ''),
    entry: path.relative(skillsRoot, entryFile).replace(/\\/g, '/'),
    packagePath: path.relative(skillsRoot, packagePath).replace(/\\/g, '/'),
    status: 'installed',
    source: skillJson.source || result.source || {},
    activation: {
      keywords: normalizeSkillKeywords(skillJson.activation?.keywords),
      useWhen: normalizeSkillKeywords(skillJson.activation?.useWhen),
      doNotUseWhen: normalizeSkillKeywords(skillJson.activation?.doNotUseWhen),
      projectTypes: normalizeSkillKeywords(skillJson.activation?.projectTypes),
      roadmapStages: normalizeSkillKeywords(skillJson.activation?.roadmapStages),
      taskKinds: normalizeSkillKeywords(skillJson.activation?.taskKinds),
      fileGlobs: normalizeSkillKeywords(skillJson.activation?.fileGlobs),
      manualOnly: Boolean(skillJson.activation?.manualOnly)
    },
    risk: {
      hasScripts: Boolean(skillJson.risk?.hasScripts || result.risk?.hasScripts),
      hasExecutables: Boolean(skillJson.risk?.hasExecutables || result.risk?.hasExecutables),
      usesNetwork: skillJson.risk?.usesNetwork ?? result.risk?.usesNetwork ?? 'unknown',
      writesFiles: skillJson.risk?.writesFiles ?? result.risk?.writesFiles ?? 'unknown',
      requiresUserApprovalToRunScripts: skillJson.risk?.requiresUserApprovalToRunScripts !== false
    },
    installedAt: String(skillJson.installedAt || result.installedAt || now),
    updatedAt: now
  };
  const registry = readSolomapSkillRegistry(workspaceRoot, globalDataPath);
  const nextSkills = registry.skills.filter((skill) => skill.id !== skillId);
  nextSkills.push(entry);
  writeSolomapSkillRegistry(workspaceRoot, globalDataPath, { ...registry, skills: nextSkills.sort((a, b) => a.id.localeCompare(b.id)) });
  return { ok: true, message: `Skill installed: ${skillId}`, skillId };
}

function getSolomapMcpRegistryPath(workspaceRoot: string, globalDataPath = ''): string {
  return path.join(getSolomapMcpRoot(workspaceRoot, globalDataPath), 'registry.json');
}

function ensureSolomapMcpStore(workspaceRoot: string, globalDataPath = ''): { mcpRoot: string; serversRoot: string; runsRoot: string; profilesRoot: string; registryPath: string } {
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  const runsRoot = path.join(mcpRoot, 'runs');
  const profilesRoot = path.join(mcpRoot, 'profiles');
  const registryPath = path.join(mcpRoot, 'registry.json');
  [mcpRoot, serversRoot, runsRoot, profilesRoot].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), connectors: [] }, null, 2), 'utf8');
  }
  return { mcpRoot, serversRoot, runsRoot, profilesRoot, registryPath };
}

function readSolomapMcpRegistry(workspaceRoot: string, globalDataPath = ''): SolomapMcpRegistry {
  const registryPath = getSolomapMcpRegistryPath(workspaceRoot, globalDataPath);
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: '', connectors: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: Number(parsed.version || 1),
      updatedAt: String(parsed.updatedAt || ''),
      connectors: Array.isArray(parsed.connectors) ? parsed.connectors : []
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), connectors: [] };
  }
}

function writeSolomapMcpRegistry(workspaceRoot: string, globalDataPath: string, registry: SolomapMcpRegistry): void {
  const { registryPath } = ensureSolomapMcpStore(workspaceRoot, globalDataPath);
  const normalized: SolomapMcpRegistry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connectors: Array.isArray(registry.connectors) ? registry.connectors : []
  };
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2), 'utf8');
}

function scoreSolomapMcp(connector: SolomapMcpRegistryEntry, contextText: string): { score: number; reasons: string[] } {
  if (!connector || connector.status === 'disabled' || connector.status === 'failed') {
    return { score: 0, reasons: [] };
  }
  if (
    connector.activation?.manualOnly ||
    connector.permissions?.requiresCredentials ||
    connector.permissions?.writeAccess === true ||
    connector.risk?.requiresExplicitEnable ||
    connector.risk?.canWriteExternal ||
    connector.risk?.canSendMessages ||
    connector.risk?.canModifyCloudResources ||
    connector.risk?.canAccessSecrets
  ) {
    return { score: 0, reasons: [] };
  }
  const haystack = String(contextText || '').toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  normalizeSkillKeywords(connector.activation?.keywords).forEach((keyword) => {
    if (keyword && haystack.includes(keyword.toLowerCase())) {
      score += 4;
      reasons.push(`keyword:${keyword}`);
    }
  });
  normalizeSkillKeywords(connector.activation?.useWhen).forEach((hint) => {
    if (hint && haystack.includes(hint.toLowerCase())) {
      score += 2;
      reasons.push(`useWhen:${hint.slice(0, 28)}`);
    }
  });
  return { score, reasons };
}

function selectSolomapMcpCandidates(workspaceRoot: string, globalDataPath: string, contextText: string, limit = 3): Array<{ connector: SolomapMcpRegistryEntry; reasons: string[] }> {
  const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  return registry.connectors
    .map((connector) => ({ connector, ...scoreSolomapMcp(connector, contextText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.connector.id.localeCompare(b.connector.id))
    .slice(0, limit)
    .map(({ connector, reasons }) => ({ connector, reasons }));
}

function buildSolomapMcpCandidateInstructions(workspaceRoot: string, globalDataPath: string, contextText: string): string {
  const candidates = selectSolomapMcpCandidates(workspaceRoot, globalDataPath, contextText, 3);
  if (!candidates.length) {
    return '';
  }
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  return [
    'SoloMap 跨 Agent MCP 候选连接器：',
    ...candidates.map(({ connector, reasons }, index) => {
      const configPath = connector.configPath ? path.join(mcpRoot, connector.configPath) : '';
      const tools = normalizeSkillKeywords(connector.permissions?.tools).slice(0, 5).join('、') || '-';
      const useWhen = normalizeSkillKeywords(connector.activation?.useWhen).slice(0, 3).join('；');
      const doNotUseWhen = normalizeSkillKeywords(connector.activation?.doNotUseWhen).slice(0, 3).join('；');
      return [
        `${index + 1}. ${connector.title || connector.id}`,
        `   - 能力：${connector.description || '-'}`,
        `   - 配置：${configPath || '-'}`,
        `   - 工具：${tools}`,
        `   - 适用：${useWhen || '-'}`,
        `   - 不适用：${doNotUseWhen || '-'}`,
        `   - 匹配原因：${reasons.join(', ') || '-'}`
      ].join('\n');
    }),
    'MCP 使用协议：这些只是候选能力连接器，不是强制项。只有当任务明确需要外部工具能力时才使用；涉及外部写入、发消息、云资源、密钥或付费动作时必须先停止并要求用户明确授权。不要自行安装、启用或修改 MCP 配置。最终输出中简短说明本轮是否使用了 MCP。'
  ].join('\n');
}

function buildMcpInstallPrompt(mcpInput: string, workspaceRoot: string, globalDataPath: string, resultFilePath: string): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  return [
    '你正在为 SoloMap 安装一个跨 Agent 通用 MCP 能力连接器。',
    '',
    `项目目录：${workspaceRoot}`,
    `用户提供的 MCP 来源：${mcpInput}`,
    `SoloMap Global 目录：${globalRoot}`,
    `SoloMap MCP 目录：${mcpRoot}`,
    `安装结果 JSON 必须写入：${resultFilePath}`,
    '',
    '目标目录结构：',
    '- `.solomap-global/mcp/servers/<mcp-id>/package/`：完整 MCP server package 或配置说明。',
    '- `.solomap-global/mcp/servers/<mcp-id>/solomap.mcp.json`：SoloMap 统一 MCP 元数据。',
    '- `.solomap-global/mcp/servers/<mcp-id>/source.lock.json`：来源、commit、安装时间、文件 hash 或目录 hash。',
    '- `.solomap-global/mcp/servers/<mcp-id>/profiles/`：不同 Agent CLI 的配置建议片段，例如 codex.json、claude.json、cursor.json、agy.json。',
    '',
    '安装要求：',
    '1. 解析来源。支持 GitHub URL、npm package、MCP server 仓库、文档页或用户粘贴的 server 配置片段。',
    '2. 只做下载、复制、分析和生成配置建议；不要启动 MCP server，不要登录外部服务，不要写入任何 Agent 私有配置目录。',
    '3. 选择稳定 `mcp-id`：只允许小写字母、数字和连字符。',
    '4. 生成 `solomap.mcp.json`。至少包含 id、title、description、status、source、server、profiles、activation、permissions、risk、installedAt、updatedAt。',
    '5. 识别风险：是否需要凭证、是否访问外网、是否可外部写入、是否可发消息、是否可修改云资源、是否可访问密钥；不确定时按高风险处理并设置 `requiresExplicitEnable: true`。',
    '6. 生成各 Agent 的 profile/config 建议，但只写入 `.solomap-global/mcp/servers/<mcp-id>/profiles/`，不要应用到真实 Agent 配置。',
    '',
    '结果 JSON 格式：',
    '{',
    '  "ok": true,',
    '  "mcpId": "mcp-id",',
    '  "installedPath": ".solomap-global/mcp/servers/mcp-id",',
    '  "packagePath": ".solomap-global/mcp/servers/mcp-id/package",',
    '  "solomapMcpJson": ".solomap-global/mcp/servers/mcp-id/solomap.mcp.json",',
    '  "sourceLockJson": ".solomap-global/mcp/servers/mcp-id/source.lock.json",',
    '  "profilesPath": ".solomap-global/mcp/servers/mcp-id/profiles",',
    '  "metadata": { "name": "mcp-id", "description": "...", "version": "..." },',
    '  "source": { "input": "...", "repo": "owner/repo", "commit": "..." },',
    '  "permissions": { "tools": [], "requiresCredentials": false, "externalAccess": "unknown", "writeAccess": "unknown" },',
    '  "risk": { "level": "low|medium|high", "requiresExplicitEnable": true }',
    '}',
    '',
    '失败时也必须写 result.json：',
    '{ "ok": false, "error": "清晰说明失败原因", "source": { "input": "..." } }',
    '',
    '安全边界：不要运行 server，不要写入用户 home 下的 Agent 配置，不要保存明文密钥，不要删除任何已有文件。'
  ].join('\n');
}

function validateAndRegisterMcpInstall(workspaceRoot: string, globalDataPath: string, resultFilePath: string): { ok: boolean; message: string; mcpId?: string } {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const mcpRoot = getSolomapMcpRoot(workspaceRoot, globalDataPath);
  const serversRoot = path.join(mcpRoot, 'servers');
  if (!fs.existsSync(resultFilePath)) {
    return { ok: false, message: 'MCP install result.json was not created.' };
  }
  let result: any;
  try {
    result = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `MCP install result.json is invalid: ${error.message}` };
  }
  if (!result.ok) {
    return { ok: false, message: String(result.error || 'MCP installation failed.') };
  }
  const mcpId = sanitizeAttachmentScope(String(result.mcpId || result.metadata?.name || '').toLowerCase());
  if (!mcpId) {
    return { ok: false, message: 'MCP install result is missing mcpId.' };
  }
  const installedPath = resolveSkillResultPath(globalRoot, result.installedPath || path.join(mcpRoot, 'servers', mcpId));
  const solomapMcpJson = resolveSkillResultPath(globalRoot, result.solomapMcpJson || path.join(installedPath, 'solomap.mcp.json'));
  const sourceLockJson = resolveSkillResultPath(globalRoot, result.sourceLockJson || path.join(installedPath, 'source.lock.json'));
  const profilesPath = resolveSkillResultPath(globalRoot, result.profilesPath || path.join(installedPath, 'profiles'));
  if (!pathInside(serversRoot, installedPath)) {
    return { ok: false, message: 'MCP installedPath is outside SoloMap mcp/servers.' };
  }
  if (![solomapMcpJson, sourceLockJson].every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
    return { ok: false, message: 'MCP package is missing solomap.mcp.json or source.lock.json.' };
  }
  let mcpJson: any;
  try {
    mcpJson = JSON.parse(fs.readFileSync(solomapMcpJson, 'utf8'));
  } catch (error: any) {
    return { ok: false, message: `solomap.mcp.json is invalid: ${error.message}` };
  }
  const now = new Date().toISOString();
  const entry: SolomapMcpRegistryEntry = {
    id: mcpId,
    title: String(mcpJson.title || mcpJson.name || result.metadata?.name || mcpId),
    description: String(mcpJson.description || result.metadata?.description || ''),
    status: String(mcpJson.status || 'installed'),
    source: mcpJson.source || result.source || {},
    serverPath: path.relative(mcpRoot, installedPath).replace(/\\/g, '/'),
    configPath: path.relative(mcpRoot, solomapMcpJson).replace(/\\/g, '/'),
    profiles: mcpJson.profiles || result.profiles || {},
    activation: {
      keywords: normalizeSkillKeywords(mcpJson.activation?.keywords),
      useWhen: normalizeSkillKeywords(mcpJson.activation?.useWhen),
      doNotUseWhen: normalizeSkillKeywords(mcpJson.activation?.doNotUseWhen),
      projectTypes: normalizeSkillKeywords(mcpJson.activation?.projectTypes),
      taskKinds: normalizeSkillKeywords(mcpJson.activation?.taskKinds),
      manualOnly: Boolean(mcpJson.activation?.manualOnly)
    },
    permissions: {
      tools: normalizeSkillKeywords(mcpJson.permissions?.tools || result.permissions?.tools),
      resources: normalizeSkillKeywords(mcpJson.permissions?.resources || result.permissions?.resources),
      prompts: normalizeSkillKeywords(mcpJson.permissions?.prompts || result.permissions?.prompts),
      requiresCredentials: Boolean(mcpJson.permissions?.requiresCredentials || result.permissions?.requiresCredentials),
      credentialRefs: normalizeSkillKeywords(mcpJson.permissions?.credentialRefs || result.permissions?.credentialRefs),
      externalAccess: mcpJson.permissions?.externalAccess ?? result.permissions?.externalAccess ?? 'unknown',
      writeAccess: mcpJson.permissions?.writeAccess ?? result.permissions?.writeAccess ?? 'unknown'
    },
    risk: {
      level: String(mcpJson.risk?.level || result.risk?.level || 'unknown'),
      canWriteExternal: Boolean(mcpJson.risk?.canWriteExternal || result.risk?.canWriteExternal),
      canSendMessages: Boolean(mcpJson.risk?.canSendMessages || result.risk?.canSendMessages),
      canModifyCloudResources: Boolean(mcpJson.risk?.canModifyCloudResources || result.risk?.canModifyCloudResources),
      canAccessSecrets: Boolean(mcpJson.risk?.canAccessSecrets || result.risk?.canAccessSecrets),
      requiresExplicitEnable: Boolean(mcpJson.risk?.requiresExplicitEnable ?? result.risk?.requiresExplicitEnable ?? (mcpJson.permissions?.requiresCredentials || result.permissions?.requiresCredentials))
    },
    installedAt: String(mcpJson.installedAt || result.installedAt || now),
    updatedAt: now
  };
  if (profilesPath && !pathInside(installedPath, profilesPath)) {
    return { ok: false, message: 'MCP profiles path is outside installed MCP directory.' };
  }
  const registry = readSolomapMcpRegistry(workspaceRoot, globalDataPath);
  const nextConnectors = registry.connectors.filter((connector) => connector.id !== mcpId);
  nextConnectors.push(entry);
  writeSolomapMcpRegistry(workspaceRoot, globalDataPath, { ...registry, connectors: nextConnectors.sort((a, b) => a.id.localeCompare(b.id)) });
  return { ok: true, message: `MCP connector installed: ${mcpId}`, mcpId };
}

function buildSoloMapSystemMemoryPrompt(workspaceRoot: string, globalDataPath = ''): string {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const memoryRoot = path.join(globalRoot, 'memory');
  const projectMemoryFile = getProjectMemoryFilePath(workspaceRoot, globalDataPath);
  const learningCandidatesDir = path.join(globalRoot, 'learning', 'candidates');
  return [
    'SoloMap 默认系统提示词：全局经验库机制',
    `- 当前项目目录：${workspaceRoot}`,
    `- 跨项目数据目录：${globalRoot}`,
    `- 全局经验库目录：${memoryRoot}`,
    `- 当前项目记忆文件：${projectMemoryFile}`,
    `- 待沉淀候选目录：${learningCandidatesDir}`,
    '- 开始工作前，按需读取全局经验库中的 `profile.md`、`operating-rules.md`、当前项目记忆、相关 `patterns/`、`decisions/`、`domains/`、`active/` 与 `inbox/`；文件不存在时继续完成本轮任务。',
    '- 写入协议：每个子目录都有 `_example.md` 示例；写入前先读取对应示例，按示例结构新建或追加真实主题文件，不要覆盖 `_example.md`，不要把原始日志、执行流水或用户不需要看的内部过程直接复制进去。',
    '- 写入位置：项目事实写入当前项目记忆；可复用做法写入 `patterns/`；已确认的跨项目决策写入 `decisions/`；领域知识写入 `domains/`；未验证观察写入 `inbox/` 或 `learning/candidates/`；临时交接写入 `active/`。',
    '- 旧 `.codex-memory/` 只作为兼容来源；新的稳定经验优先进入 `.solomap-global/memory`，未验证观察先作为候选进入 `.solomap-global/learning/candidates` 或经验库 `inbox/`。',
    '- 当前用户请求、当前项目文件、测试、日志和命令输出的证据优先级高于经验库；经验库只能帮助理解和减少重复，不能覆盖用户本轮目标。',
    '- 不要把经验库目录结构、实现机制或内部治理负担暴露给普通用户；面向用户的输出只保留能帮助其完成动作的结论、改动、验证和风险。',
    '- 不要自动把某个项目的私有事实泄漏到其他项目；跨项目复用前必须确认其是稳定、可泛化且不含敏感信息的经验。',
    '- 新项目或新环节开始时，必须先做启动注入自检：确认项目类型、当前用户动作、成功标准、可复用经验、相似项目记忆和本轮最窄验证，再开始改动。',
    '- 项目类型用于选择路线图形态：核心产品默认覆盖 Build/Sell/Learn/Improve；基础设施强调契约、接入、版本和兼容；内容产品强调生产、分发和反馈；试验研究允许验证失败但必须沉淀结论；工具脚手架强调可复用入口；归档维护强调稳定性和监控。',
    '- 如果当前是生成初始路线图或调整路线图，必须先把全局方法论转成用户能执行的环节，不要把方法论说明、内部目录结构或维护者自述做成路线图环节。',
    '- 如果当前是普通执行环节，先查询可能相关的项目记忆、patterns、decisions、domains 和学习候选；只有确认可复用且不含项目私有细节时才复用。',
    '- 任务结束时，如发现未来可复用的经验，先以候选或明确建议形式沉淀；只有已验证且稳定的信息才进入长期记忆。'
  ].join('\n');
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
  globalDataPath = ''
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
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n')
  );
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(
    workspaceRoot,
    globalDataPath,
    [node.title, node.stage, node.description, node.agentPrompt, normalizedUserMessage, normalizedGithubIssueContext].join('\n')
  );
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);

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
    ...(supplementFileInstructions ? ['', supplementFileInstructions] : []),
    '',
    solomapMemoryInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
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
  globalDataPath = ''
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
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const githubDeliveryContext = buildGithubDeliveryContext(workspaceRoot);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
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
    solomapMemoryInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(githubDeliveryContext ? ['', githubDeliveryContext] : []),
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
    ...(globalPromptInstructions ? ['', globalPromptInstructions] : []),
    '',
    '执行要求：',
    '1. 先读取当前 `.solopreneur/roadmap.csv`、`.solopreneur/roadmap-methodology.md` 和项目已有文件，理解已经完成的工作与仍待推进的事项。',
    '2. 直接重写 `.solopreneur/roadmap.csv`，让后续环节反映本次调整要求；不要把本段提示词、解释文字或执行日志写进 CSV。',
    '3. 除非用户明确要求推翻已完成工作，否则保留已完成环节的事实和状态，并围绕新方向调整待推进环节、依赖与 Agent 任务。',
    '4. CSV 必须保留字段 `id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt`；每个依赖必须指向存在的环节 ID，且不能自依赖。',
    '5. 先判断项目是否面向外部用户并需要获客或转化：如果是，默认保留问题发现、产品 MVP、营销销售、反馈规模化四阶段，不能退化成只剩工程任务；如果不是，按其真实交付目标调整阶段，不要虚构营销或销售任务。',
    '6. 用 Build -> Sell -> Learn -> Improve 作为底层审查：如果本次调整让商业化项目长期只剩 Build，必须补回分发、反馈或改进闭环；如果项目没有商业化目标，不要为了四阶段制造虚假任务。',
    '7. 不要把四阶段方法论写成用户需要维护的说明环节；它只应用来决定后续路线图和下一步动作。',
    '8. 完成后重新读取 CSV，确认每个环节都有明确标题、描述、适合该项目目标的阶段和可执行的 Agent 任务，再正常退出 CLI。'
  ].join('\n');
}

function buildSoloConversationPrompt(
  userMessage: string,
  workspaceRoot: string,
  globalPrompt = '',
  supplementFiles: string[] = [],
  globalDataPath = ''
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
  const solomapMemoryInstructions = buildSoloMapSystemMemoryPrompt(workspaceRoot, globalDataPath);
  const solomapSkillInstructions = buildSolomapSkillCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapMcpInstructions = buildSolomapMcpCandidateInstructions(workspaceRoot, globalDataPath, normalizedUserMessage);
  const solomapLearningContext = buildSolomapLearningContext(workspaceRoot, globalDataPath);
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
    solomapMemoryInstructions,
    ...(solomapLearningContext ? ['', solomapLearningContext] : []),
    ...(solomapSkillInstructions ? ['', solomapSkillInstructions] : []),
    ...(solomapMcpInstructions ? ['', solomapMcpInstructions] : []),
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
  roadmapBackupFilePath = '',
  globalDataPath = ''
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
  const executionCommand = directExecutionCommand || buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot);
  const statusBase = { nodeId, runKind, roadmapBackupFilePath, globalDataPath, agentCli, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath: decisionFilePath, sessionFilePath, sessionKey, sessionProvider: agentProvider, sessionMode, startedAt };
  const runningStatus = JSON.stringify({ ...statusBase, status: 'Running' });
  const completedStatus = JSON.stringify({ ...statusBase, status: 'In Progress' });
  const failedStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'agent_exit_failed', failureReason: 'Agent CLI exited before completing this task.' });
  const noChangesStatus = JSON.stringify({ ...statusBase, status: 'Failed', failureCode: 'no_deliverable_changes', failureReason: 'Agent exited without project file changes or a completion decision.' });
  const sessionCaptureScript = buildSessionCaptureScript(agentProvider, workspaceRoot, startedAtFilePath, outputFilePath, sessionFilePath);
  const workspaceSnapshotScript = buildWorkspaceSnapshotScript(workspaceRoot, workspaceSnapshotPath);
  const workspaceDiffScript = buildWorkspaceDiffScript(workspaceRoot, workspaceSnapshotPath, touchedFilesPath);
  const promptExportScript = directExecutionCommand
    ? [`agent_prompt=$(cat ${shellQuote(promptFilePath)})`, 'export agent_prompt']
    : [];
  const terminalExecutionScript = [
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
    ...promptExportScript,
    terminalExecutionScript,
    sessionCaptureScript,
    `git -C ${shellQuote(workspaceRoot)} status --short > ${shellQuote(changesFilePath)} 2>/dev/null || true`,
    workspaceDiffScript,
    `if [ ${shellQuote(runKind)} != 'solo' ] && [ $status -eq 0 ] && [ ! -s ${shellQuote(changesFilePath)} ] && [ ! -s ${shellQuote(touchedFilesPath)} ] && ! grep -q '"markCompleted"[[:space:]]*:[[:space:]]*true' ${shellQuote(decisionFilePath)} 2>/dev/null; then status=125; printf '\\nSoloMap: Agent exited without project file changes or a completion decision. Marking this run as failed so it can be retried.\\n' >> ${shellQuote(outputFilePath)}; printf %s ${shellQuote(noChangesStatus)} > ${shellQuote(statusFilePath)}; elif [ $status -eq 0 ]; then printf %s ${shellQuote(completedStatus)} > ${shellQuote(statusFilePath)}; else printf %s ${shellQuote(failedStatus)} > ${shellQuote(statusFilePath)}; fi`
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
      stage: '目标与路径确认',
      dependencies: '',
      agentCli: cliPath,
      agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md 和 .solopreneur/roadmap-methodology.md，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后按指令文件中的自检要求重新读取并校验该 CSV。',
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

function postNodeConversations(nodeId: string): void {
  if (syncEngine && activePanel) {
    activePanel.webview.postMessage({
      command: 'nodeConversationsLoaded',
      nodeId,
      conversations: syncEngine.getAgentExecutions(nodeId),
      projectPath: activeProjectRoot || ''
    });
  }
  if (nodeId === soloConversationId && sidebarProvider && activeProjectRoot) {
    void sidebarProvider.sendSoloConversationHistory(activeProjectRoot);
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

function getSkillInstallWorkspaceRoot(context: vscode.ExtensionContext): string {
  return activeProjectRoot || getSelectedProjectPath(context) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function postMcpInstallResult(success: boolean, message: string): void {
  activePanel?.webview.postMessage({ command: 'mcpInstallResult', success, message });
  sidebarProvider?.postMcpInstallResult(success, message);
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
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot);
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
      activePanel?.webview.postMessage({ command: 'skillInstallResult', success: true, message: validation.message });
      sidebarProvider?.postSkillInstallResult(true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap skill install failed validation: ${validation.message}`);
      activePanel?.webview.postMessage({ command: 'skillInstallResult', success: false, message: validation.message });
      sidebarProvider?.postSkillInstallResult(false, validation.message);
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
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, workspaceRoot);
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
      postMcpInstallResult(true, validation.message);
    } else {
      vscode.window.showErrorMessage(`SoloMap MCP install failed validation: ${validation.message}`);
      postMcpInstallResult(false, validation.message);
    }
  }, 2000);
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
  if (syncEngine?.getAgentExecutions(soloConversationId).some((conversation) => conversation.status === 'Running')) {
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

  if (nodeId !== roadmapRevisionId && nodeId !== soloConversationId) {
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

async function handleRoadmapRevision(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', supplementFiles: string[] = []): Promise<void> {
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
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const conversationPrompt = buildRoadmapRevisionPrompt(revisionRequest, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptFilePath, activeProjectRoot);
  const executionLogId = syncEngine.logAgentExecution(
    roadmapRevisionId,
    agentCli,
    agentCommand,
    [
      'Roadmap revision started.',
      `Run started at: ${new Date().toISOString()}`,
      `User supplement:\n${revisionRequest}`,
      attachedFiles.length > 0 ? `Supplement files:\n${attachedFiles.join('\n')}` : ''
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
    roadmapBackupFilePath,
    settings.globalDataPath
  );
  const terminal = createAgentTerminal(activeProjectRoot, `revision-${executionLogId}`);
  terminal.show(true);
  terminal.sendText(finalCommand);
}

async function handleRunSoloConversation(context: vscode.ExtensionContext, userMessage: string, selectedAgentCli = '', supplementFiles: string[] = []): Promise<void> {
  if (!syncEngine || !activeProjectRoot) {
    return;
  }
  const request = userMessage.trim();
  if (!request) {
    vscode.window.showWarningMessage('Describe what you want to handle before starting a Solo conversation.');
    return;
  }

  await syncEngine.initAndSync();
  const nodes = syncEngine.getNodes();
  if (hasRunningAgentConversation(activeProjectRoot, nodes)) {
    vscode.window.showWarningMessage('Another Agent conversation is running. Open or stop it before starting Solo.');
    return;
  }

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

  const runDir = path.join(activeProjectRoot, '.solopreneur', 'agent-runs', soloConversationId);
  const roadmapPath = path.join(activeProjectRoot, '.solopreneur', 'roadmap.csv');
  const roadmapBackupFilePath = path.join(runDir, 'roadmap-before.csv');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapBackupFilePath, fs.readFileSync(roadmapPath, 'utf8'), 'utf8');
  }
  ensureSolomapMemoryStore(activeProjectRoot, settings.globalDataPath);
  const storedSession = getStoredAgentSession(activeProjectRoot, soloConversationId, agentCli);
  const nativeSessionId = storedSession?.sessionId || '';
  const attachedFiles = filterProjectRelativeFiles(activeProjectRoot, supplementFiles);
  const conversationPrompt = buildSoloConversationPrompt(request, activeProjectRoot, settings.globalPrompt, attachedFiles, settings.globalDataPath);
  const agentCommand = buildAgentCommandForPromptFile(agentCli, path.join(runDir, 'prompt.txt'), activeProjectRoot);
  const executionLogId = syncEngine.logAgentExecution(
    soloConversationId,
    agentCli,
    agentCommand,
    [
      'Solo conversation started.',
      `Run started at: ${new Date().toISOString()}`,
      nativeSessionId
        ? `Starting a new native ${getAgentProvider(agentCli)} session. Previous session available as optional reference: ${nativeSessionId}`
        : `Starting a new native ${getAgentProvider(agentCli)} session.`,
      `User supplement:\n${request}`,
      attachedFiles.length > 0 ? `Attached files:\n${attachedFiles.join('\n')}` : ''
    ].filter(Boolean).join('\n\n'),
    'Running'
  );
  postNodeConversations(soloConversationId);

  const { finalCommand } = buildAgentShellScript(
    agentCli,
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
    settings.globalDataPath
  );
  const terminal = createAgentTerminal(activeProjectRoot, `solo-${executionLogId}`);
  terminal.show(true);
  terminal.sendText(finalCommand);
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
  if (syncEngine.getAgentExecutions(nodeId).some((entry) => String(entry.output || '').includes(marker))) {
    vscode.window.showInformationMessage('This Solo conversation is already associated with that step.');
    return;
  }
  syncEngine.logAgentExecution(
    nodeId,
    conversation.agentCli,
    conversation.command,
    [
      'Linked from Solo conversation.',
      marker,
      `Linked at: ${new Date().toISOString()}`,
      `Original Solo status: ${conversation.status}`,
      '',
      conversation.output
    ].join('\n'),
    'Linked'
  );
  postNodeConversations(nodeId);
  postNodeConversations(soloConversationId);
  vscode.window.showInformationMessage(`Solo conversation associated with step: ${node.title}`);
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
  const githubIssueContext = buildGithubIssueContext(workspaceRoot, node);
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
    settings.globalDataPath
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

  const { finalCommand } = buildAgentShellScript(agentCli, conversationPrompt, workspaceRoot, nodeId, executionLogId, userMessage.trim(), completionDecisionFilePath, nativeSessionId, '', 'step', '', settings.globalDataPath);

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
  if (nodeId === soloConversationId) {
    await handleRunSoloConversation(context, retryUserMessage, conversation.agentCli || '');
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
    const { nodeId, runKind, roadmapBackupFilePath, globalDataPath, status, agentCli, command, commandPreview, commandFilePath, executionLogId, userMessage, outputFilePath, changesFilePath, touchedFilesPath, completionDecisionFilePath, sessionFilePath, sessionMode, startedAt } = statusData;

    if (!nodeId || !status || status === 'Running' || !syncEngine) {
      return;
    }

    const isSoloConversation = runKind === 'solo' || nodeId === soloConversationId;
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
    // User-confirmed completion remains authoritative over any in-flight Agent result.
    const preserveCompletedNode = currentNode?.status === 'Completed';
    let shouldWriteNodeStatus = !preserveCompletedNode && !isSoloConversation;
    let shouldRefreshRoadmap = false;
    if (workspaceRoot && isSoloConversation) {
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
    const handoffEntry = workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation
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
    if (workspaceRoot && runKind !== 'roadmap_revision' && !isSoloConversation) {
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
    const executionSummary = [
      userMessage ? `User supplement:\n${userMessage}` : '',
      sessionMode ? `Native session mode: ${sessionMode}` : '',
      nativeSessionSummary,
      `Sentinel captured state: ${status}`,
      isSoloConversation ? `Solo conversation state: ${nextStatus}` : `Roadmap step state: ${nextStatus}`,
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
      if (preserveCompletedNode && nodeId !== roadmapRevisionId && syncEngine.getNodes().some((node) => node.id === nodeId)) {
        syncEngine.updateNode(nodeId, {
          status: 'Completed',
          completedAt: currentNode?.completedAt || new Date().toISOString()
        });
      }
    }

    sendNodesToWebview();
    postNodeConversations(nodeId);
    if (!isSoloConversation && nextStatus === 'Completed' && !hasRecordedWorkspaceChanges(changedFilesSummary, touchedFilesSummary)) {
      vscode.window.showWarningMessage(`Agent task [${nodeId}] completed, but no workspace file changes were detected.`);
    } else if (isSoloConversation) {
      vscode.window.showInformationMessage(`Solo conversation finished with state: ${nextStatus}`);
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
    }

    .project-property-select {
      width: clamp(96px, 10vw, 150px);
      min-width: 0;
    }

    .solo-select {
      position: relative;
      min-width: 0;
      font-size: 12px;
    }

    .solo-select-trigger {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 7px;
      font: inherit;
      font-weight: 400;
      cursor: pointer;
      text-align: left;
    }

    .solo-select-trigger:hover {
      transform: none;
      box-shadow: none;
      border-color: rgba(0, 229, 255, 0.38);
    }

    .solo-select-trigger-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .solo-select-caret {
      flex-shrink: 0;
      font-size: 13px;
      color: var(--text-muted);
      transition: transform 0.18s ease;
    }

    .solo-select.open .solo-select-caret {
      transform: rotate(180deg);
    }

    .solo-select.open .solo-select-trigger,
    .solo-select-trigger:focus {
      outline: none;
      border-color: rgba(0, 229, 255, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18);
    }

    .solo-select-menu {
      display: none;
      position: absolute;
      top: calc(100% + 5px);
      left: 0;
      right: 0;
      z-index: 120;
      padding: 5px;
      max-height: 224px;
      overflow-y: auto;
      border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 9px;
      background: #141a29;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.48);
    }

    .solo-select.open .solo-select-menu {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .solo-select-option {
      padding: 8px 9px;
      background: transparent;
      border-radius: 6px;
      color: var(--text-main);
      font: inherit;
      font-weight: 400;
      text-align: left;
      cursor: pointer;
    }

    .solo-select-option:hover,
    .solo-select-option[aria-selected="true"] {
      transform: none;
      box-shadow: none;
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
    }

    .solo-select.is-disabled {
      opacity: 0.55;
    }

    .solo-select.is-disabled .solo-select-trigger {
      cursor: not-allowed;
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

    .view-tabs {
      display: flex;
      gap: 8px;
      padding: 10px 24px 0;
      background: rgba(15, 17, 26, 0.7);
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      z-index: 8;
    }

    .view-tab {
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .view-tab:hover,
    .view-tab.active {
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
      border-color: rgba(0, 229, 255, 0.32);
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.18);
    }

    .view-tab.solo-tab.active {
      color: #fff;
      background: rgba(124, 77, 255, 0.36);
      border-color: rgba(167, 139, 250, 0.68);
      box-shadow: 0 0 12px rgba(124, 77, 255, 0.28);
    }

    .view-panel {
      display: none;
    }

    .view-panel.active {
      display: flex;
    }

    .roadmap-canvas.view-panel:not(.active),
    .solo-view.view-panel:not(.active) {
      display: none;
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

    .solo-view {
      flex: 1;
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      background: radial-gradient(circle at 50% 50%, rgba(35, 24, 66, 0.45) 0%, rgba(10, 12, 22, 0.95) 100%);
      flex-direction: column;
      align-items: center;
    }

    .solo-view-inner {
      width: min(860px, 100%);
      display: flex;
      flex-direction: column;
      gap: 14px;
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

    .solo-conversation-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .solo-conversation-body .conversation-composer {
      margin-top: 0;
    }

    .solo-closure {
      border-top: 1px solid var(--border-glass);
      margin-top: 10px;
      padding-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .solo-closure-title {
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
    }

    .solo-closure-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .solo-link-select {
      flex: 1 1 180px;
      min-width: 150px;
    }

    .solo-action-btn {
      font-size: 11px;
      padding: 8px 10px;
      white-space: nowrap;
    }

    .solo-action-btn.secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
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

    .methodology-shell {
      width: 100%;
      max-width: min(920px, 100%);
      position: relative;
      z-index: 3;
    }

    .methodology-overview {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .methodology-stage-card {
      width: 100%;
      min-width: 0;
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
      cursor: pointer;
    }

    .methodology-stage-card:hover,
    .methodology-stage-card.active {
      border-color: rgba(0, 229, 255, 0.52);
      background: rgba(0, 229, 255, 0.10);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.10), 0 12px 30px rgba(0, 0, 0, 0.22);
      transform: none;
    }

    .methodology-stage-card.missing {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.42);
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12);
    }

    .methodology-stage-card.missing.active {
      background: rgba(245, 158, 11, 0.18);
      border-color: rgba(245, 158, 11, 0.62);
    }

    .methodology-stage-name {
      font-size: 12px;
      font-weight: 800;
      line-height: 1.1;
    }

    .methodology-stage-meta {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.35;
    }

    .methodology-adjust-btn {
      align-self: flex-start;
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.14);
      color: #fde68a;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
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

    .node-row.stage-highlight .node-card {
      border-color: rgba(0, 229, 255, 0.65);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.16), 0 0 32px rgba(0, 229, 255, 0.14);
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
      align-items: stretch;
      min-width: 0;
    }

    .conversation-compose input {
      flex: 1;
      width: auto;
      min-width: 0;
      min-height: 34px;
    }

    .conversation-tool-btn {
      width: 34px;
      min-height: 34px;
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
      min-height: 34px;
      font-size: 12px;
      flex-shrink: 0;
    }

    .btn-send-conversation {
      min-width: 42px;
      min-height: 34px;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }

    .conversation-compose input:disabled,
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

    .onboarding-panel {
      width: min(560px, calc(100vw - 48px));
      margin: 48px auto 0;
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(124, 77, 255, 0.08));
      padding: 18px;
      box-sizing: border-box;
    }

    .onboarding-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #7dd3fc;
      font-size: 11px;
      font-weight: 800;
      margin-bottom: 9px;
    }

    .onboarding-title {
      color: var(--text-main);
      font-size: 20px;
      font-weight: 800;
      line-height: 1.22;
      margin-bottom: 8px;
    }

    .onboarding-copy {
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 14px;
    }

    .onboarding-steps {
      display: grid;
      gap: 9px;
      margin-bottom: 16px;
    }

    .onboarding-step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: var(--text-main);
      font-size: 12px;
      line-height: 1.45;
    }

    .onboarding-step-index {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.24);
      color: #a5f3fc;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
    }

    .onboarding-action {
      border: none;
      border-radius: 6px;
      padding: 9px 13px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
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

    .settings-input {
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

    .settings-input:focus, .settings-textarea:focus {
      border-color: #00e5ff;
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

      .methodology-overview {
        grid-template-columns: repeat(2, minmax(0, 1fr));
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
      .btn-solo,
      .btn-roadmap-revision {
        width: 34px;
        min-width: 34px;
      }

      .node-card {
        padding: 16px;
      }

      .methodology-overview {
        grid-template-columns: 1fr;
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
        <div class="solo-select project-select" id="project-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <div class="solo-select project-property-select" id="project-type-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <div class="solo-select project-property-select" id="project-priority-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
        <button class="btn-project-remove" id="btn-remove-project" title="Remove project"><span class="codicon codicon-trash"></span></button>
        <button class="btn-roadmap-revision" id="btn-toggle-roadmap-revision" title="Revise Roadmap"><span class="codicon codicon-git-compare"></span></button>
        <button class="btn-gear" id="btn-toggle-settings" title="SoloMap Settings"><span class="codicon codicon-settings-gear"></span></button>
      </div>
    </header>

    <div class="view-tabs" role="tablist">
      <button class="view-tab active" id="btn-toggle-roadmap-view" type="button"><span class="codicon codicon-map"></span><span id="roadmap-view-tab-label">路线图</span></button>
      <button class="view-tab solo-tab" id="btn-toggle-solo" type="button"><span class="codicon codicon-comment-discussion"></span><span id="solo-view-tab-label">Solo</span></button>
    </div>

    <div class="roadmap-canvas view-panel active" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>

    <div class="solo-view view-panel" id="solo-panel">
      <div class="solo-view-inner">
        <div class="solo-conversation-body" id="solo-body"></div>
      </div>
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
      <div class="solo-select settings-select" id="setting-language" data-solo-select data-value="zh">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>中文</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="zh" aria-selected="true">中文</button>
          <button type="button" class="solo-select-option" data-solo-option-value="en" aria-selected="false">English</button>
        </div>
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <div class="settings-cli-select-wrap">
        <div class="solo-select settings-select" id="setting-cli-select" data-solo-select data-value="agy">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>agy</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox">
            <button type="button" class="solo-select-option" data-solo-option-value="agy" aria-selected="true">agy</button>
            <button type="button" class="solo-select-option" data-solo-option-value="codex" aria-selected="false">codex</button>
            <button type="button" class="solo-select-option" data-solo-option-value="cursor" aria-selected="false">cursor</button>
            <button type="button" class="solo-select-option" data-solo-option-value="copilot" aria-selected="false">copilot</button>
            <button type="button" class="solo-select-option" data-solo-option-value="claude" aria-selected="false">claude</button>
            <button type="button" class="solo-select-option" data-solo-option-value="opencode" aria-selected="false">opencode</button>
            <button type="button" class="solo-select-option" data-solo-option-value="custom" aria-selected="false">Custom...</button>
          </div>
        </div>
        <input
          type="text"
          class="settings-input"
          id="setting-clipath-custom"
          placeholder="e.g. /usr/local/bin/cursor-cli or my-copilot"
          style="display:none; margin-top: 6px;"
        >
      </div>
      <div id="help-cli-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code>, <code>codex</code>, <code>cursor</code>, <code>claude</code>, <code>copilot</code>, <code>opencode</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-data-path">Global Data Directory</label>
      <input
        type="text"
        class="settings-input"
        id="setting-global-data-path"
        placeholder="e.g. /home/ubuntu/project/.solomap-global"
      >
      <div id="help-global-data-path" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Directory used to store cross-project SoloMap data such as portfolio, dependencies, learning candidates, and metrics.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-prompt">Default Agent Instructions</label>
      <textarea class="settings-input settings-textarea" id="setting-global-prompt" placeholder="e.g. Always keep changes minimal and run the narrowest relevant test."></textarea>
      <div id="help-global-prompt" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Injected into every task conversation. Instructions added in a step conversation take priority.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-skill-install">Install Skill</label>
      <input
        type="text"
        class="settings-input"
        id="setting-skill-input"
        placeholder="e.g. https://skills.sh/owner/repo or owner/repo@skill"
      >
      <div id="help-skill-install" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Paste a skills.sh or GitHub skill link. SoloMap will install it into the global skill library.
      </div>
      <button class="settings-action-btn test-btn" id="btn-install-skill" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-cloud-download"></span><span id="text-install-skill">Install Skill</span></button>
      <div class="cli-badge" id="skill-install-badge" style="display:none;"></div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-mcp-install">Install Connector</label>
      <input
        type="text"
        class="settings-input"
        id="setting-mcp-input"
        placeholder="e.g. GitHub MCP server URL, npm package, or config snippet"
      >
      <div id="help-mcp-install" style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Paste an MCP connector source. SoloMap will register it as a global ability connector.
      </div>
      <button class="settings-action-btn test-btn" id="btn-install-mcp" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-plug"></span><span id="text-install-mcp">Install Connector</span></button>
      <div class="cli-badge" id="mcp-install-badge" style="display:none;"></div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-feedback">Feedback</label>
      <input
        type="text"
        class="settings-input"
        id="setting-feedback-title"
        placeholder="What should be improved?"
      >
      <textarea class="settings-input settings-textarea" id="setting-feedback-body" placeholder="Add what happened and what you expected." style="min-height: 54px; margin-top: 5px;"></textarea>
      <button class="settings-action-btn test-btn" id="btn-open-feedback" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-github"></span><span id="text-open-feedback">Send Feedback</span></button>
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
    const btnToggleRoadmapView = document.getElementById('btn-toggle-roadmap-view');
    const btnToggleSolo = document.getElementById('btn-toggle-solo');
    const soloPanel = document.getElementById('solo-panel');
    const soloBody = document.getElementById('solo-body');
    const btnToggleRoadmapRevision = document.getElementById('btn-toggle-roadmap-revision');
    const btnCloseRoadmapRevision = document.getElementById('btn-close-roadmap-revision');
    const roadmapRevisionPanel = document.getElementById('roadmap-revision-panel');
    const roadmapRevisionBody = document.getElementById('roadmap-revision-body');

    // Settings Panel elements
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliSelect = document.getElementById('setting-cli-select');
    const settingCliPathCustom = document.getElementById('setting-clipath-custom');
    const settingLanguage = document.getElementById('setting-language');
    const settingGlobalPrompt = document.getElementById('setting-global-prompt');
    const settingGlobalDataPath = document.getElementById('setting-global-data-path');
    const settingSkillInput = document.getElementById('setting-skill-input');
    const btnInstallSkill = document.getElementById('btn-install-skill');
    const skillInstallBadge = document.getElementById('skill-install-badge');
    const settingMcpInput = document.getElementById('setting-mcp-input');
    const btnInstallMcp = document.getElementById('btn-install-mcp');
    const mcpInstallBadge = document.getElementById('mcp-install-badge');
    const settingFeedbackTitle = document.getElementById('setting-feedback-title');
    const settingFeedbackBody = document.getElementById('setting-feedback-body');
    const btnOpenFeedback = document.getElementById('btn-open-feedback');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    const projectTypeSelect = document.getElementById('project-type-select');
    const projectPrioritySelect = document.getElementById('project-priority-select');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let expandedNodeId = '';
    let activeMethodologyStage = '';
    let activeConversationId = '';
    let activeProjectPath = '';
    let currentCliPath = 'agy';
    let activeMainView = 'roadmap';
    let currentRoadmapLoading = false;
    const roadmapRevisionId = '__roadmap_revision__';
    const soloConversationId = '__solo__';
    let roadmapRevisionExpanded = false;
    let soloExpanded = false;
    const nodeConversations = {};
    const nodeSupplementFiles = {};
    const conversationDrafts = {};
    const i18n = {
      zh: {
        title: 'SoloMap',
        addProject: '添加项目文件夹',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        removeProject: '删除项目',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、cursor、claude、copilot、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        globalDataPath: '跨项目数据目录',
        globalDataPathPlaceholder: '例如：/home/ubuntu/project/.solomap-global',
        globalDataPathHelp: '保存跨项目组合、依赖、学习候选和指标；可填 .solomap-global 目录路径，或填其父目录。',
        skillInstall: '安装技能',
        skillInstallPlaceholder: '例如：https://skills.sh/owner/repo 或 owner/repo@skill',
        skillInstallHelp: '粘贴 skills.sh 或 GitHub 技能链接，SoloMap 会安装到全局技能库。',
        installSkill: '安装技能',
        installingSkill: '正在启动安装...',
        mcpInstall: '安装连接器',
        mcpInstallPlaceholder: '例如：GitHub MCP server、npm 包名或配置片段',
        mcpInstallHelp: '粘贴 MCP 来源，SoloMap 会注册到全局能力连接器库。',
        installMcp: '安装连接器',
        installingMcp: '正在启动安装...',
        feedback: '建议反馈',
        feedbackTitlePlaceholder: '一句话说明想反馈的问题...',
        feedbackBodyPlaceholder: '补充现象、期望结果或改进建议...',
        openFeedback: '提交到 GitHub Issue',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。请添加项目文件夹，或重新打开当前项目。',
        onboardingKicker: '新手开始',
        onboardingTitle: '先把一个项目交给 SoloMap',
        onboardingCopy: '选择一个本地项目文件夹。SoloMap 会带你确认项目类型，然后生成第一张可推进路线图。',
        onboardingStepProject: '添加本地项目文件夹',
        onboardingStepType: '选择这个项目更像哪一类',
        onboardingStepRoadmap: '在“生成初始路线图”里输入目标，让 Agent 产出第一版路线图',
        onboardingAction: '添加第一个项目',
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
        roadmapView: '路线图',
        soloTitle: '直接开始',
        soloPlaceholder: '描述你现在想处理的问题或想法...',
        soloHistory: 'Solo 对话历史',
        noSoloConversations: '还没有 Solo 对话。',
        sendSolo: '发送',
        soloCompleted: '本次 Solo 对话已结束。',
        soloClosure: '这次对话是否需要进入路线图？',
        linkToStep: '关联到环节',
        keepInSolo: '无需关联时，这次对话会保留在 Solo。',
        adjustRoadmap: '调整路线图',
        chooseStep: '选择关联环节',
        linkedFromSolo: '这是一条从 Solo 关联的参考记录，不会改变环节状态。',
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
        roadmapLoading: '正在打开路线图...',
        methodologyBuild: '打造',
        methodologySell: '触达',
        methodologyLearn: '学习',
        methodologyImprove: '改进',
        methodologyMissing: '缺少对应环节',
        methodologyCompleted: '已完成',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败', Linked: '已关联' }
      },
      en: {
        title: 'SoloMap',
        addProject: 'Add project folder',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        removeProject: 'Remove project',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, cursor, claude, copilot, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; guidance in the current conversation takes priority.',
        globalDataPath: 'Global Data Directory',
        globalDataPathPlaceholder: 'e.g. /home/ubuntu/project/.solomap-global',
        globalDataPathHelp: 'Stores cross-project portfolio, dependencies, learning candidates, and metrics. Use the .solomap-global path or its parent directory.',
        skillInstall: 'Install Skill',
        skillInstallPlaceholder: 'e.g. https://skills.sh/owner/repo or owner/repo@skill',
        skillInstallHelp: 'Paste a skills.sh or GitHub skill link. SoloMap installs it into the global skill library.',
        installSkill: 'Install Skill',
        installingSkill: 'Starting install...',
        mcpInstall: 'Install Connector',
        mcpInstallPlaceholder: 'e.g. GitHub MCP server, npm package, or config snippet',
        mcpInstallHelp: 'Paste an MCP source. SoloMap registers it in the global connector library.',
        installMcp: 'Install Connector',
        installingMcp: 'Starting install...',
        feedback: 'Feedback',
        feedbackTitlePlaceholder: 'Summarize the issue or idea...',
        feedbackBodyPlaceholder: 'Add what happened, what you expected, or the suggestion...',
        openFeedback: 'Open GitHub Issue',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Add a project folder or reopen the current project.',
        onboardingKicker: 'Get started',
        onboardingTitle: 'Give SoloMap one local project first',
        onboardingCopy: 'Choose a local project folder. SoloMap will ask for its type, then help create the first actionable roadmap.',
        onboardingStepProject: 'Add a local project folder',
        onboardingStepType: 'Choose what kind of project it is',
        onboardingStepRoadmap: 'Use "Generate Initial Roadmap" to describe the goal and let the Agent create the first roadmap',
        onboardingAction: 'Add first project',
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
        roadmapView: 'Roadmap',
        soloTitle: 'Start directly',
        soloPlaceholder: 'Describe the issue or idea you want to handle...',
        soloHistory: 'Solo conversation history',
        noSoloConversations: 'No Solo conversations yet.',
        sendSolo: 'Send',
        soloCompleted: 'This Solo conversation has finished.',
        soloClosure: 'Should this conversation be connected to the roadmap?',
        linkToStep: 'Link to step',
        keepInSolo: 'Leave unlinked to keep this conversation in Solo.',
        adjustRoadmap: 'Revise roadmap',
        chooseStep: 'Choose a step',
        linkedFromSolo: 'This is a reference linked from Solo and does not change the step state.',
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
        roadmapLoading: 'Opening roadmap...',
        methodologyBuild: 'Build',
        methodologySell: 'Sell',
        methodologyLearn: 'Learn',
        methodologyImprove: 'Improve',
        methodologyMissing: 'Missing step',
        methodologyCompleted: 'completed',
        status: { Pending: 'Pending', 'In Progress': 'In Progress', Running: 'Running', Completed: 'Completed', Failed: 'Failed', Linked: 'Linked' }
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
      activeMethodologyStage = '';
      roadmapRevisionExpanded = false;
      soloExpanded = false;
      activeConversationId = '';
      if (soloPanel) soloPanel.classList.remove('open');
      if (soloPanel) soloPanel.classList.remove('active');
      if (canvas) canvas.classList.add('active');
      if (btnToggleRoadmapView) btnToggleRoadmapView.classList.add('active');
      if (btnToggleSolo) btnToggleSolo.classList.remove('active');
      if (soloBody) soloBody.innerHTML = '';
      if (roadmapRevisionPanel) roadmapRevisionPanel.classList.remove('open');
      if (btnToggleRoadmapRevision) btnToggleRoadmapRevision.classList.remove('active');
      if (roadmapRevisionBody) roadmapRevisionBody.innerHTML = '';
      Object.keys(nodeConversations).forEach(key => delete nodeConversations[key]);
      Object.keys(nodeSupplementFiles).forEach(key => delete nodeSupplementFiles[key]);
      Object.keys(conversationDrafts).forEach(key => delete conversationDrafts[key]);
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      btnAddProject.title = t('addProject');
      btnRemoveProject.title = t('removeProject');
      btnToggleSolo.title = t('soloTitle');
      setText('roadmap-view-tab-label', t('roadmapView'));
      setText('solo-view-tab-label', 'Solo');
      btnToggleRoadmapRevision.title = t('reviseRoadmap');
      setText('settings-title', t('settingsTitle'));
      setText('roadmap-revision-title', t('reviseRoadmap'));
      setText('solo-title', t('soloTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-global-prompt', t('globalPrompt'));
      settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('label-global-data-path', t('globalDataPath'));
      if (settingGlobalDataPath) settingGlobalDataPath.placeholder = t('globalDataPathPlaceholder');
      setText('help-global-data-path', t('globalDataPathHelp'));
      setText('label-skill-install', t('skillInstall'));
      if (settingSkillInput) settingSkillInput.placeholder = t('skillInstallPlaceholder');
      setText('help-skill-install', t('skillInstallHelp'));
      setText('text-install-skill', t('installSkill'));
      setText('label-mcp-install', t('mcpInstall'));
      if (settingMcpInput) settingMcpInput.placeholder = t('mcpInstallPlaceholder');
      setText('help-mcp-install', t('mcpInstallHelp'));
      setText('text-install-mcp', t('installMcp'));
      setText('label-feedback', t('feedback'));
      if (settingFeedbackTitle) settingFeedbackTitle.placeholder = t('feedbackTitlePlaceholder');
      if (settingFeedbackBody) settingFeedbackBody.placeholder = t('feedbackBodyPlaceholder');
      setText('text-open-feedback', t('openFeedback'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderRoadmap(currentNodes);
      renderSoloPanel(currentNodes);
      renderRoadmapRevisionPanel(currentNodes);
    }

    const currentProjects = { projects: [], selectedProjectPath: '' };

    function setMainView(view) {
      activeMainView = view === 'solo' ? 'solo' : 'roadmap';
      soloExpanded = activeMainView === 'solo';
      activeConversationId = '';
      canvas.classList.toggle('active', activeMainView === 'roadmap');
      soloPanel.classList.toggle('active', activeMainView === 'solo');
      btnToggleRoadmapView.classList.toggle('active', activeMainView === 'roadmap');
      btnToggleSolo.classList.toggle('active', activeMainView === 'solo');
      if (activeMainView === 'solo' && !nodeConversations[soloConversationId]) {
        vscode.postMessage({ command: 'getNodeConversations', nodeId: soloConversationId });
      }
      renderSoloPanel(currentNodes);
    }

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

    btnToggleRoadmapView.addEventListener('click', () => {
      setMainView('roadmap');
    });

    btnToggleSolo.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
      roadmapRevisionExpanded = false;
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      setMainView('solo');
    });

    btnToggleRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = !roadmapRevisionExpanded;
      activeConversationId = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (roadmapRevisionExpanded) {
        settingsPanel.style.display = 'none';
        cliTestBadge.style.display = 'none';
        setMainView('roadmap');
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

    bindSoloSelect(settingLanguage, (value) => {
      currentLanguage = value;
      applyLanguage();
    });

    bindSoloSelect(settingCliSelect, () => {
      currentCliPath = getEffectiveSettingCliPath();
      // Toggle custom input visibility; the label is handled by solo-select itself.
      const selected = getSoloSelectValue(settingCliSelect);
      settingCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
    });

    function getCliPresetFromCliPath(cliPath) {
      const raw = String(cliPath || '').trim();
      if (!raw) return 'agy';
      // NOTE: this code runs inside a Webview <script> string; escaping must survive TS template literal parsing.
      if (raw.includes('/') || raw.includes('\\\\')) return 'custom';
      const base = raw.split(/[\\\\/]/).pop().toLowerCase();
      if (['agy', 'antigravity', 'antigravity-cli'].includes(base)) return 'agy';
      if (['codex', 'codex-cli'].includes(base)) return 'codex';
      if (['cursor', 'cursor-cli'].includes(base)) return 'cursor';
      if (['copilot', 'copilot-cli'].includes(base)) return 'copilot';
      if (['claude', 'claude-code', 'claude-code-cli'].includes(base)) return 'claude';
      if (['opencode', 'open-code', 'open-code-cli'].includes(base)) return 'opencode';
      return 'custom';
    }

    function getEffectiveSettingCliPath() {
      const selected = getSoloSelectValue(settingCliSelect);
      if (selected === 'custom') {
        return (settingCliPathCustom.value || '').trim() || 'agy';
      }
      return selected || 'agy';
    }

    function applySettingCliPath(cliPath) {
      const raw = String(cliPath || '').trim() || 'agy';
      const preset = getCliPresetFromCliPath(raw);
      setSoloSelectValue(settingCliSelect, preset);
      if (preset === 'custom') {
        settingCliPathCustom.value = raw;
        settingCliPathCustom.style.display = 'block';
      } else {
        settingCliPathCustom.value = '';
        settingCliPathCustom.style.display = 'none';
      }
      currentCliPath = getEffectiveSettingCliPath();
    }

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
        const soloRunning = (nodeConversations[soloConversationId] || [])
          .some(conversation => conversation.status === 'Running');
        if (soloExpanded && soloRunning) {
          renderSoloPanel(currentNodes);
        }
      }, 1000);
    }

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'roadmapLoading':
          currentRoadmapLoading = true;
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, true);
          }
          renderRoadmap(currentNodes);
          break;
        case 'nodesUpdated':
          currentRoadmapLoading = false;
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, false);
          }
          currentNodes = message.nodes || [];
          renderRoadmap(message.nodes);
          renderSoloPanel(currentNodes);
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'settingsLoaded':
          applySettingCliPath(message.settings.cliPath || 'agy');
          settingGlobalPrompt.value = message.settings.globalPrompt || '';
          if (settingGlobalDataPath) settingGlobalDataPath.value = message.settings.globalDataPath || '';
          setSoloSelectValue(settingLanguage, message.settings.language || 'zh');
          currentLanguage = getSoloSelectValue(settingLanguage);
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
          renderSoloPanel(currentNodes);
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'supplementFilesSelected':
          const soloDraft = message.nodeId === soloConversationId
            ? (soloBody.querySelector('[data-solo-input]')?.value || '')
            : '';
          const revisionDraft = message.nodeId === roadmapRevisionId
            ? (roadmapRevisionBody.querySelector('[data-roadmap-revision-input]')?.value || '')
            : '';
          if (message.nodeId && message.nodeId !== soloConversationId && message.nodeId !== roadmapRevisionId) {
            const input = canvas.querySelector('[data-conversation-input-id="' + cssEscape(message.nodeId) + '"]');
            conversationDrafts[message.nodeId] = input ? input.value : (conversationDrafts[message.nodeId] || '');
          }
          nodeSupplementFiles[message.nodeId] = mergeSupplementFiles(
            nodeSupplementFiles[message.nodeId] || [],
            message.files || []
          );
          renderRoadmap(currentNodes);
          if (message.nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
            const input = soloBody.querySelector('[data-solo-input]');
            if (input) {
              input.value = soloDraft;
            }
          }
          if (message.nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
            const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
            if (input) {
              input.value = revisionDraft;
            }
          }
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
        case 'skillInstallResult':
          if (skillInstallBadge) {
            skillInstallBadge.style.display = 'block';
            skillInstallBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            skillInstallBadge.textContent = message.message || '';
          }
          break;
        case 'mcpInstallResult':
          if (mcpInstallBadge) {
            mcpInstallBadge.style.display = 'block';
            mcpInstallBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            mcpInstallBadge.textContent = message.message || '';
          }
          break;
      }
    });

    // Save configurations
    btnSaveSettings.addEventListener('click', () => {
      const effectiveCliPath = getEffectiveSettingCliPath();
      vscode.postMessage({
        command: 'updateSettings',
        cliPath: effectiveCliPath,
        language: getSoloSelectValue(settingLanguage),
        globalPrompt: settingGlobalPrompt.value.trim(),
        globalDataPath: settingGlobalDataPath ? settingGlobalDataPath.value.trim() : ''
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
        cliPath: getEffectiveSettingCliPath()
      });
    });

    if (btnInstallSkill) {
      btnInstallSkill.addEventListener('click', () => {
        const skillInput = (settingSkillInput ? settingSkillInput.value : '').trim();
        if (!skillInput) {
          if (skillInstallBadge) {
            skillInstallBadge.style.display = 'block';
            skillInstallBadge.className = 'cli-badge error';
            skillInstallBadge.textContent = t('skillInstallPlaceholder');
          }
          return;
        }
        if (skillInstallBadge) {
          skillInstallBadge.style.display = 'block';
          skillInstallBadge.className = 'cli-badge';
          skillInstallBadge.style.background = 'rgba(255,255,255,0.05)';
          skillInstallBadge.style.color = 'var(--text-muted)';
          skillInstallBadge.textContent = t('installingSkill');
        }
        vscode.postMessage({ command: 'installSkill', skillInput });
      });
    }

    if (btnInstallMcp) {
      btnInstallMcp.addEventListener('click', () => {
        const mcpInput = (settingMcpInput ? settingMcpInput.value : '').trim();
        if (!mcpInput) {
          if (mcpInstallBadge) {
            mcpInstallBadge.style.display = 'block';
            mcpInstallBadge.className = 'cli-badge error';
            mcpInstallBadge.textContent = t('mcpInstallPlaceholder');
          }
          return;
        }
        if (mcpInstallBadge) {
          mcpInstallBadge.style.display = 'block';
          mcpInstallBadge.className = 'cli-badge';
          mcpInstallBadge.style.background = 'rgba(255,255,255,0.05)';
          mcpInstallBadge.style.color = 'var(--text-muted)';
          mcpInstallBadge.textContent = t('installingMcp');
        }
        vscode.postMessage({ command: 'installMcp', mcpInput });
      });
    }

    if (btnOpenFeedback) {
      btnOpenFeedback.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openFeedbackIssue',
          title: settingFeedbackTitle ? settingFeedbackTitle.value.trim() : '',
          body: settingFeedbackBody ? settingFeedbackBody.value.trim() : ''
        });
      });
    }

    bindSoloSelect(projectSelect, (value) => {
      vscode.postMessage({
        command: 'selectProject',
        projectPath: value
      });
    });

    bindSoloSelect(projectTypeSelect, (value) => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({
        command: 'updateProjectMetadata',
        projectPath,
        projectType: value,
        priority: getSoloSelectValue(projectPrioritySelect)
      });
    });

    bindSoloSelect(projectPrioritySelect, (value) => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({
        command: 'updateProjectMetadata',
        projectPath,
        projectType: getSoloSelectValue(projectTypeSelect),
        priority: value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    btnRemoveProject.addEventListener('click', () => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({ command: 'removeProject', projectPath });
    });

    function renderProjects(projects, selectedProjectPath) {
      if (!projects || projects.length === 0) {
        setSoloSelectOptions(projectSelect, [{ value: '', label: t('chooseProject') }], '');
        setSoloSelectOptions(projectTypeSelect, [{ value: '', label: 'Type' }], '');
        setSoloSelectOptions(projectPrioritySelect, [{ value: '', label: 'Priority' }], '');
        return;
      }

      const selectedProject = projects.find(project => project.path === selectedProjectPath) || projects[0];
      setSoloSelectOptions(projectSelect, projects.map(project => ({
        value: project.path,
        label: project.name,
        title: project.path
      })), selectedProjectPath);
      setSoloSelectOptions(projectTypeSelect, getProjectTypeOptions(), selectedProject && selectedProject.type ? selectedProject.type : 'core_product');
      setSoloSelectOptions(projectPrioritySelect, getProjectPriorityOptions(), selectedProject && selectedProject.priority ? selectedProject.priority : '');
    }

    function getProjectTypeOptions() {
      return [
        { value: 'core_product', label: '核心产品' },
        { value: 'infra', label: '基础设施' },
        { value: 'content', label: '内容产品' },
        { value: 'experiment', label: '试验研究' },
        { value: 'tool', label: '工具脚手架' },
        { value: 'archive', label: '归档维护' }
      ];
    }

    function getProjectPriorityOptions() {
      return [
        { value: '', label: '自动优先级' },
        { value: 'P0', label: 'P0' },
        { value: 'P1', label: 'P1' },
        { value: 'P2', label: 'P2' }
      ];
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function closeSoloSelects(except) {
      document.querySelectorAll('[data-solo-select]').forEach(select => {
        if (select !== except) {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function setSoloSelectValue(select, value) {
      if (!select) return;
      const choices = Array.from(select.querySelectorAll('[data-solo-option-value]'));
      const selected = choices.find(choice => choice.getAttribute('data-solo-option-value') === String(value || '')) || choices[0];
      const selectedValue = selected ? selected.getAttribute('data-solo-option-value') || '' : '';
      select.setAttribute('data-value', selectedValue);
      const label = select.querySelector('[data-solo-label]');
      if (label) label.textContent = selected ? selected.textContent || '' : '';
      choices.forEach(choice => choice.setAttribute('aria-selected', choice === selected ? 'true' : 'false'));
    }

    function getSoloSelectValue(select) {
      return select ? select.getAttribute('data-value') || '' : '';
    }

    function setSoloSelectOptions(select, options, selectedValue) {
      const menu = select && select.querySelector('[data-solo-menu]');
      if (!menu) return;
      menu.innerHTML = (options || []).map(option => (
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
        '" title="' + escapeHtml(option.title || option.label) + '" aria-selected="false">' +
        escapeHtml(option.label) + '</button>'
      )).join('');
      setSoloSelectValue(select, selectedValue);
    }

    function renderSoloSelect(className, attributes, options, disabled) {
      const selected = options[0] || { value: '', label: '' };
      const disabledClass = disabled ? ' is-disabled' : '';
      const disabledAttribute = disabled ? ' disabled' : '';
      return '<div class="solo-select ' + className + disabledClass + '" data-solo-select data-value="' + escapeHtml(selected.value) + '" ' + attributes + '>' +
        '<button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false"' + disabledAttribute + '>' +
        '<span class="solo-select-trigger-label" data-solo-label>' + escapeHtml(selected.label) + '</span>' +
        '<span class="codicon codicon-chevron-down solo-select-caret"></span></button>' +
        '<div class="solo-select-menu" data-solo-menu role="listbox">' +
        options.map((option, index) => '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
          '" aria-selected="' + (index === 0 ? 'true' : 'false') + '">' + escapeHtml(option.label) + '</button>').join('') +
        '</div></div>';
    }

    function bindSoloSelect(select, onChange) {
      if (!select || select.getAttribute('data-solo-bound') === 'true') return;
      select.setAttribute('data-solo-bound', 'true');
      select.addEventListener('click', event => {
        event.stopPropagation();
        const option = event.target.closest('[data-solo-option-value]');
        if (option) {
          const previousValue = getSoloSelectValue(select);
          setSoloSelectValue(select, option.getAttribute('data-solo-option-value'));
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          if (onChange && previousValue !== getSoloSelectValue(select)) {
            onChange(getSoloSelectValue(select));
          }
          return;
        }
        if (event.target.closest('[data-solo-trigger]') && !select.classList.contains('is-disabled')) {
          const open = !select.classList.contains('open');
          closeSoloSelects(select);
          select.classList.toggle('open', open);
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
      });
      select.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          return;
        }
        if ((event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') && event.target.closest('[data-solo-trigger]')) {
          event.preventDefault();
          closeSoloSelects(select);
          select.classList.add('open');
          event.target.setAttribute('aria-expanded', 'true');
        }
      });
    }

    function bindSoloSelects(container) {
      container.querySelectorAll('[data-solo-select]').forEach(select => bindSoloSelect(select));
    }

    document.addEventListener('click', () => closeSoloSelects());

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

    function renderOnboardingPanel() {
      return \`
        <div class="onboarding-panel">
          <div class="onboarding-kicker"><span class="codicon codicon-compass"></span>\${escapeHtml(t('onboardingKicker'))}</div>
          <div class="onboarding-title">\${escapeHtml(t('onboardingTitle'))}</div>
          <div class="onboarding-copy">\${escapeHtml(t('onboardingCopy'))}</div>
          <div class="onboarding-steps">
            <div class="onboarding-step"><span class="onboarding-step-index">1</span><span>\${escapeHtml(t('onboardingStepProject'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">2</span><span>\${escapeHtml(t('onboardingStepType'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">3</span><span>\${escapeHtml(t('onboardingStepRoadmap'))}</span></div>
          </div>
          <button class="onboarding-action" data-onboarding-add-project>
            <span class="codicon codicon-add"></span>\${escapeHtml(t('onboardingAction'))}
          </button>
        </div>
      \`;
    }

    function bindOnboardingActions(container) {
      container.querySelectorAll('[data-onboarding-add-project]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'addProject' });
        });
      });
    }

    const methodologyStages = [
      { key: 'build', labelKey: 'methodologyBuild' },
      { key: 'sell', labelKey: 'methodologySell' },
      { key: 'learn', labelKey: 'methodologyLearn' },
      { key: 'improve', labelKey: 'methodologyImprove' }
    ];

    function inferMethodologyStage(node) {
      const text = String((node && node.stage) || '') + ' ' + String((node && node.title) || '');
      const normalized = text.toLowerCase();
      if (/营销|销售|分发|品牌|官网|发布|外联|获客|转化|sell|sales|market|launch|growth|distribution|outreach/.test(normalized)) {
        return 'sell';
      }
      if (/产品|mvp|构建|实现|开发|交付|源码|页面|功能|build|ship|implement|code|feature/.test(normalized)) {
        return 'build';
      }
      if (/调整|改进|复盘|规模化|路线图|优先级|下一轮|improve|iterate|iteration|roadmap|scale|optimi[sz]e/.test(normalized)) {
        return 'improve';
      }
      if (/问题|客户|发现|反馈|学习|访谈|指标|数据|issue|learn|feedback|customer|discovery|analytics|support/.test(normalized)) {
        return 'learn';
      }
      return 'build';
    }

    function getMethodologyStageCounts(nodes) {
      const counts = {
        build: { total: 0, completed: 0 },
        sell: { total: 0, completed: 0 },
        learn: { total: 0, completed: 0 },
        improve: { total: 0, completed: 0 }
      };
      (nodes || []).forEach(node => {
        const key = inferMethodologyStage(node);
        counts[key].total += 1;
        if (node.status === 'Completed') counts[key].completed += 1;
      });
      return counts;
    }

    function renderMethodologyOverview(nodes) {
      const counts = getMethodologyStageCounts(nodes);
      return \`
        <div class="methodology-overview" aria-label="Build Sell Learn Improve">
          \${methodologyStages.map(stage => {
            const item = counts[stage.key] || { total: 0, completed: 0 };
            const missing = Number(item.total || 0) === 0;
            const active = activeMethodologyStage === stage.key;
            return \`
              <div class="methodology-stage-card\${missing ? ' missing' : ''}\${active ? ' active' : ''}" role="button" tabindex="0" data-methodology-stage="\${escapeHtml(stage.key)}">
                <div>
                  <div class="methodology-stage-name">\${escapeHtml(t(stage.labelKey))}</div>
                  <div class="methodology-stage-meta">\${missing ? escapeHtml(t('methodologyMissing')) : escapeHtml(item.completed + ' / ' + item.total + ' ' + t('methodologyCompleted'))}</div>
                </div>
                \${missing ? \`<button class="methodology-adjust-btn" type="button" data-open-roadmap-revision>\${escapeHtml(t('reviseRoadmap'))}</button>\` : ''}
              </div>
            \`;
          }).join('')}
        </div>
      \`;
    }

    function bindMethodologyOverview(container) {
      container.querySelectorAll('[data-methodology-stage]').forEach(card => {
        const selectStage = () => {
          const stage = card.getAttribute('data-methodology-stage') || '';
          activeMethodologyStage = activeMethodologyStage === stage ? '' : stage;
          renderRoadmap(currentNodes);
          if (activeMethodologyStage) {
            setTimeout(() => {
              const target = canvas.querySelector('[data-methodology-row-stage="' + cssEscape(activeMethodologyStage) + '"]');
              if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 0);
          }
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-open-roadmap-revision]')) return;
          selectStage();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectStage();
          }
        });
      });
      container.querySelectorAll('[data-open-roadmap-revision]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          roadmapRevisionExpanded = true;
          if (settingsPanel) settingsPanel.style.display = 'none';
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
    }

    function renderRoadmap(nodes) {
      // Clear canvas keeping the flow line
      const flowLine = canvas.querySelector('.flow-line');
      canvas.innerHTML = '';
      if (flowLine) canvas.appendChild(flowLine);

      if (!nodes || nodes.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.innerHTML = currentRoadmapLoading
          ? '<div class="onboarding-panel"><div class="onboarding-title">' + escapeHtml(t('roadmapLoading')) + '</div></div>'
          : renderOnboardingPanel();
        canvas.appendChild(placeholder);
        bindOnboardingActions(placeholder);
        return;
      }

      const overview = document.createElement('div');
      overview.className = 'methodology-shell';
      overview.innerHTML = renderMethodologyOverview(nodes);
      canvas.appendChild(overview);
      bindMethodologyOverview(overview);

      nodes.forEach(node => {
        const row = document.createElement('div');
        const methodologyStage = inferMethodologyStage(node);
        row.className = 'node-row methodology-' + methodologyStage + (activeMethodologyStage === methodologyStage ? ' stage-highlight' : '');
        row.setAttribute('data-methodology-row-stage', methodologyStage);

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
                <input type="text" class="conversation-input" data-conversation-input-id="\${escapeHtml(node.id)}" placeholder="\${t('conversationPlaceholder')}" value="\${escapeHtml(conversationDrafts[node.id] || '')}" \${conversationDisabled}>
                \${renderSoloSelect('conversation-agent-select', 'data-agent-select-id="' + escapeHtml(node.id) + '" title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions(node), node.status === 'Running')}
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
            if (event.target.closest('button') || event.target.closest('input') || event.target.closest('[data-solo-select]') || event.target.closest('[data-conversation-id]')) {
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
            triggerRun(node.id, input ? input.value : '', getSoloSelectValue(agentSelect), nodeSupplementFiles[node.id] || []);
            if (input) input.value = '';
            conversationDrafts[node.id] = '';
            nodeSupplementFiles[node.id] = [];
            renderRoadmap(currentNodes);
          });
        }
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          input.addEventListener('input', () => {
            conversationDrafts[node.id] = input.value;
          });
        });
        row.querySelectorAll('[data-attach-node-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: node.id });
          });
        });
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          bindPastedImageAttachments(input, node.id, () => renderRoadmap(currentNodes));
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
        bindSoloSelects(row);
        canvas.appendChild(row);
      });
    }

    function renderSoloClosure(conversation) {
      const options = (currentNodes || []).map(node => ({ value: node.id, label: node.title }));
      return \`
        <div class="solo-closure" data-solo-closure-id="\${escapeHtml(conversation.id)}">
          <div class="solo-closure-title">\${escapeHtml(t('soloClosure'))}</div>
          <div class="solo-closure-actions">
            \${options.length ? renderSoloSelect('solo-link-select', 'data-solo-link-select', options, false) : ''}
            \${options.length ? \`<button class="solo-action-btn" data-link-solo-id="\${escapeHtml(conversation.id)}">\${escapeHtml(t('linkToStep'))}</button>\` : ''}
            <button class="solo-action-btn secondary" data-open-revision-from-solo>\${escapeHtml(t('adjustRoadmap'))}</button>
          </div>
          <div class="conversation-runtime">\${escapeHtml(t('keepInSolo'))}</div>
        </div>
      \`;
    }

    function renderSoloPanel(nodes) {
      if (!soloPanel || !soloBody) {
        return;
      }
      const conversations = nodeConversations[soloConversationId] || [];
      const supplementFiles = nodeSupplementFiles[soloConversationId] || [];
      const running = conversations.some(conversation => conversation.status === 'Running')
        || (nodes || []).some(node => node.status === 'Running');
      const disabled = running ? 'disabled' : '';
      soloPanel.classList.toggle('active', soloExpanded);
      btnToggleSolo.classList.toggle('active', soloExpanded);
      if (!soloExpanded) {
        soloBody.innerHTML = '';
        return;
      }
      soloBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose">
            <button class="conversation-tool-btn" data-attach-solo title="\${escapeHtml(t('attachFiles'))}" \${disabled}>
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-solo-input placeholder="\${escapeHtml(t('soloPlaceholder'))}" \${disabled}>
            \${renderSoloSelect('conversation-agent-select', 'data-solo-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), running)}
            <button class="btn-send-conversation" data-send-solo title="\${escapeHtml(t('sendSolo'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          \${renderSupplementFiles(soloConversationId, supplementFiles)}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('soloHistory'))}</div>
          \${renderConversations(soloConversationId, conversations, t('noSoloConversations'))}
        </div>
      \`;
      const sendButton = soloBody.querySelector('[data-send-solo]');
      const attachButton = soloBody.querySelector('[data-attach-solo]');
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'chooseSupplementFiles', nodeId: soloConversationId });
        });
      }
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = soloBody.querySelector('[data-solo-input]');
          const agentSelect = soloBody.querySelector('[data-solo-agent]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'runSoloConversation',
            userMessage: request,
            agentCli: getSoloSelectValue(agentSelect),
            supplementFiles: nodeSupplementFiles[soloConversationId] || []
          });
          input.value = '';
          nodeSupplementFiles[soloConversationId] = [];
          renderSoloPanel(currentNodes);
        });
      }
      soloBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[soloConversationId] = (nodeSupplementFiles[soloConversationId] || []).filter(candidate => candidate !== file);
          renderSoloPanel(currentNodes);
        });
      });
      const soloInput = soloBody.querySelector('[data-solo-input]');
      bindPastedImageAttachments(soloInput, soloConversationId, () => renderSoloPanel(currentNodes));
      bindSoloSelects(soloBody);
      bindConversationActions(soloBody, soloConversationId);
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
            \${renderSoloSelect('conversation-agent-select', 'data-roadmap-revision-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), revisionRunning)}
            <button class="btn-send-conversation" data-send-roadmap-revision title="\${escapeHtml(t('sendRevision'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          \${renderSupplementFiles(roadmapRevisionId, nodeSupplementFiles[roadmapRevisionId] || [])}
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
            agentCli: getSoloSelectValue(agentSelect),
            supplementFiles: nodeSupplementFiles[roadmapRevisionId] || []
          });
          input.value = '';
          nodeSupplementFiles[roadmapRevisionId] = [];
          renderRoadmapRevisionPanel(currentNodes);
        });
      }
      const revisionInput = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
      bindPastedImageAttachments(revisionInput, roadmapRevisionId, () => renderRoadmapRevisionPanel(currentNodes));
      roadmapRevisionBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[roadmapRevisionId] = (nodeSupplementFiles[roadmapRevisionId] || []).filter(candidate => candidate !== file);
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      bindSoloSelects(roadmapRevisionBody);
      bindConversationActions(roadmapRevisionBody, roadmapRevisionId);
    }

    function bindConversationActions(container, nodeId) {
      container.querySelectorAll('[data-link-solo-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const closure = item.closest('[data-solo-closure-id]');
          const select = closure ? closure.querySelector('[data-solo-link-select]') : null;
          const targetNodeId = getSoloSelectValue(select);
          if (!targetNodeId) return;
          vscode.postMessage({
            command: 'linkSoloConversation',
            conversationId: item.getAttribute('data-link-solo-id'),
            nodeId: targetNodeId
          });
        });
      });
      container.querySelectorAll('[data-open-revision-from-solo]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          setMainView('roadmap');
          roadmapRevisionExpanded = true;
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          if (!nodeConversations[roadmapRevisionId]) {
            vscode.postMessage({ command: 'getNodeConversations', nodeId: roadmapRevisionId });
          }
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      container.querySelectorAll('[data-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          activeConversationId = activeConversationId === item.getAttribute('data-conversation-id')
            ? ''
            : item.getAttribute('data-conversation-id');
          renderRoadmap(currentNodes);
          if (nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
          } else if (nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
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
                \${renderConversationOutcome(conversation, nodeId)}
                \${renderConversationFiles(conversation)}
                \${nodeId === soloConversationId && conversation.status !== 'Running' ? renderSoloClosure(conversation) : ''}
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

    function renderConversationOutcome(conversation, nodeId = '') {
      const output = String(conversation.output || '');
      const failureCategory = (output.match(/Failure category:\\s*([^\\n]+)/) || [])[1] || '';
      const failureReason = (output.match(/Failure reason:\\n([\\s\\S]*?)(?:\\n\\n|$)/) || [])[1] || '';
      const files = extractConversationFiles(output);
      let result = '';
      if (conversation.status === 'Running') {
        result = t('stillWorking');
      } else if (conversation.status === 'Failed') {
        result = failureCategoryText(failureCategory.trim()) || failureReason.trim() || statusText(conversation.status);
      } else if (conversation.status === 'Linked') {
        result = t('linkedFromSolo');
      } else if (conversation.status === 'Completed' && nodeId === soloConversationId) {
        result = t('soloCompleted');
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

    function getAgentOptions(node) {
      const options = [];
      function addOption(value, label) {
        const normalized = normalizeAgentOption(value);
        if (!normalized || options.some(option => option.value === normalized)) return;
        options.push({ value: normalized, label: label || normalized });
      }
      addOption(currentCliPath || 'agy');
      addOption(node.agentCli || currentCliPath || 'agy');
      addOption('antigravity');
      addOption('cursor');
      addOption('codex');
      addOption('copilot');
      addOption('claude');
      addOption('opencode');
      return options;
    }

    function normalizeAgentOption(value) {
      const normalized = String(value || '').trim();
      const name = normalized.split(/[\\\\/]/).pop().toLowerCase();
      if (name === 'codex-cli') return 'codex';
      if (name === 'cursor-cli') return 'cursor';
      if (name === 'copilot-cli') return 'copilot';
      if (name === 'agy' || name === 'antigravity-cli') return 'antigravity';
      return normalized;
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

    function readClipboardImage(file) {
      return new Promise((resolve) => {
        if (typeof FileReader === 'undefined' || !file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name || 'pasted-image',
          mimeType: file.type || 'image/png',
          dataUrl: String(reader.result || '')
        });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    function bindPastedImageAttachments(input, nodeId, afterPaste) {
      if (!input || input.getAttribute('data-paste-image-bound') === 'true') return;
      input.setAttribute('data-paste-image-bound', 'true');
      input.addEventListener('paste', async (event) => {
        const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
        const files = items
          .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
          .map(item => item.getAsFile())
          .filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        const attachments = (await Promise.all(files.map(readClipboardImage))).filter(Boolean);
        if (!attachments.length) return;
        vscode.postMessage({
          command: 'savePastedAttachments',
          nodeId,
          attachments
        });
      });
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
