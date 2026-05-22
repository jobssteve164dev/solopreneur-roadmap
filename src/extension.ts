import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SyncEngine } from './db/syncEngine';
import { RoadmapNode } from './db/types';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;

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
}

async function openRoadmapPanel(context: vscode.ExtensionContext) {
  // Check if workspace is open
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage('Please open a workspace/folder before launching the Roadmap!');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const solopreneurDir = path.join(workspaceRoot, '.solopreneur');

  // Create .solopreneur data directory if it doesn't exist
  if (!fs.existsSync(solopreneurDir)) {
    fs.mkdirSync(solopreneurDir, { recursive: true });
  }

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  // Initialize Sync Engine
  if (!syncEngine) {
    syncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
  }

  try {
    await syncEngine.initAndSync();
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to initialize Roadmap database: ${error}`);
    return;
  }

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
          await handleRunAgent(message.nodeId);
          break;

        case 'generateRoadmap':
          await handleGenerateRoadmap(message.prompt);
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  // Set up File Sentinel Watcher for agent completion (.agent_status.json)
  setupFileSentinelWatcher(workspaceRoot);

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
  if (activePanel && syncEngine) {
    const nodes = syncEngine.getNodes();
    activePanel.webview.postMessage({
      command: 'nodesUpdated',
      nodes: nodes,
    });
  }
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(nodeId: string) {
  if (!syncEngine || !activePanel) {
    return;
  }

  const nodes = syncEngine.getNodes();
  const node = nodes.find((n) => n.id === nodeId);

  if (!node) {
    vscode.window.showErrorMessage(`Node ${nodeId} not found`);
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
    });
  }

  terminal.show(true);

  // Build Sentinel Injection JSON
  // When command finishes, it writes execution status and node ID to `.agent_status.json` in the workspace root
  const statusFile = '.agent_status.json';
  
  // Command execution with sentinel file generation on success or fail
  // We use standard bash chain operators (command && echo success || echo failed)
  const escapedPrompt = node.agentPrompt.replace(/"/g, '\\"');
  const agentCommand = `${node.agentCli} run --task "${escapedPrompt}"`;
  
  const finalCommand = `echo '{"nodeId": "${nodeId}", "status": "Running", "command": "${node.agentCli}"}' > ${statusFile} && ` +
    `(${agentCommand}) && ` +
    `echo '{"nodeId": "${nodeId}", "status": "Completed", "command": "${node.agentCli}"}' > ${statusFile} || ` +
    `echo '{"nodeId": "${nodeId}", "status": "Failed", "command": "${node.agentCli}"}' > ${statusFile}`;

  // Log command launch to database
  syncEngine.logAgentExecution(
    nodeId,
    node.agentCli,
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
      const { nodeId, status, command } = statusData;

      if (!nodeId || !status || status === 'Running') {
        return; // Ignored states
      }

      if (syncEngine && activePanel) {
        // Update node status
        const completedAt = status === 'Completed' ? new Date().toISOString() : '';
        syncEngine.updateNode(nodeId, {
          status: status,
          completedAt: completedAt,
        });

        // Log to SQL
        syncEngine.logAgentExecution(
          nodeId,
          command || 'Unknown CLI',
          'Completed execution in terminal',
          `Sentinel captured state: ${status}`,
          status
        );

        // Notify Webview
        sendNodesToWebview();
        vscode.window.showInformationMessage(`Agent task [${nodeId}] finished with state: ${status}`);

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
 * Handles AI Generation of the Roadmap using LLM API
 */
async function handleGenerateRoadmap(prompt: string) {
  if (!syncEngine || !activePanel) {
    return;
  }

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating your project roadmap with AI...',
      cancellable: false,
    },
    async (progress) => {
      try {
        // Simulating AI delay. In real production, this integrates with the VS Code LLM/Copilot API
        // or direct Gemini API key endpoints. Let's build a mock generator that mimics a real LLM payload
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const now = new Date().toISOString();
        const customNodes: RoadmapNode[] = [
          {
            id: '1',
            title: `Kickoff: ${prompt}`,
            description: `Defining specifications and product requirements for ${prompt}.`,
            stage: 'Ideation',
            dependencies: '',
            agentCli: 'antigravity-cli',
            agentPrompt: `Generate specification document for: ${prompt}`,
            status: 'Pending',
            createdAt: now,
            completedAt: '',
          },
          {
            id: '2',
            title: 'Technical Architecture & Setup',
            description: 'Determine directory structure and initialize configuration.',
            stage: 'Architecture',
            dependencies: '1',
            agentCli: 'antigravity-cli',
            agentPrompt: `Setup standard configuration files and boilerplate folders for ${prompt}`,
            status: 'Pending',
            createdAt: now,
            completedAt: '',
          },
          {
            id: '3',
            title: 'Core Business Service Layer',
            description: 'Implement core classes and service modules.',
            stage: 'Backend',
            dependencies: '2',
            agentCli: 'antigravity-cli',
            agentPrompt: `Write core classes for: ${prompt}`,
            status: 'Pending',
            createdAt: now,
            completedAt: '',
          },
          {
            id: '4',
            title: 'UI Design Mockup & Polish',
            description: 'Create interactive screens and responsive views.',
            stage: 'Frontend',
            dependencies: '3',
            agentCli: 'cursor-cli',
            agentPrompt: `Generate index.html and style.css for client panel of ${prompt}`,
            status: 'Pending',
            createdAt: now,
            completedAt: '',
          },
          {
            id: '5',
            title: 'Testing & Integrity Checks',
            description: 'Validate input fields, test api routes, and ensure error handling.',
            stage: 'Testing',
            dependencies: '4',
            agentCli: 'research',
            agentPrompt: 'Audit code logic and run standard integrity sweeps.',
            status: 'Pending',
            createdAt: now,
            completedAt: '',
          }
        ];

        if (syncEngine) {
          syncEngine.setNodes(customNodes);
          sendNodesToWebview();
          vscode.window.showInformationMessage('AI Roadmap generated successfully!');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate roadmap: ${error}`);
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
      gap: 12px;
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

    .stage-Ideation { color: #818cf8; }
    .stage-Research { color: #f472b6; }
    .stage-Architecture { color: #fbbf24; }
    .stage-Backend { color: #34d399; }
    .stage-Frontend { color: #38bdf8; }
    .stage-Launch { color: #a78bfa; }

    .node-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
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
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <h1>🎯 Solopreneur AI Roadmap</h1>
      <div class="controls">
        <input type="text" id="ai-prompt" placeholder="Describe your solopreneur project...">
        <button id="btn-generate">Generate AI Roadmap</button>
      </div>
    </header>

    <div class="roadmap-canvas" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const btnGenerate = document.getElementById('btn-generate');
    const aiPromptInput = document.getElementById('ai-prompt');

    // Request nodes on load
    vscode.postMessage({ command: 'getNodes' });

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          renderRoadmap(message.nodes);
          break;
      }
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

    function renderRoadmap(nodes) {
      // Clear canvas keeping the flow line
      const flowLine = canvas.querySelector('.flow-line');
      canvas.innerHTML = '';
      canvas.appendChild(flowLine);

      if (nodes.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.style.color = 'var(--text-muted)';
        placeholder.style.marginTop = '40px';
        placeholder.textContent = 'No nodes generated. Describe your project above and click Generate!';
        canvas.appendChild(placeholder);
        return;
      }

      nodes.forEach(node => {
        const row = document.createElement('div');
        row.className = 'node-row';

        row.innerHTML = \`
          <div class="node-card status-\${node.status}">
            <div class="node-content">
              <div style="display: flex; gap: 8px; align-items: center;">
                <span class="node-badge stage-\${node.stage}">\${node.stage}</span>
                <span class="node-title">\${node.title}</span>
              </div>
              <div class="node-desc">\${node.description}</div>
              <div class="node-agent-prompt">
                <strong>\${node.agentCli}:</strong> \${node.agentPrompt}
              </div>
            </div>
            <div class="node-actions">
              <span class="status-badge \${node.status}">\${node.status}</span>
              <button class="btn-run" onclick="triggerRun('\${node.id}')">
                ⚡ Run Agent
              </button>
            </div>
          </div>
        \`;
        canvas.appendChild(row);
      });
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
