import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';
import { AgentConversation } from './db/types';

interface SolopreneurSettings {
  cliPath: string;
  language: string;
  globalPrompt: string;
}

interface SolopreneurProject {
  name: string;
  path: string;
}

interface ProjectPortfolioSummary {
  name: string;
  path: string;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  runningNodes: number;
  inProgressNodes: number;
  pendingNodes: number;
  progressPercent: number;
  currentStage: string;
  recommendedNodeId: string;
  recommendedNodeTitle: string;
  recommendedStatus: string;
  overallStatus: string;
  recentActivityAt: string;
}

interface RoadmapNodeLike {
  id: string;
  title: string;
  stage: string;
  status: string;
  agentCli?: string;
  dependencies?: string;
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

function readProjectRoadmapNodes(projectPath: string): RoadmapNodeLike[] {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const parseResult = Papa.parse<RoadmapNodeLike>(content, {
      header: true,
      skipEmptyLines: true,
    });
    return parseResult.data.map((node) => ({
      id: String(node.id || '').trim(),
      title: String(node.title || '').trim(),
      stage: String(node.stage || '').trim(),
      status: String(node.status || 'Pending').trim() || 'Pending',
      agentCli: String((node as any).agentCli || '').trim(),
      dependencies: String(node.dependencies || '').trim()
    })).filter((node) => node.id);
  } catch {
    return [];
  }
}

function getRecommendedNode(nodes: RoadmapNodeLike[]): RoadmapNodeLike | null {
  if (!nodes.length) {
    return null;
  }
  const completedIds = new Set(nodes.filter((node) => node.status === 'Completed').map((node) => node.id));
  const dependenciesSatisfied = (node: RoadmapNodeLike) => {
    const dependencies = String(node.dependencies || '')
      .split(',')
      .map((dependency) => dependency.trim())
      .filter(Boolean);
    return dependencies.every((dependency) => completedIds.has(dependency));
  };
  const byStatus = (status: string) => nodes.find((node) => node.status === status);
  return byStatus('Running')
    || byStatus('Failed')
    || byStatus('In Progress')
    || nodes.find((node) => node.status === 'Pending' && dependenciesSatisfied(node))
    || byStatus('Pending')
    || nodes.find((node) => node.status !== 'Completed')
    || nodes[0];
}

function getProjectRecentActivityAt(projectPath: string): string {
  const candidates = [
    path.join(projectPath, '.solopreneur', 'roadmap.csv'),
    path.join(projectPath, '.solopreneur', 'project_journal.db'),
    path.join(projectPath, '.solopreneur', 'agent-runs')
  ];
  let latestMtime = 0;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
    } catch {}
  }
  return latestMtime ? new Date(latestMtime).toISOString() : '';
}

function buildProjectPortfolioSummary(project: SolopreneurProject): ProjectPortfolioSummary {
  const nodes = readProjectRoadmapNodes(project.path);
  const totalNodes = nodes.length;
  const completedNodes = nodes.filter((node) => node.status === 'Completed').length;
  const failedNodes = nodes.filter((node) => node.status === 'Failed').length;
  const runningNodes = nodes.filter((node) => node.status === 'Running').length;
  const inProgressNodes = nodes.filter((node) => node.status === 'In Progress').length;
  const pendingNodes = nodes.filter((node) => node.status === 'Pending').length;
  const recommendedNode = getRecommendedNode(nodes);
  const overallStatus = runningNodes > 0
    ? 'Running'
    : failedNodes > 0
      ? 'Failed'
      : totalNodes > 0 && completedNodes === totalNodes
        ? 'Completed'
        : inProgressNodes > 0
          ? 'In Progress'
          : 'Pending';

  return {
    name: project.name,
    path: project.path,
    totalNodes,
    completedNodes,
    failedNodes,
    runningNodes,
    inProgressNodes,
    pendingNodes,
    progressPercent: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0,
    currentStage: recommendedNode?.stage || '',
    recommendedNodeId: recommendedNode?.id || '',
    recommendedNodeTitle: recommendedNode?.title || '',
    recommendedStatus: recommendedNode?.status || '',
    overallStatus,
    recentActivityAt: getProjectRecentActivityAt(project.path)
  };
}

function buildProjectPortfolioSummaries(projects: SolopreneurProject[]): ProjectPortfolioSummary[] {
  return projects.map((project) => buildProjectPortfolioSummary(project));
}

