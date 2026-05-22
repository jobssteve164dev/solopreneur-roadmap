import * as vscode from 'vscode';
import { SyncEngine } from './db/syncEngine';

export class SolopreneurSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'solopreneur.sidebar';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _syncEngine: SyncEngine,
    private readonly _onRunAgent: (nodeId: string) => Promise<void>,
    private readonly _onGenerateRoadmap: (prompt: string) => Promise<void>
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
        case 'generateRoadmap':
          await this._onGenerateRoadmap(data.prompt);
          break;
        case 'showFullRoadmap':
          vscode.commands.executeCommand('solopreneur.showRoadmap');
          break;
        case 'getSettings':
          this.sendSettings();
          break;
        case 'updateSettings':
          const config = vscode.workspace.getConfiguration('solopreneur');
          await config.update('apiProvider', data.apiProvider, vscode.ConfigurationTarget.Global);
          await config.update('apiKey', data.apiKey, vscode.ConfigurationTarget.Global);
          await config.update('cliPath', data.cliPath, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Solopreneur settings saved successfully!');
          // Broadcast to sync both Webviews
          this.sendSettings();
          // Trigger updates on the full screen view if active
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;
        case 'testCli':
          const exec = require('child_process').exec;
          exec(`${data.cliPath} --version`, (error: any, stdout: string, stderr: string) => {
            const success = !error;
            let msg = error ? error.message : (stdout.trim() || stderr.trim());
            // Shorten error messages for the compact sidebar badge
            if (!success) {
              msg = 'Command not found or failed';
            }
            this._view?.webview.postMessage({
              command: 'cliTestResult',
              success,
              message: msg
            });
          });
          break;
      }
    });

    // Request initial data push
    this.sendNodesToWebview();
    this.sendSettings();
  }

  /**
   * Refreshes the sidebar view with updated node states.
   */
  public sendNodesToWebview() {
    if (this._view && this._syncEngine) {
      const nodes = this._syncEngine.getNodes();
      this._view.webview.postMessage({
        command: 'nodesUpdated',
        nodes: nodes
      });
    }
  }

  /**
   * Reads and pushes active configuration settings to the sidebar.
   */
  public sendSettings() {
    if (this._view) {
      const config = vscode.workspace.getConfiguration('solopreneur');
      this._view.webview.postMessage({
        command: 'settingsLoaded',
        settings: {
          apiProvider: config.get('apiProvider') || 'Gemini',
          apiKey: config.get('apiKey') || '',
          cliPath: config.get('cliPath') || 'antigravity-cli'
        }
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solopreneur Control Panel</title>
  <!-- Load Inter & Outfit Fonts Asynchronously -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
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
      font-size: 15px;
      padding: 4px;
      display: flex;
      align-items: center;
      transition: color 0.2s;
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
    <h2>🎯 Solopreneur Control Panel</h2>
    <button class="btn-gear" id="btn-toggle-settings" title="Solopreneur Settings">⚙️</button>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3>⚙️ Solopreneur Settings</h3>
      <button class="btn-close-settings" id="btn-close-settings">×</button>
    </div>
    
    <div class="settings-field">
      <label class="settings-lbl-title">AI Provider</label>
      <select class="settings-select" id="setting-provider">
        <option value="Gemini">Gemini</option>
        <option value="OpenAI">OpenAI</option>
        <option value="VS Code Copilot (Native)">VS Code Copilot (Native)</option>
      </select>
    </div>

    <div class="settings-field" id="api-key-container">
      <label class="settings-lbl-title">API Key</label>
      <input type="password" class="settings-input" id="setting-key" placeholder="Enter API Key...">
      <div style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Required for standalone providers (Gemini or OpenAI). Not needed for VS Code Copilot (Native).
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title">CLI Command or Path</label>
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. antigravity-cli">
      <div style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>antigravity-cli</code> or <code>codex-cli</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli">⚡ Test CLI</button>
      <button class="settings-action-btn save-btn" id="btn-save-settings">💾 Save</button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <!-- Progress Widget -->
  <div class="progress-widget">
    <div class="progress-header">
      <span>Roadmap Sync Progress</span>
      <span id="progress-text">0/0 Tasks</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" id="progress-bar"></div>
    </div>
  </div>

  <!-- AI Prompt Generator -->
  <div class="ai-generator">
    <div class="ai-input-group">
      <input type="text" id="ai-prompt-sidebar" class="ai-input" placeholder="Generate new project tasks...">
      <button id="btn-generate-sidebar" class="ai-btn">Generate</button>
    </div>
  </div>

  <!-- Tasks List -->
  <div class="node-list-container" id="tasks-list">
    <!-- Items are dynamically injected here -->
  </div>

  <!-- Footer CTA -->
  <div class="sidebar-footer">
    <button class="btn-large" id="btn-open-full">
      🖥️ Open Visual Roadmap Graph
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const tasksList = document.getElementById('tasks-list');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const btnGenerate = document.getElementById('btn-generate-sidebar');
    const aiPromptInput = document.getElementById('ai-prompt-sidebar');
    const btnOpenFull = document.getElementById('btn-open-full');

    // Settings elements
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingProvider = document.getElementById('setting-provider');
    const settingKey = document.getElementById('setting-key');
    const apiKeyContainer = document.getElementById('api-key-container');
    const settingCliPath = document.getElementById('setting-clipath');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');

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

    settingProvider.addEventListener('change', () => {
      if (settingProvider.value === 'VS Code Copilot (Native)') {
        apiKeyContainer.style.display = 'none';
      } else {
        apiKeyContainer.style.display = 'flex';
      }
    });

    // Request configurations and nodes on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });

    // Handle messages
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          renderSidebar(message.nodes);
          break;

        case 'settingsLoaded':
          settingProvider.value = message.settings.apiProvider || 'Gemini';
          settingKey.value = message.settings.apiKey || '';
          settingCliPath.value = message.settings.cliPath || 'antigravity-cli';
          
          if (settingProvider.value === 'VS Code Copilot (Native)') {
            apiKeyContainer.style.display = 'none';
          } else {
            apiKeyContainer.style.display = 'flex';
          }
          break;

        case 'cliTestResult':
          cliTestBadge.style.display = 'block';
          if (message.success) {
            cliTestBadge.className = 'cli-badge success';
            cliTestBadge.textContent = 'Connection OK: ' + message.message;
          } else {
            cliTestBadge.className = 'cli-badge error';
            cliTestBadge.textContent = 'Connection Failed: ' + message.message;
          }
          break;
      }
    });

    // Save Settings
    btnSaveSettings.addEventListener('click', () => {
      vscode.postMessage({
        command: 'updateSettings',
        apiProvider: settingProvider.value,
        apiKey: settingKey.value.trim(),
        cliPath: settingCliPath.value.trim()
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
      cliTestBadge.textContent = 'Testing connection...';

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

    btnOpenFull.addEventListener('click', () => {
      vscode.postMessage({ command: 'showFullRoadmap' });
    });

    function renderSidebar(nodes) {
      tasksList.innerHTML = '';

      if (!nodes || nodes.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.style.color = 'var(--text-muted)';
        emptyState.style.fontSize = '11px';
        emptyState.style.textAlign = 'center';
        emptyState.style.padding = '20px 0';
        emptyState.textContent = 'No tasks in roadmap. Enter a prompt above to generate your plan!';
        tasksList.appendChild(emptyState);

        progressBar.style.width = '0%';
        progressText.textContent = '0 / 0 Tasks';
        return;
      }

      // Calculate progress metrics
      const total = nodes.length;
      const completed = nodes.filter(n => n.status === 'Completed').length;
      const percent = Math.round((completed / total) * 100);

      progressBar.style.width = percent + '%';
      progressText.textContent = completed + ' / ' + total + ' Tasks (' + percent + '%)';

      nodes.forEach(node => {
        const card = document.createElement('div');
        card.className = 'node-card status-' + node.status;
        card.addEventListener('click', (e) => {
          // Prevent triggers clicking the run button itself
          if (e.target.closest('button')) return;
          // Open full visual editor on clicking the card
          vscode.postMessage({ command: 'showFullRoadmap' });
        });

        // Small run button if applicable
        const actionHtml = (node.status === 'Pending' || node.status === 'Failed')
          ? '<button class="btn-run-small" data-run-node-id="' + node.id + '">⚡ Run</button>'
          : '';

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');

        card.innerHTML = \`
          <div class="node-meta">
            <span class="node-title">\${node.title}</span>
            <span class="node-badge stage-\${cleanStage}">\${node.stage}</span>
          </div>
          <div class="node-action-bar">
            <span class="status-lbl \${node.status}">\${node.status}</span>
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
