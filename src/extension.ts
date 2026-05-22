import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { SyncEngine } from './db/syncEngine';
import { RoadmapNode } from './db/types';
import { SolopreneurSidebarProvider } from './sidebarProvider';

let syncEngine: SyncEngine | null = null;
let activePanel: vscode.WebviewPanel | null = null;
let watcher: vscode.FileSystemWatcher | null = null;
let sidebarProvider: SolopreneurSidebarProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Solopreneur Roadmaps extension is now active!');

  // Try early initialization if workspace is open
  await ensureSyncEngine(context);

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
      }
      if (activePanel) {
        const config = vscode.workspace.getConfiguration('solopreneur');
        activePanel.webview.postMessage({
          command: 'settingsLoaded',
          settings: {
            apiProvider: config.get('apiProvider') || 'Gemini',
            apiKey: config.get('apiKey') || '',
            cliPath: config.get('cliPath') || 'antigravity-cli'
          }
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
        await handleRunAgent(nodeId);
      }
    },
    async (prompt) => {
      const ready = await ensureSyncEngine(context);
      if (ready) {
        await handleGenerateRoadmap(prompt);
      }
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SolopreneurSidebarProvider.viewType,
      sidebarProvider
    )
  );
}

/**
 * Ensures the sync engine is initialized if a workspace is open.
 */