export class SolopreneurSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'solopreneur.sidebar';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _syncEngine: SyncEngine,
    private readonly _onRunAgent: (nodeId: string, userMessage?: string, agentCli?: string) => Promise<void>,
    private readonly _getSettings: () => SolopreneurSettings,
    private readonly _updateSettings: (settings: SolopreneurSettings) => Promise<void>,
    private readonly _getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string },
    private readonly _selectProject: (projectPath: string) => Promise<void>,
    private readonly _addProject: () => Promise<void>,
    private readonly _onRunSolo?: (projectPath: string, userMessage?: string, agentCli?: string, supplementFiles?: string[]) => Promise<void>,
    private readonly _chooseSoloSupplementFiles?: (projectPath: string) => Promise<string[]>,
    private readonly _getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Allow scripts and configure local resource roots
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Listen to messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'getNodes':
          this.sendNodesToWebview();
          break;
        case 'runAgent':
          await this._onRunAgent(data.nodeId, data.userMessage || '', data.agentCli || '');
          break;
        case 'runSoloConversation':
          if (this._onRunSolo) {
            await this._onRunSolo(data.projectPath || '', data.userMessage || '', data.agentCli || '', data.supplementFiles || []);
            await this.sendSoloConversationHistory(data.projectPath || '');
          }
          break;
        case 'chooseSoloSupplementFiles':
          if (this._chooseSoloSupplementFiles) {
            const files = await this._chooseSoloSupplementFiles(data.projectPath || '');
            this._view?.webview.postMessage({ command: 'soloSupplementFilesSelected', files });
          }
          break;
        case 'getSoloConversationHistory':
          await this.sendSoloConversationHistory(data.projectPath || '');
          break;
        case 'showFullRoadmap':
          vscode.commands.executeCommand('solopreneur.showRoadmap');
          break;
        case 'getSettings':
          this.sendSettings();
          break;
        case 'updateSettings':
          await this._updateSettings({
            cliPath: data.cliPath,
            language: data.language,
            globalPrompt: data.globalPrompt
          });
          vscode.window.showInformationMessage('SoloMap settings saved successfully!');
          // Broadcast to sync both Webviews
          this.sendSettings();
          // Trigger updates on the full screen view if active
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;
        case 'testCli':
          const cliToTest = resolveAgentCli('antigravity-cli', data.cliPath || '');
          childProcess.execFile(cliToTest, getCliVersionArgs(cliToTest), (error: any, stdout: string, stderr: string) => {
            const success = !error;
            let msg = error ? error.message : formatCliTestMessage(cliToTest, stdout, stderr);
            if (!success) {
              const candidates = getAgentCliCandidates('antigravity-cli', data.cliPath || '').join(', ');
              msg = `Command not found or failed. Tried: ${candidates}`;
            }
            this._view?.webview.postMessage({
              command: 'cliTestResult',
              success,
              message: msg
            });
          });
          break;
        case 'getProjects':
          this.sendProjects();
          break;
        case 'selectProject':
          await this._selectProject(data.projectPath);
          break;
        case 'addProject':
          await this._addProject();
          break;
        case 'openProjectFromPortfolio':
          await this._selectProject(data.projectPath);
          vscode.commands.executeCommand('solopreneur.showRoadmap');
          break;
        case 'continueProjectFromPortfolio':
          await this._selectProject(data.projectPath);
          if (data.nodeId) {
            await this._onRunAgent(data.nodeId);
          } else {
            vscode.commands.executeCommand('solopreneur.showRoadmap');
          }
          break;
      }
    });

    // Request initial data push
    this.sendNodesToWebview();
    this.sendSettings();
    this.sendProjects();
  }

  /**
   * Refreshes the sidebar view with updated node states.
   */
  public sendNodesToWebview() {
    if (this._view && this._syncEngine) {
      const nodes = this._syncEngine.getNodes();
      this._view.webview.postMessage({
        command: 'nodesUpdated',
        nodes: nodes,
        projectPath: this._getProjects().selectedProjectPath
      });
    }
  }

  /**
   * Reads and pushes active configuration settings to the sidebar.
   */
  public sendSettings() {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'settingsLoaded',
        settings: this._getSettings()
      });
    }
  }

  public sendProjects() {
    if (this._view) {
      const projectState = this._getProjects();
      this._view.webview.postMessage({
        command: 'projectsLoaded',
        projects: {
          ...projectState,
          portfolio: buildProjectPortfolioSummaries(projectState.projects)
        }
      });
      void this.sendSoloConversationHistory(projectState.selectedProjectPath);
    }
  }

  public async sendSoloConversationHistory(projectPath: string) {
    if (!this._view || !this._getSoloConversationHistory || !projectPath) {
      return;
    }
    const conversations = await this._getSoloConversationHistory(projectPath);
    this._view.webview.postMessage({
      command: 'sidebarSoloConversationLoaded',
      projectPath,
      conversations
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously -->
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
      --bg-glass: rgba(22, 28, 45, 0.5);
      --border-glass: rgba(255, 255, 255, 0.08);
      --glow-blue: rgba(0, 229, 255, 0.8);
      --glow-green: rgba(0, 230, 118, 0.8);
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
    }

    body {
      margin: 0;
      padding: 12px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', Roboto, Helvetica, Arial, sans-serif;
      background: var(--vscode-sidebar-background, var(--bg-dark));
      color: var(--text-main);
      overflow-x: hidden;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 15px;
      font-weight: 800;
      margin: 0;
      background: linear-gradient(135deg, #00e5ff 0%, #7c4dff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }

    .btn-gear {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      display: flex;
      align-items: center;
      transition: color 0.2s;
    }

    .codicon {
      font-size: 15px;
      line-height: 1;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }

    .btn-gear:hover {
      color: #00e5ff;
    }

    /* Settings Panel Overlay */
    .settings-overlay {
      position: absolute;
      top: 45px;
      left: 10px;
      right: 10px;
      background: rgba(15, 17, 26, 0.95);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 12px;
      z-index: 50;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      display: none;
      max-height: calc(100vh - 70px);
      overflow-y: auto;
      animation: slide-down 0.2s ease-out;
    }

    @keyframes slide-down {
      from { transform: translateY(-8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 4px;
    }

    .settings-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 12px;
      margin: 0;
      font-weight: 800;
      color: #00e5ff;
    }

    .btn-close-settings {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 16px;
      font-weight: bold;
      padding: 0 4px;
    }

    .btn-close-settings:hover {
      color: #ff1744;
    }

    .settings-field {
      margin-bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .settings-lbl-title {
      font-size: 8.5px;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.2px;
    }

    .settings-input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 5px 6px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
    }

    .settings-input:focus {
      border-color: #00e5ff;
    }

    .settings-textarea {
      min-height: 66px;
      resize: vertical;
      line-height: 1.4;
    }

    .project-switcher {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }

    .project-select {
      flex: 1;
      min-width: 0;
    }

    .solo-select {
      position: relative;
      min-width: 0;
      font-size: 11px;
    }

    .solo-select-trigger {
      width: 100%;
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 5px 7px;
      color: var(--text-main);
      font: inherit;
      cursor: pointer;
      text-align: left;
    }

    .solo-select-trigger-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .solo-select-caret {
      flex-shrink: 0;
      color: var(--text-muted);
      transition: transform 0.18s ease;
    }

    .solo-select.open .solo-select-caret {
      transform: rotate(180deg);
    }

    .solo-select.open .solo-select-trigger,
    .solo-select-trigger:focus {
      border-color: rgba(0, 229, 255, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18);
      outline: none;
    }

    .solo-select-menu {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 80;
      padding: 4px;
      border: 1px solid rgba(0, 229, 255, 0.22);
      border-radius: 7px;
      background: #151a29;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42);
      max-height: 190px;
      overflow-y: auto;
    }

    .solo-select.open .solo-select-menu {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .solo-select-option {
      border: none;
      border-radius: 5px;
      padding: 6px 7px;
      background: transparent;
      color: var(--text-main);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .solo-select-option:hover,
    .solo-select-option[aria-selected="true"] {
      background: rgba(0, 229, 255, 0.12);
      color: #d8fbff;
    }

    .solo-select.is-disabled {
      opacity: 0.52;
    }

    .solo-select.is-disabled .solo-select-trigger {
      cursor: not-allowed;
    }

    .btn-project-add {
      width: 28px;
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      cursor: pointer;
      font-weight: 800;
    }

    .portfolio-panel {
      position: relative;
      z-index: 1;
      background: var(--bg-glass);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
    }

    .sidebar-solo-card {
      position: relative;
      z-index: 20;
      background: linear-gradient(145deg, rgba(124, 77, 255, 0.12), rgba(22, 28, 45, 0.55));
      backdrop-filter: blur(8px);
      border: 1px solid rgba(124, 77, 255, 0.28);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 12px;
    }

    .sidebar-solo-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 5px;
    }

    .sidebar-solo-subtitle {
      color: var(--text-muted);
      font-size: 10px;
      line-height: 1.4;
      margin-bottom: 9px;
    }

    .sidebar-solo-controls {
      display: flex;
      gap: 6px;
      margin-bottom: 7px;
    }

    .sidebar-solo-project {
      flex: 1;
      min-width: 0;
    }

    .sidebar-solo-agent {
      width: 92px;
      flex-shrink: 0;
    }

    .sidebar-solo-compose {
      display: flex;
      gap: 6px;
      align-items: flex-end;
    }

    .sidebar-solo-tool {
      min-height: 46px;
      width: 36px;
      flex-shrink: 0;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .sidebar-solo-tool:hover {
      border-color: rgba(124, 77, 255, 0.48);
      color: #d9ccff;
    }

    .sidebar-solo-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin: 0 0 7px;
    }

    .sidebar-solo-file {
      max-width: 100%;
      display: inline-flex;
      gap: 5px;
      align-items: center;
      border: 1px solid rgba(124, 77, 255, 0.28);
      border-radius: 999px;
      background: rgba(124, 77, 255, 0.1);
      color: #dfd5ff;
      padding: 3px 7px;
      font-size: 10px;
    }

    .sidebar-solo-file-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-solo-file-remove {
      border: 0;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
    }

    .sidebar-solo-input {
      flex: 1;
      min-height: 46px;
      max-height: 98px;
      resize: vertical;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 7px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      line-height: 1.35;
      outline: none;
    }

    .sidebar-solo-input:focus {
      border-color: rgba(124, 77, 255, 0.65);
    }

    .sidebar-solo-send {
      border: none;
      border-radius: 5px;
      min-height: 46px;
      padding: 0 10px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .sidebar-solo-history {
      margin-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
    }

    .sidebar-solo-history-title {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .sidebar-solo-empty {
      font-size: 10px;
      color: var(--text-muted);
    }

    .sidebar-conversation {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.03);
      padding: 7px;
      cursor: pointer;
    }

    .sidebar-conversation-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px;
    }

    .sidebar-conversation-meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .sidebar-conversation-cli {
      color: #38bdf8;
      font-size: 10px;
      font-weight: 700;
    }

    .sidebar-conversation-summary {
      font-size: 10px;
      color: var(--text-main);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-conversation-time,
    .sidebar-conversation-runtime {
      font-size: 9px;
      color: var(--text-muted);
    }

    .sidebar-conversation-detail {
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid var(--border-glass);
      color: var(--text-muted);
      font-size: 10px;
      line-height: 1.45;
    }

    .sidebar-conversation-detail strong {
      color: var(--text-main);
    }

    .sidebar-conversation-detail pre {
      margin: 5px 0 0;
      padding: 6px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.2);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-muted);
      font-size: 9px;
    }

    .portfolio-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .portfolio-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-main);
    }

    .portfolio-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }

    .portfolio-filter-btn {
      border: 1px solid var(--border-glass);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: var(--text-muted);
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
    }

    .portfolio-filter-btn.active {
      background: rgba(0, 229, 255, 0.14);
      color: #d8fbff;
      border-color: rgba(0, 229, 255, 0.25);
    }

    .portfolio-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .empty-portfolio {
      color: var(--text-muted);
      font-size: 11px;
      text-align: center;
      padding: 10px 4px;
    }

    .portfolio-card {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 9px;
      background: rgba(255,255,255,0.03);
      cursor: pointer;
    }

    .portfolio-card.is-selected {
      border-color: rgba(0, 229, 255, 0.28);
      background: rgba(0, 229, 255, 0.07);
    }

    .portfolio-card-head,
    .portfolio-card-meta,
    .portfolio-card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .portfolio-card-meta {
      margin-top: 6px;
      font-size: 10px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .portfolio-project-name {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-stage,
    .portfolio-updated,
    .portfolio-recommendation {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-status {
      font-size: 10px;
      font-weight: 700;
    }

    .portfolio-progress {
      margin-top: 8px;
    }

    .portfolio-progress-track {
      height: 5px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      overflow: hidden;
    }

    .portfolio-progress-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #00e5ff, #7c4dff);
    }

    .portfolio-card-actions {
      margin-top: 8px;
    }

    .portfolio-action-btn {
      flex: 1;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255,255,255,0.05);
      color: var(--text-main);
      font-size: 10px;
      font-weight: 700;
      padding: 5px 8px;
      cursor: pointer;
    }

    .portfolio-action-btn.primary {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      border-color: transparent;
    }

    .portfolio-compose {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
      margin-top: 8px;
      cursor: default;
    }

    .portfolio-compose-row {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }

    .portfolio-compose-input {
      flex: 1 1 100%;
      min-width: 0;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 6px 7px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
    }

    .portfolio-compose-agent {
      flex: 1 1 120px;
      min-width: 0;
    }

    .portfolio-compose-send {
      border: none;
      border-radius: 5px;
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-size: 11px;
      font-weight: 800;
      padding: 6px 9px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .portfolio-compose-send:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .settings-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 6px;
      font-size: 10.5px;
      font-weight: 700;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .settings-action-btn.test-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
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
      font-size: 9.5px;
      padding: 4px 6px;
      border-radius: 4px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
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

    /* Progress Widget */
    .progress-widget {
      background: var(--bg-glass);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .progress-bar-bg {
      background: rgba(255, 255, 255, 0.08);
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }

    .progress-bar-fill {
      background: linear-gradient(90deg, #00e5ff, #7c4dff);
      height: 100%;
      width: 0%;
      border-radius: 3px;
      transition: width 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* AI Input Box */
    .ai-generator {
      margin-bottom: 16px;
    }

    .ai-input-group {
      display: flex;
      gap: 6px;
    }

    .ai-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 6px 8px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
      transition: all 0.3s ease;
    }

    .ai-input:focus {
      border-color: #00e5ff;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
    }

    .ai-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      transition: all 0.2s ease;
    }

    .ai-btn:hover {
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.4);
      transform: translateY(-0.5px);
    }

    /* Compact Node List */
    .node-list-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 60px;
    }

    .node-card {
      background: var(--bg-glass);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .node-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      background: rgba(22, 28, 45, 0.7);
    }

    /* Status Indicators */
    .node-card.status-Pending { border-left: 3px solid #64748b; }
    .node-card.status-Running { border-left: 3px solid #00e5ff; animation: pulse-border 1.5s infinite; }
    .node-card.status-In-Progress { border-left: 3px solid #facc15; }
    .node-card.status-Completed { border-left: 3px solid #00e676; }
    .node-card.status-Failed { border-left: 3px solid #ff1744; }

    @keyframes pulse-border {
      0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.25); }
      70% { box-shadow: 0 0 0 6px rgba(0, 229, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
    }

    .node-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .node-title {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .node-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border-glass);
    }

    .stage-Business-Planning { color: #818cf8; }
    .stage-Brand---Setup { color: #f472b6; }
    .stage-Product---MVP { color: #38bdf8; }
    .stage-Marketing---Growth { color: #34d399; }

    .node-action-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2px;
    }

    .status-lbl {
      font-size: 10px;
      font-weight: 600;
    }

    .status-lbl.Pending { color: #94a3b8; }
    .status-lbl.Running { color: #00e5ff; }
    .status-lbl.In-Progress { color: #facc15; }
    .status-lbl.Completed { color: #00e676; }
    .status-lbl.Failed { color: #ff1744; }

    .btn-run-small {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      padding: 3px 6px;
      font-size: 10px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 3px;
      transition: all 0.2s ease;
    }

    .btn-run-small:hover {
      background: #00e5ff;
      color: #000;
      border-color: #00e5ff;
    }

    .node-card.status-Running .btn-run-small {
      pointer-events: none;
      opacity: 0.4;
    }

    /* Fixed Premium Footer Button */
    .sidebar-footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 10px 12px;
      background: linear-gradient(to top, rgba(15,17,26,0.95), rgba(15,17,26,0.8));
      backdrop-filter: blur(8px);
      border-top: 1px solid var(--border-glass);
      z-index: 100;
    }

    .btn-large {
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-weight: 700;
      border: none;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 11px;
      cursor: pointer;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 12px rgba(124, 77, 255, 0.35);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .btn-large:hover {
      box-shadow: 0 6px 16px rgba(0, 229, 255, 0.5);
      transform: translateY(-0.5px);
    }
  </style>
</head>
<body>
  <div class="header-container">
    <h2 class="brand-title"><span class="codicon codicon-map"></span><span id="sidebar-title">SoloMap</span></h2>
    <button class="btn-gear" id="btn-toggle-settings" title="SoloMap Settings"><span class="codicon codicon-settings-gear"></span></button>
  </div>

  <div class="project-switcher">
    <div class="solo-select project-select" id="project-select" data-solo-select data-value="">
      <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
        <span class="solo-select-trigger-label" data-solo-label></span>
        <span class="codicon codicon-chevron-down solo-select-caret"></span>
      </button>
      <div class="solo-select-menu" data-solo-menu role="listbox"></div>
    </div>
    <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
  </div>

  <div class="sidebar-solo-card">
    <div class="sidebar-solo-title"><span class="codicon codicon-comment-discussion"></span><span id="sidebar-solo-title">Solo 对话</span></div>
    <div class="sidebar-solo-subtitle" id="sidebar-solo-subtitle">直接开始，结束后可在项目的 Solo 历史中查看。</div>
    <div class="sidebar-solo-controls">
      <div class="solo-select sidebar-solo-project" id="sidebar-solo-project" data-solo-select data-value="">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label></span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox"></div>
      </div>
      <div class="solo-select sidebar-solo-agent" id="sidebar-solo-agent" data-solo-select data-value="agy">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>agy</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox"></div>
      </div>
    </div>
    <div class="sidebar-solo-attachments" id="sidebar-solo-attachments"></div>
    <div class="sidebar-solo-compose">
      <button class="sidebar-solo-tool" id="btn-attach-sidebar-solo" title="添加补充文件"><span class="codicon codicon-attach"></span></button>
      <textarea class="sidebar-solo-input" id="sidebar-solo-input" placeholder="说说你现在想处理的问题..."></textarea>
      <button class="sidebar-solo-send" id="btn-send-sidebar-solo" title="发送"><span class="codicon codicon-send"></span></button>
    </div>
    <div class="sidebar-solo-history" id="sidebar-solo-history"></div>
  </div>

  <div class="portfolio-panel">
    <div class="portfolio-header">
      <div class="portfolio-title" id="portfolio-title">项目总览</div>
    </div>
    <div class="portfolio-filters" id="portfolio-filters"></div>
    <div class="portfolio-list" id="portfolio-list"></div>
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
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. agy, codex, claude, opencode">
      <div id="help-cli-path" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code>, <code>codex</code>, <code>claude</code>, <code>opencode</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-prompt">Default Agent Instructions</label>
      <textarea class="settings-input settings-textarea" id="setting-global-prompt" placeholder="e.g. Keep changes minimal and run the narrowest relevant test."></textarea>
      <div id="help-global-prompt" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Injected into every task conversation. Current conversation guidance takes priority.
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli"><span class="codicon codicon-debug-start"></span><span id="text-test-cli">Test CLI</span></button>
      <button class="settings-action-btn save-btn" id="btn-save-settings"><span class="codicon codicon-save"></span><span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <!-- Progress Widget -->
  <div class="progress-widget">
    <div class="progress-header">
      <span id="progress-label">Roadmap Sync Progress</span>
      <span id="progress-text">0/0 Tasks</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" id="progress-bar"></div>
    </div>
  </div>

  <!-- Tasks List -->
  <div class="node-list-container" id="tasks-list">
    <!-- Items are dynamically injected here -->
  </div>

  <!-- Footer CTA -->
  <div class="sidebar-footer">
    <button class="btn-large" id="btn-open-full">
      <span class="codicon codicon-type-hierarchy-sub"></span><span id="text-open-full">Open Visual Roadmap Graph</span>
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const tasksList = document.getElementById('tasks-list');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const btnOpenFull = document.getElementById('btn-open-full');
    const projectSelect = document.getElementById('project-select');
    const btnAddProject = document.getElementById('btn-add-project');
    const sidebarSoloProject = document.getElementById('sidebar-solo-project');
    const sidebarSoloAgent = document.getElementById('sidebar-solo-agent');
    const sidebarSoloAttachments = document.getElementById('sidebar-solo-attachments');
    const btnAttachSidebarSolo = document.getElementById('btn-attach-sidebar-solo');
    const sidebarSoloInput = document.getElementById('sidebar-solo-input');
    const btnSendSidebarSolo = document.getElementById('btn-send-sidebar-solo');
    const sidebarSoloHistory = document.getElementById('sidebar-solo-history');
    const portfolioList = document.getElementById('portfolio-list');
    const portfolioFilters = document.getElementById('portfolio-filters');

    // Settings elements
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
    let activeProjectPath = '';
    let activePortfolioFilter = 'all';
    let sidebarSoloFiles = [];
    let sidebarSoloConversations = [];
    let sidebarSoloConversationExpanded = false;
    const currentProjects = { projects: [], selectedProjectPath: '', portfolio: [] };
    const i18n = {
      zh: {
        title: 'SoloMap',
        portfolioTitle: '项目总览',
        soloTitle: 'Solo 对话',
        soloSubtitle: '直接开始，结束后可在项目的 Solo 历史中查看。',
        soloPlaceholder: '说说你现在想处理的问题...',
        soloSend: '发送',
        soloAttach: '添加补充文件',
        soloHistory: '最近一次 Solo 对话',
        noSoloConversations: '还没有 Solo 对话。',
        soloCompleted: '本次 Solo 对话已结束。',
        stillWorking: 'Agent 正在执行这次对话。',
        runResult: '本轮结果',
        failureLabel: '失败原因',
        agentConclusion: 'Agent 结论',
        command: '命令',
        output: '输出',
        elapsed: '已运行',
        duration: '耗时',
        changedCount: '本轮修改文件数',
        filterAll: '全部',
        filterActive: '进行中',
        filterFailed: '有失败',
        filterCompleted: '已完成',
        projectOpen: '打开',
        projectContinue: '继续推进',
        projectReviewFailure: '处理失败',
        emptyPortfolio: '还没有已登记项目。',
        noPortfolioMatch: '当前筛选下没有项目。',
        latestUpdate: '最近更新',
        currentStage: '当前阶段',
        nextAction: '下一步',
        nextActionSubtitle: '当前最该推进',
        nextActionReasonRunning: 'Agent 正在处理这个环节，先查看运行状态。',
        nextActionReasonFailed: '这个环节失败过，优先重试或补充要求。',
        nextActionReasonInProgress: '这个环节已经开始，继续推进最容易形成闭环。',
        nextActionReasonPending: '前置环节已满足，可以开始推进。',
        nextActionReasonComplete: '所有环节已完成，可以打开大图调整路线图。',
        nextActionPlaceholder: '补充这次要 Agent 做什么...',
        nextActionSend: '发送',
        continuePlaceholder: '补充这次推进要求...',
        continueSend: '发送',
        failures: '失败',
        selected: '当前项目',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、claude、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        progress: '路线图进度',
        tasks: '个任务',
        openFull: '打开路线图大图',
        empty: '还没有路线图。请先添加项目文件夹，或在路线图中推进“生成初始路线图”环节。',
        run: '对话',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败' }
      },
      en: {
        title: 'SoloMap',
        portfolioTitle: 'Project Portfolio',
        soloTitle: 'Solo conversation',
        soloSubtitle: 'Start directly. The conversation will stay in the selected project history.',
        soloPlaceholder: 'Describe what you want to handle...',
        soloSend: 'Send',
        soloAttach: 'Attach files',
        soloHistory: 'Latest Solo conversation',
        noSoloConversations: 'No Solo conversations yet.',
        soloCompleted: 'This Solo conversation has finished.',
        stillWorking: 'The Agent is running this conversation.',
        runResult: 'Run result',
        failureLabel: 'Failure reason',
        agentConclusion: 'Agent conclusion',
        command: 'Command',
        output: 'Output',
        elapsed: 'Elapsed',
        duration: 'Duration',
        changedCount: 'Files changed in this run',
        filterAll: 'All',
        filterActive: 'Active',
        filterFailed: 'Failed',
        filterCompleted: 'Done',
        projectOpen: 'Open',
        projectContinue: 'Continue',
        projectReviewFailure: 'Review Failure',
        emptyPortfolio: 'No registered projects yet.',
        noPortfolioMatch: 'No projects match this filter.',
        latestUpdate: 'Updated',
        currentStage: 'Stage',
        nextAction: 'Next',
        nextActionSubtitle: 'Current focus',
        nextActionReasonRunning: 'The Agent is already working on this step. Check the running state first.',
        nextActionReasonFailed: 'This step failed before. Retry it with clearer guidance.',
        nextActionReasonInProgress: 'This step is already in motion. Continue it to close the loop.',
        nextActionReasonPending: 'Dependencies are ready. This is the next step to start.',
        nextActionReasonComplete: 'All steps are complete. Open the roadmap to revise the next loop.',
        nextActionPlaceholder: 'Add guidance for this Agent run...',
        nextActionSend: 'Send',
        continuePlaceholder: 'Add guidance for this run...',
        continueSend: 'Send',
        failures: 'Failures',
        selected: 'Current project',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, claude, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; current conversation guidance takes priority.',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        progress: 'Roadmap Sync Progress',
        tasks: 'Tasks',
        openFull: 'Open Visual Roadmap Graph',
        empty: 'No roadmap yet. Add a project folder, or run the "Generate Initial Roadmap" step first.',
        run: 'Run',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
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
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('sidebar-title', t('title'));
      setText('portfolio-title', t('portfolioTitle'));
      setText('sidebar-solo-title', t('soloTitle'));
      setText('sidebar-solo-subtitle', t('soloSubtitle'));
      sidebarSoloInput.placeholder = t('soloPlaceholder');
      btnSendSidebarSolo.title = t('soloSend');
      btnAttachSidebarSolo.title = t('soloAttach');
      btnToggleSettings.title = t('settingsTitle');
      btnAddProject.title = t('chooseProject');
      setText('settings-title', t('settingsTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-global-prompt', t('globalPrompt'));
      settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      setText('progress-label', t('progress'));
      setText('text-open-full', t('openFull'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderSidebarSoloProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderSidebarSoloAgents();
      renderSidebarSoloAttachments();
      renderSidebarSoloHistory();
      renderPortfolioFilters();
      renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
      renderSidebar(currentNodes);
    }

    // Toggle settings panel
    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'block') {
        settingsPanel.style.display = 'none';
      } else {
        settingsPanel.style.display = 'block';
        vscode.postMessage({ command: 'getSettings' });
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    bindSoloSelect(settingLanguage, (value) => {
      currentLanguage = value;
      applyLanguage();
    });

    // Request configurations and nodes on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });
    vscode.postMessage({ command: 'getProjects' });

    // Handle messages
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, false);
          }
          currentNodes = message.nodes || [];
          renderSidebar(message.nodes);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'settingsLoaded':
          settingCliPath.value = message.settings.cliPath || 'agy';
          settingGlobalPrompt.value = message.settings.globalPrompt || '';
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
            renderSidebar(currentNodes);
          } else if (message.projects.selectedProjectPath && !activeProjectPath) {
            activeProjectPath = message.projects.selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          currentProjects.portfolio = message.projects.portfolio || [];
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
          renderSidebarSoloProjects(message.projects.projects, message.projects.selectedProjectPath);
          renderPortfolio(message.projects.portfolio || [], message.projects.selectedProjectPath || '');
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

        case 'soloSupplementFilesSelected':
          sidebarSoloFiles = (message.files || []).slice(0, 10);
          renderSidebarSoloAttachments();
          break;

        case 'sidebarSoloConversationLoaded':
          if (message.projectPath !== getSoloSelectValue(sidebarSoloProject)) return;
          sidebarSoloConversations = message.conversations || [];
          sidebarSoloConversationExpanded = false;
          renderSidebarSoloHistory();
          break;
      }
    });

    // Save Settings
    btnSaveSettings.addEventListener('click', () => {
      vscode.postMessage({
        command: 'updateSettings',
        cliPath: settingCliPath.value.trim(),
        language: getSoloSelectValue(settingLanguage),
        globalPrompt: settingGlobalPrompt.value.trim()
      });
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    // Test CLI connection
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

    btnOpenFull.addEventListener('click', () => {
      vscode.postMessage({ command: 'showFullRoadmap' });
    });

    bindSoloSelect(projectSelect, (value) => {
      vscode.postMessage({
        command: 'selectProject',
        projectPath: value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    bindSoloSelect(sidebarSoloProject, () => {
      sidebarSoloFiles = [];
      renderSidebarSoloAttachments();
      sidebarSoloConversations = [];
      sidebarSoloConversationExpanded = false;
      renderSidebarSoloHistory();
      vscode.postMessage({ command: 'getSoloConversationHistory', projectPath: getSoloSelectValue(sidebarSoloProject) });
    });
    bindSoloSelect(sidebarSoloAgent);

    function sendSidebarSoloConversation() {
      const userMessage = sidebarSoloInput.value.trim();
      const projectPath = getSoloSelectValue(sidebarSoloProject);
      if (!projectPath || !userMessage) return;
      vscode.postMessage({
        command: 'runSoloConversation',
        projectPath,
        userMessage,
        agentCli: getSoloSelectValue(sidebarSoloAgent),
        supplementFiles: sidebarSoloFiles
      });
      sidebarSoloInput.value = '';
      sidebarSoloFiles = [];
      renderSidebarSoloAttachments();
      vscode.postMessage({ command: 'getSoloConversationHistory', projectPath });
    }

    btnAttachSidebarSolo.addEventListener('click', () => {
      const projectPath = getSoloSelectValue(sidebarSoloProject);
      if (!projectPath) return;
      vscode.postMessage({ command: 'chooseSoloSupplementFiles', projectPath });
    });

    btnSendSidebarSolo.addEventListener('click', sendSidebarSoloConversation);
    sidebarSoloInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        sendSidebarSoloConversation();
      }
    });

    function renderPortfolioFilters() {
      const filters = [
        { key: 'all', label: t('filterAll') },
        { key: 'active', label: t('filterActive') },
        { key: 'failed', label: t('filterFailed') },
        { key: 'completed', label: t('filterCompleted') }
      ];
      portfolioFilters.innerHTML = filters.map(filter => \`
        <button class="portfolio-filter-btn \${activePortfolioFilter === filter.key ? 'active' : ''}" data-portfolio-filter="\${filter.key}">
          \${filter.label}
        </button>
      \`).join('');
      portfolioFilters.querySelectorAll('[data-portfolio-filter]').forEach(button => {
        button.addEventListener('click', () => {
          activePortfolioFilter = button.getAttribute('data-portfolio-filter') || 'all';
          renderPortfolioFilters();
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
    }

    function renderProjects(projects, selectedProjectPath) {
      if (!projects || projects.length === 0) {
        setSoloSelectOptions(projectSelect, [{ value: '', label: t('chooseProject') }], '');
        return;
      }

      setSoloSelectOptions(projectSelect, projects.map(project => ({
        value: project.path,
        label: project.name,
        title: project.path
      })), selectedProjectPath);
    }

    function renderSidebarSoloProjects(projects, selectedProjectPath) {
      const existingSelection = getSoloSelectValue(sidebarSoloProject);
      if (!projects || projects.length === 0) {
        setSoloSelectOptions(sidebarSoloProject, [{ value: '', label: t('chooseProject') }], '');
        return;
      }
      setSoloSelectOptions(sidebarSoloProject, projects.map(project => ({
        value: project.path,
        label: project.name,
        title: project.path
      })), selectedProjectPath);
      if (existingSelection && existingSelection !== selectedProjectPath) {
        sidebarSoloFiles = [];
        renderSidebarSoloAttachments();
      }
      if (selectedProjectPath) {
        vscode.postMessage({ command: 'getSoloConversationHistory', projectPath: selectedProjectPath });
      }
    }

    function renderSidebarSoloAttachments() {
      sidebarSoloAttachments.innerHTML = sidebarSoloFiles.map((file, index) => \`
        <span class="sidebar-solo-file">
          <span class="sidebar-solo-file-name">\${escapeHtml(file)}</span>
          <button class="sidebar-solo-file-remove" data-remove-sidebar-solo-file="\${index}" title="Remove">&times;</button>
        </span>
      \`).join('');
      sidebarSoloAttachments.querySelectorAll('[data-remove-sidebar-solo-file]').forEach(button => {
        button.addEventListener('click', () => {
          sidebarSoloFiles.splice(Number(button.getAttribute('data-remove-sidebar-solo-file')), 1);
          renderSidebarSoloAttachments();
        });
      });
    }

    function summarizeSoloConversation(conversation) {
      const output = String(conversation.output || '');
      const userMatch = output.match(/User supplement:\\n([\\s\\S]*?)(?:\\n\\n|$)/);
      if (userMatch && userMatch[1].trim()) {
        return userMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const changedMatch = output.match(/Touched project files:\\n([\\s\\S]*?)(?:\\n\\n|$)/);
      if (changedMatch && changedMatch[1].trim() && !changedMatch[1].includes('No project files')) {
        return changedMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const tailMatch = output.match(/Agent output tail:\\n([\\s\\S]*)$/);
      const fallback = tailMatch ? tailMatch[1] : output;
      return fallback.trim().replace(/\\s+/g, ' ').slice(0, 120) || statusText(conversation.status);
    }

    function soloConclusion(output) {
      const match = String(output || '').match(/Agent output tail:\\n([\\s\\S]*)$/);
      return match && match[1]
        ? match[1].split('\\n').map(line => line.trim()).filter(line => line && !line.startsWith('SoloMap:')).slice(-3).join(' ').replace(/\\s+/g, ' ').slice(0, 240)
        : '';
    }

    function formatSoloDuration(conversation) {
      const stored = String(conversation.output || '').match(/Run duration ms:\\s*(\\d+)/);
      const durationMs = stored
        ? Number(stored[1])
        : conversation.status === 'Running' && conversation.timestamp
          ? Date.now() - new Date(conversation.timestamp).getTime()
          : 0;
      if (!durationMs) return '';
      const seconds = Math.max(0, Math.floor(durationMs / 1000));
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      return minutes > 0 ? minutes + 'm ' + remainder + 's' : remainder + 's';
    }

    function countSoloChangedFiles(output) {
      const match = String(output || '').match(/Touched project files:\\n([\\s\\S]*?)(?:\\n\\n|$)/);
      if (!match || !match[1]) return 0;
      return match[1].split('\\n').map(line => line.trim()).filter(line => line && !/^No (workspace|git|project) /i.test(line)).length;
    }

    function renderSidebarSoloHistory() {
      const conversation = sidebarSoloConversations[0];
      if (!conversation) {
        sidebarSoloHistory.innerHTML = '<div class="sidebar-solo-history-title">' + escapeHtml(t('soloHistory')) + '</div><div class="sidebar-solo-empty">' + escapeHtml(t('noSoloConversations')) + '</div>';
        return;
      }
      const failedReason = (String(conversation.output || '').match(/Failure reason:\\n([\\s\\S]*?)(?:\\n\\n|$)/) || [])[1] || '';
      const outcome = conversation.status === 'Running' ? t('stillWorking')
        : conversation.status === 'Failed' ? (failedReason.trim() || statusText(conversation.status))
        : t('soloCompleted');
      const conclusion = conversation.status === 'Running' ? '' : soloConclusion(conversation.output);
      const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
      const duration = formatSoloDuration(conversation);
      const changedCount = conversation.status === 'Running' ? 0 : countSoloChangedFiles(conversation.output);
      const result = outcome + (changedCount ? ' ' + t('changedCount') + ': ' + changedCount + '.' : '');
      sidebarSoloHistory.innerHTML = \`
        <div class="sidebar-solo-history-title">\${escapeHtml(t('soloHistory'))}</div>
        <div class="sidebar-conversation" data-sidebar-solo-conversation>
          <div class="sidebar-conversation-row">
            <div class="sidebar-conversation-meta">
              <span class="sidebar-conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
              <span class="sidebar-conversation-summary">\${escapeHtml(summarizeSoloConversation(conversation))}</span>
              <span class="sidebar-conversation-time">\${escapeHtml(when)}</span>
              \${duration ? \`<span class="sidebar-conversation-runtime">\${escapeHtml((conversation.status === 'Running' ? t('elapsed') : t('duration')) + ': ' + duration)}</span>\` : ''}
            </div>
            <span class="status-lbl \${statusClass(conversation.status)}">\${escapeHtml(statusText(conversation.status))}</span>
          </div>
          \${sidebarSoloConversationExpanded ? \`
            <div class="sidebar-conversation-detail">
              <strong>\${escapeHtml(conversation.status === 'Failed' ? t('failureLabel') : t('runResult'))}:</strong> \${escapeHtml(result)}
              \${conclusion ? \`<div><strong>\${escapeHtml(t('agentConclusion'))}:</strong> \${escapeHtml(conclusion)}</div>\` : ''}
              <strong>\${escapeHtml(t('command'))}</strong>
              <pre>\${escapeHtml(conversation.command || '')}</pre>
              <strong>\${escapeHtml(t('output'))}</strong>
              <pre>\${escapeHtml(conversation.output || '')}</pre>
            </div>
          \` : ''}
        </div>
      \`;
      const card = sidebarSoloHistory.querySelector('[data-sidebar-solo-conversation]');
      if (card) {
        card.addEventListener('click', () => {
          sidebarSoloConversationExpanded = !sidebarSoloConversationExpanded;
          renderSidebarSoloHistory();
        });
      }
    }

    function formatRelativeTime(value) {
      if (!value) return '';
      const time = new Date(value).getTime();
      if (Number.isNaN(time)) return '';
      const diffMinutes = Math.max(0, Math.round((Date.now() - time) / 60000));
      if (diffMinutes < 1) return currentLanguage === 'zh' ? '刚刚' : 'just now';
      if (diffMinutes < 60) return currentLanguage === 'zh' ? (diffMinutes + ' 分钟前') : (diffMinutes + 'm');
      const diffHours = Math.round(diffMinutes / 60);
      if (diffHours < 24) return currentLanguage === 'zh' ? (diffHours + ' 小时前') : (diffHours + 'h');
      const diffDays = Math.round(diffHours / 24);
      return currentLanguage === 'zh' ? (diffDays + ' 天前') : (diffDays + 'd');
    }

    function shouldShowPortfolioProject(project) {
      if (activePortfolioFilter === 'failed') {
        return Number(project.failedNodes || 0) > 0;
      }
      if (activePortfolioFilter === 'completed') {
        return Number(project.totalNodes || 0) > 0 && project.overallStatus === 'Completed';
      }
      if (activePortfolioFilter === 'active') {
        return project.overallStatus === 'Running' || project.overallStatus === 'In Progress' || Number(project.failedNodes || 0) > 0;
      }
      return true;
    }

    function dependenciesSatisfied(node, nodes) {
      const completedIds = new Set((nodes || []).filter(candidate => candidate.status === 'Completed').map(candidate => String(candidate.id)));
      const dependencies = String(node.dependencies || '')
        .split(',')
        .map(dependency => dependency.trim())
        .filter(Boolean);
      return dependencies.every(dependency => completedIds.has(dependency));
    }

    function getNextActionNode(nodes) {
      if (!nodes || nodes.length === 0) return null;
      const byStatus = status => nodes.find(node => node.status === status);
      return byStatus('Running')
        || byStatus('Failed')
        || byStatus('In Progress')
        || nodes.find(node => node.status === 'Pending' && dependenciesSatisfied(node, nodes))
        || byStatus('Pending')
        || nodes.find(node => node.status !== 'Completed')
        || nodes[0];
    }

    function getNextActionReason(node, nodes) {
      if (!node) return '';
      if (node.status === 'Running') return t('nextActionReasonRunning');
      if (node.status === 'Failed') return t('nextActionReasonFailed');
      if (node.status === 'In Progress') return t('nextActionReasonInProgress');
      if (node.status === 'Pending') return t('nextActionReasonPending');
      if ((nodes || []).every(candidate => candidate.status === 'Completed')) return t('nextActionReasonComplete');
      return t('nextActionReasonPending');
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

    function getAgentOptions(node) {
      const options = [];
      function add(value) {
        const normalized = String(value || '').trim();
        if (!normalized || options.includes(normalized)) return;
        options.push(normalized);
      }
      add(node && node.agentCli);
      add(settingCliPath.value || 'agy');
      add('agy');
      add('codex');
      add('claude');
      add('opencode');
      add('antigravity');
      add('antigravity-cli');
      add('codex-cli');
      return options.map(option => ({ value: option, label: option }));
    }

    function renderSidebarSoloAgents() {
      const existingSelection = getSoloSelectValue(sidebarSoloAgent);
      const options = getAgentOptions({ agentCli: existingSelection || settingCliPath.value || 'agy' });
      setSoloSelectOptions(sidebarSoloAgent, options, existingSelection || settingCliPath.value || 'agy');
    }

    function renderProjectContinueComposer(nodes) {
      const node = getNextActionNode(nodes || []);
      if (!node) {
        return '';
      }
      const disabled = node.status === 'Running' || node.status === 'Completed';
      return \`
        <div class="portfolio-compose" data-project-continue-composer>
          <div class="portfolio-compose-row">
            <input class="portfolio-compose-input" data-project-continue-input placeholder="\${escapeHtml(t('continuePlaceholder'))}" \${disabled ? 'disabled' : ''}>
            \${renderSoloSelect('portfolio-compose-agent', 'data-project-continue-agent', getAgentOptions(node), disabled)}
            <button class="portfolio-compose-send" data-project-continue-send data-next-node-id="\${escapeHtml(node.id)}" \${disabled ? 'disabled' : ''}>
              <span class="codicon codicon-send"></span><span>\${escapeHtml(t('continueSend'))}</span>
            </button>
          </div>
        </div>
      \`;
    }

    function bindProjectContinueComposer(container) {
      bindSoloSelects(container);
      container.querySelectorAll('[data-project-continue-send]').forEach(sendButton => {
        sendButton.addEventListener('click', (event) => {
          event.stopPropagation();
          const panel = sendButton.closest('[data-project-continue-composer]');
          const input = panel ? panel.querySelector('[data-project-continue-input]') : null;
          const agentSelect = panel ? panel.querySelector('[data-project-continue-agent]') : null;
          runNodeAgent(sendButton.getAttribute('data-next-node-id'), input ? input.value : '', getSoloSelectValue(agentSelect));
          if (input) input.value = '';
        });
      });
      container.querySelectorAll('[data-project-continue-input], [data-project-continue-agent]').forEach(item => {
        item.addEventListener('click', (event) => event.stopPropagation());
      });
    }

    function renderPortfolio(portfolio, selectedProjectPath) {
      if (!portfolio || portfolio.length === 0) {
        portfolioList.innerHTML = '<div class="empty-portfolio">' + t('emptyPortfolio') + '</div>';
        return;
      }

      const visibleProjects = portfolio.filter(shouldShowPortfolioProject);
      if (!visibleProjects.length) {
        portfolioList.innerHTML = '<div class="empty-portfolio">' + t('noPortfolioMatch') + '</div>';
        return;
      }

      portfolioList.innerHTML = visibleProjects.map(project => {
        const isSelected = project.path === selectedProjectPath;
        const nextActionLabel = Number(project.failedNodes || 0) > 0 ? t('projectReviewFailure') : t('projectContinue');
        const progressWidth = Math.max(0, Math.min(100, Number(project.progressPercent || 0)));
        const relativeTime = formatRelativeTime(project.recentActivityAt);
        const recommendation = project.recommendedNodeTitle || '';
        return \`
          <div class="portfolio-card \${isSelected ? 'is-selected' : ''}" data-select-project-path="\${escapeHtml(project.path)}">
            <div class="portfolio-card-head">
              <span class="portfolio-project-name">\${escapeHtml(project.name)}</span>
              <span class="portfolio-status status-lbl \${statusClass(project.overallStatus)}">\${statusText(project.overallStatus)}</span>
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-stage">\${t('currentStage')}: \${escapeHtml(project.currentStage || '-')}</span>
              <span>\${project.completedNodes}/\${project.totalNodes || 0}</span>
              <span>\${t('failures')}: \${project.failedNodes || 0}</span>
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-updated">\${t('latestUpdate')}: \${relativeTime || '-'}</span>
              \${isSelected ? \`<span>\${t('selected')}</span>\` : ''}
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-recommendation">\${t('nextAction')}: \${escapeHtml(recommendation || '-')}</span>
            </div>
            <div class="portfolio-progress">
              <div class="portfolio-progress-track">
                <div class="portfolio-progress-fill" style="width:\${progressWidth}%"></div>
              </div>
            </div>
            <div class="portfolio-card-actions">
              <button class="portfolio-action-btn" data-open-project-path="\${escapeHtml(project.path)}">\${t('projectOpen')}</button>
              \${isSelected ? '' : \`<button class="portfolio-action-btn primary" data-continue-project-path="\${escapeHtml(project.path)}" data-continue-node-id="\${escapeHtml(project.recommendedNodeId || '')}">\${nextActionLabel}</button>\`}
            </div>
            \${isSelected ? renderProjectContinueComposer(currentNodes) : ''}
          </div>
        \`;
      }).join('');

      portfolioList.querySelectorAll('[data-select-project-path]').forEach(card => {
        card.addEventListener('click', (event) => {
          if (event.target.closest('button') || event.target.closest('input') || event.target.closest('[data-solo-select]')) return;
          const projectPath = card.getAttribute('data-select-project-path') || '';
          setSoloSelectValue(sidebarSoloProject, projectPath);
          sidebarSoloFiles = [];
          renderSidebarSoloAttachments();
          vscode.postMessage({
            command: 'selectProject',
            projectPath
          });
        });
      });
      portfolioList.querySelectorAll('[data-open-project-path]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            command: 'openProjectFromPortfolio',
            projectPath: button.getAttribute('data-open-project-path')
          });
        });
      });
      portfolioList.querySelectorAll('[data-continue-project-path]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            command: 'continueProjectFromPortfolio',
            projectPath: button.getAttribute('data-continue-project-path'),
            nodeId: button.getAttribute('data-continue-node-id')
          });
        });
      });
      bindProjectContinueComposer(portfolioList);
    }

    function renderSidebar(nodes) {
      tasksList.innerHTML = '';

      if (!nodes || nodes.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.style.color = 'var(--text-muted)';
        emptyState.style.fontSize = '11px';
        emptyState.style.textAlign = 'center';
        emptyState.style.padding = '20px 0';
        emptyState.textContent = t('empty');
        tasksList.appendChild(emptyState);

        progressBar.style.width = '0%';
        progressText.textContent = '0 / 0 ' + t('tasks');
        return;
      }

      // Calculate progress metrics
      const total = nodes.length;
      const completed = nodes.filter(n => n.status === 'Completed').length;
      const percent = Math.round((completed / total) * 100);

      progressBar.style.width = percent + '%';
      progressText.textContent = completed + ' / ' + total + ' ' + t('tasks') + ' (' + percent + '%)';

      nodes.forEach(node => {
        const card = document.createElement('div');
        card.className = 'node-card status-' + statusClass(node.status);
        card.addEventListener('click', (e) => {
          // Prevent triggers clicking the run button itself
          if (e.target.closest('button')) return;
          // Open full visual editor on clicking the card
          vscode.postMessage({ command: 'showFullRoadmap' });
        });

        // Small run button if applicable
        const actionHtml = (node.status === 'Pending' || node.status === 'Failed' || node.status === 'In Progress')
          ? '<button class="btn-run-small" data-run-node-id="' + node.id + '"><span class="codicon codicon-comment-discussion"></span>' + t('run') + '</button>'
          : '';

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');

        card.innerHTML = \`
          <div class="node-meta">
            <span class="node-title">\${node.title}</span>
            <span class="node-badge stage-\${cleanStage}">\${node.stage}</span>
          </div>
          <div class="node-action-bar">
            <span class="status-lbl \${statusClass(node.status)}">\${statusText(node.status)}</span>
            \${actionHtml}
          </div>
        \`;

        const runButton = card.querySelector('[data-run-node-id]');
        if (runButton) {
          runButton.addEventListener('click', () => {
            runNodeAgent(node.id, '', node.agentCli || '');
          });
        }

        tasksList.appendChild(card);
      });
    }

    function runNodeAgent(nodeId, userMessage, agentCli) {
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
}
