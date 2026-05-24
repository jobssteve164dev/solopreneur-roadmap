import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';

interface SolopreneurSettings {
  cliPath: string;
  language: string;
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
  const byStatus = (status: string) => nodes.find((node) => node.status === status);
  return byStatus('Failed')
    || byStatus('In Progress')
    || byStatus('Running')
    || nodes.find((node) => node.status === 'Pending' && !(node.dependencies || '').trim())
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
    private readonly _onRunAgent: (nodeId: string) => Promise<void>,
    private readonly _getSettings: () => SolopreneurSettings,
    private readonly _updateSettings: (settings: SolopreneurSettings) => Promise<void>,
    private readonly _getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string },
    private readonly _selectProject: (projectPath: string) => Promise<void>,
    private readonly _addProject: () => Promise<void>
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
          await this._onRunAgent(data.nodeId);
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
            language: data.language
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
    }
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
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
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

    .settings-input, .settings-select {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 5px 6px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
    }

    .settings-input:focus, .settings-select:focus {
      border-color: #00e5ff;
    }

    .project-switcher {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }

    .project-select {
      flex: 1;
      min-width: 0;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 5px 6px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
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
      background: var(--bg-glass);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
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
    <select class="project-select" id="project-select"></select>
    <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
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
      <select class="settings-select" id="setting-language">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </div>
    
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. agy">
      <div id="help-cli-path" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code> or <code>codex</code>) or the absolute path to its executable.
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
    const portfolioList = document.getElementById('portfolio-list');
    const portfolioFilters = document.getElementById('portfolio-filters');

    // Settings elements
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliPath = document.getElementById('setting-clipath');
    const settingLanguage = document.getElementById('setting-language');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let activeProjectPath = '';
    let activePortfolioFilter = 'all';
    const currentProjects = { projects: [], selectedProjectPath: '', portfolio: [] };
    const i18n = {
      zh: {
        title: 'SoloMap',
        portfolioTitle: '项目总览',
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
        failures: '失败',
        selected: '当前项目',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex）或可执行文件绝对路径。',
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
        failures: 'Failures',
        selected: 'Current project',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy or codex, or an absolute executable path.',
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
      btnToggleSettings.title = t('settingsTitle');
      btnAddProject.title = t('chooseProject');
      setText('settings-title', t('settingsTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      setText('progress-label', t('progress'));
      setText('text-open-full', t('openFull'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
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

    settingLanguage.addEventListener('change', () => {
      currentLanguage = settingLanguage.value;
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
          break;

        case 'settingsLoaded':
          settingCliPath.value = message.settings.cliPath || 'agy';
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
            renderSidebar(currentNodes);
          } else if (message.projects.selectedProjectPath && !activeProjectPath) {
            activeProjectPath = message.projects.selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          currentProjects.portfolio = message.projects.portfolio || [];
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
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
      }
    });

    // Save Settings
    btnSaveSettings.addEventListener('click', () => {
      vscode.postMessage({
        command: 'updateSettings',
        cliPath: settingCliPath.value.trim(),
        language: settingLanguage.value
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

    projectSelect.addEventListener('change', () => {
      vscode.postMessage({
        command: 'selectProject',
        projectPath: projectSelect.value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
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
          <div class="portfolio-card \${isSelected ? 'is-selected' : ''}">
            <div class="portfolio-card-head">
              <span class="portfolio-project-name">\${project.name}</span>
              <span class="portfolio-status status-lbl \${statusClass(project.overallStatus)}">\${statusText(project.overallStatus)}</span>
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-stage">\${t('currentStage')}: \${project.currentStage || '-'}</span>
              <span>\${project.completedNodes}/\${project.totalNodes || 0}</span>
              <span>\${t('failures')}: \${project.failedNodes || 0}</span>
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-updated">\${t('latestUpdate')}: \${relativeTime || '-'}</span>
              \${isSelected ? \`<span>\${t('selected')}</span>\` : ''}
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-recommendation">\${t('nextAction')}: \${recommendation || '-'}</span>
            </div>
            <div class="portfolio-progress">
              <div class="portfolio-progress-track">
                <div class="portfolio-progress-fill" style="width:\${progressWidth}%"></div>
              </div>
            </div>
            <div class="portfolio-card-actions">
              <button class="portfolio-action-btn" data-open-project-path="\${project.path}">\${t('projectOpen')}</button>
              <button class="portfolio-action-btn primary" data-continue-project-path="\${project.path}" data-continue-node-id="\${project.recommendedNodeId || ''}">\${nextActionLabel}</button>
            </div>
          </div>
        \`;
      }).join('');

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
            runNodeAgent(node.id);
          });
        }

        tasksList.appendChild(card);
      });
    }

    function runNodeAgent(nodeId) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId
      });
    }
  </script>
</body>
</html>`;
  }
}