async function ensureSyncEngine(context: vscode.ExtensionContext): Promise<boolean> {
  if (syncEngine) {
    return true;
  }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return false;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const solopreneurDir = path.join(workspaceRoot, '.solopreneur');

  if (!fs.existsSync(solopreneurDir)) {
    fs.mkdirSync(solopreneurDir, { recursive: true });
  }

  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');

  syncEngine = new SyncEngine(csvPath, dbPath, context.extensionPath);
  try {
    await syncEngine.initAndSync();
    setupFileSentinelWatcher(workspaceRoot);
    // Refresh sidebar when successfully initialized
    if (sidebarProvider) {
      sidebarProvider.sendNodesToWebview();
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
    vscode.window.showErrorMessage('Please open a workspace/folder before launching the Roadmap!');
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

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

        case 'getSettings':
          if (activePanel) {
            const config = vscode.workspace.getConfiguration('solopreneur');
            activePanel.webview.postMessage({
              command: 'settingsLoaded',
              settings: {
                apiProvider: config.get('apiProvider') || 'Gemini',
                apiKey: config.get('apiKey') || '',
                cliPath: config.get('cliPath') || 'antigravity-cli'
              }
            });
          }
          break;

        case 'updateSettings':
          const config = vscode.workspace.getConfiguration('solopreneur');
          await config.update('apiProvider', message.apiProvider, vscode.ConfigurationTarget.Global);
          await config.update('apiKey', message.apiKey, vscode.ConfigurationTarget.Global);
          await config.update('cliPath', message.cliPath, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Solopreneur settings saved successfully!');
          // Broadcast to sync both Webviews
          vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
          break;

        case 'testCli':
          const exec = require('child_process').exec;
          exec(`${message.cliPath} --version`, (error: any, stdout: string, stderr: string) => {
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

function buildAgentCommand(agentCli: string, agentPrompt: string, workspaceRoot: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPrompt = shellQuote(agentPrompt);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `${quotedCli} exec -C ${shellQuote(workspaceRoot)} ${quotedPrompt}`;
  }

  return `${quotedCli} run --task ${quotedPrompt}`;
}

/**
 * Executes a CLI agent in the integrated terminal.
 */
async function handleRunAgent(nodeId: string) {
  if (!syncEngine) {
    return;
  }

  const nodes = syncEngine.getNodes();
  const node = nodes.find((n) => n.id === nodeId);

  if (!node) {
    vscode.window.showErrorMessage(`Node ${nodeId} not found`);
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Please open a workspace/folder before running an Agent task.');
    return;
  }

  // Resolve CLI path from config if applicable
  const config = vscode.workspace.getConfiguration('solopreneur');
  const configuredCliPath = config.get<string>('cliPath') || 'antigravity-cli';

  // Use configured CLI path if the node specifies the default antigravity-cli/codex-cli
  let agentCli = node.agentCli;
  if (agentCli === 'antigravity-cli' || agentCli === 'codex-cli') {
    agentCli = configuredCliPath;
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

  // Build Sentinel Injection JSON
  // When command finishes, it writes execution status and node ID to `.agent_status.json` in the workspace root
  const statusFilePath = path.join(workspaceRoot, '.agent_status.json');

  // Command execution with sentinel file generation on success or fail
  const agentCommand = buildAgentCommand(agentCli, node.agentPrompt, workspaceRoot);
  const runningStatus = JSON.stringify({ nodeId, status: 'Running', command: agentCli });
  const completedStatus = JSON.stringify({ nodeId, status: 'Completed', command: agentCli });
  const failedStatus = JSON.stringify({ nodeId, status: 'Failed', command: agentCli });
  const quotedStatusFile = shellQuote(statusFilePath);

  const finalCommand = `printf %s ${shellQuote(runningStatus)} > ${quotedStatusFile} && ` +
    `(${agentCommand}); status=$?; ` +
    `if [ $status -eq 0 ]; then ` +
    `printf %s ${shellQuote(completedStatus)} > ${quotedStatusFile}; ` +
    `else printf %s ${shellQuote(failedStatus)} > ${quotedStatusFile}; fi`;

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
      const { nodeId, status, command } = statusData;

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
async function handleGenerateRoadmap(prompt: string) {
  if (!syncEngine) {
    return;
  }

  const config = vscode.workspace.getConfiguration('solopreneur');
  const apiProvider = config.get<string>('apiProvider') || 'Gemini';
  const apiKey = config.get<string>('apiKey') || '';
  const cliPath = config.get<string>('cliPath') || 'antigravity-cli';

  if (apiProvider !== 'VS Code Copilot (Native)' && !apiKey) {
    vscode.window.showErrorMessage(`API Key is missing for ${apiProvider}. Please open settings (⚙️) and enter your API Key!`);
    return;
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
        vscode.window.showErrorMessage(`Failed to generate roadmap: ${error.message || error}`);
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
      <h1>🎯 Solopreneur AI Roadmap</h1>
      <div class="controls">
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
      <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Required for standalone providers (Gemini or OpenAI). Not needed for VS Code Copilot (Native).
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title">CLI Command or Path</label>
      <input type="text" class="settings-input" id="setting-clipath" placeholder="e.g. antigravity-cli">
      <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>antigravity-cli</code> or <code>codex-cli</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli">⚡ Test CLI</button>
      <button class="settings-action-btn save-btn" id="btn-save-settings">💾 Save</button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const btnGenerate = document.getElementById('btn-generate');
    const aiPromptInput = document.getElementById('ai-prompt');

    // Settings Panel elements
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

    // Request nodes and settings on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          renderRoadmap(message.nodes);
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

    // Save configurations
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

    // Test CLI path
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

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');

        row.innerHTML = \`
          <div class="node-card status-\${node.status}">
            <div class="node-content">
              <div style="display: flex; gap: 8px; align-items: center;">
                <span class="node-badge stage-\${cleanStage}">\${node.stage}</span>
                <span class="node-title">\${node.title}</span>
              </div>
              <div class="node-desc">\${node.description}</div>
              <div class="node-agent-prompt">
                <strong>\${node.agentCli}:</strong> \${node.agentPrompt}
              </div>
            </div>
            <div class="node-actions">
              <span class="status-badge \${node.status}">\${node.status}</span>
              <button class="btn-run" data-run-node-id="\${node.id}">
                ⚡ Run Agent
              </button>
            </div>
          </div>
        \`;
        const runButton = row.querySelector('[data-run-node-id]');
        if (runButton) {
          runButton.addEventListener('click', () => {
            triggerRun(node.id);
          });
        }
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
