import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import {
  classifyDiagnosticFailure,
  createLocalDiagnosticTrace,
  observeLocalDiagnosticStage,
  recordLocalDiagnosticError,
  withLocalDiagnosticTrace
} from './localDiagnostics';

// Import getPersistedSettings indirectly or using VS Code API to avoid circular dependency
function getSettings(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('solopreneur');
  const saved = context.globalState.get<any>('solopreneur.settings') || {};
  return {
    telegramEnabled: saved.telegramEnabled ?? config.get('telegramEnabled') ?? false,
    telegramBotToken: saved.telegramBotToken ?? config.get('telegramBotToken') ?? '',
    telegramChatId: saved.telegramChatId ?? config.get('telegramChatId') ?? ''
  };
}

let isPolling = false;
let pollingTimeout: NodeJS.Timeout | null = null;
let currentOffset = 0;
let currentToken = '';
let currentChatId = '';
let pollingGeneration = 0;
let currentChatReply: ((chatId: string, text: string) => Promise<string>) | undefined;
let currentDiagnosticDataPath = '';
const pendingChatReplies = new Map<string, Promise<void>>();
const pendingAuthRequests = new Map<string, number>(); // chat_id -> date

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      first_name?: string;
      username?: string;
    };
    date: number;
    text?: string;
  };
}

// Mock system for offline automation tests
export const mockTelegramUpdates: TelegramUpdate[] = [];
export const mockTelegramSentMessages: { chatId: string; text: string }[] = [];
export const mockTelegramChatActions: { chatId: string; action: string }[] = [];
export const mockTelegramApiFailures = { sendMessage: 0 };

/**
 * Sends a raw API request to Telegram Bot API.
 */
export async function callTelegramApi(token: string, method: string, payload: any, deadlineMs?: number): Promise<any> {
  if (process.env.SOLOMAP_MOCK_TELEGRAM === 'true') {
    if (method === 'sendMessage') {
      if (mockTelegramApiFailures.sendMessage > 0) {
        mockTelegramApiFailures.sendMessage--;
        throw new Error('Mock Telegram send failed');
      }
      mockTelegramSentMessages.push({ chatId: String(payload.chat_id), text: payload.text });
    } else if (method === 'sendChatAction') {
      mockTelegramChatActions.push({ chatId: String(payload.chat_id), action: String(payload.action) });
    }
    return { ok: true, result: {} };
  }

  if (!token) {
    throw new Error('Telegram Bot Token is empty');
  }

  const timeoutMs = deadlineMs ?? (method === 'getUpdates' ? 40_000 : method === 'sendChatAction' ? 5_000 : 35_000);
  const postData = JSON.stringify(payload);
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: timeoutMs
  };

  return new Promise((resolve, reject) => {
    let deadlineTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let phase = 'while awaiting socket';
    let socketAssigned = false;
    const timeoutError = () => new Error(`Telegram ${method} timed out ${phase} (${socketAssigned ? (req.reusedSocket ? 'reused' : 'new') : 'unassigned'} socket)`);
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.request(options, (res) => {
      phase = 'while receiving response';
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('error', (error) => finish(error));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            finish(undefined, parsed);
          } else {
            finish(new Error(`Telegram ${method} HTTP ${res.statusCode || 'unknown'}: ${parsed.description || 'API returned error'}`));
          }
        } catch (e) {
          finish(new Error(`Telegram ${method} returned an invalid response (HTTP ${res.statusCode || 'unknown'}, ${Buffer.byteLength(data)} bytes).`));
        }
      });
    });

    req.on('error', (err) => {
      finish(err);
    });

    req.on('socket', () => {
      socketAssigned = true;
      phase = 'before request write completed';
    });
    req.on('finish', () => { if (phase !== 'while receiving response') phase = 'while awaiting response'; });

    req.on('timeout', () => {
      finish(timeoutError());
      req.destroy();
    });

    deadlineTimer = setTimeout(() => {
      finish(timeoutError());
      req.destroy();
    }, timeoutMs);
    req.write(postData);
    req.end();
  });
}

/**
 * Sends message to configured Telegram chat.
 */
export async function sendTelegramNotification(context: vscode.ExtensionContext, text: string): Promise<void> {
  const settings = getSettings(context);
  if (!settings.telegramEnabled || !settings.telegramBotToken || !settings.telegramChatId) {
    return;
  }
  try {
    await callTelegramApi(settings.telegramBotToken, 'sendMessage', {
      chat_id: settings.telegramChatId,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.warn('Failed to send Telegram notification:', error);
    if (currentDiagnosticDataPath) recordLocalDiagnosticError(currentDiagnosticDataPath, 'telegram.notification', classifyDiagnosticFailure(error));
  }
}

/**
 * Starts long polling for Telegram updates.
 */
export function startTelegramRemoteService(context: vscode.ExtensionContext, chatReply?: (chatId: string, text: string) => Promise<string>, diagnosticDataPath = ''): void {
  const settings = getSettings(context);
  if (!settings.telegramEnabled || !settings.telegramBotToken) {
    stopTelegramRemoteService();
    return;
  }

  if (isPolling && currentToken === settings.telegramBotToken && currentChatId === settings.telegramChatId) {
    currentChatReply = chatReply;
    currentDiagnosticDataPath = diagnosticDataPath;
    return;
  }

  const previousToken = currentToken;
  const previousOffset = currentOffset;
  stopTelegramRemoteService();

  isPolling = true;
  currentToken = settings.telegramBotToken;
  currentChatId = settings.telegramChatId;
  currentOffset = previousToken === currentToken ? previousOffset : 0;
  currentChatReply = chatReply;
  currentDiagnosticDataPath = diagnosticDataPath;
  const generation = ++pollingGeneration;

  console.log('Telegram Remote Control Service started.');
  void pollUpdates(context, generation);
}

/**
 * Stops the Telegram updates service.
 */
export function stopTelegramRemoteService(): void {
  pollingGeneration++;
  pendingChatReplies.clear();
  pendingAuthRequests.clear();
  isPolling = false;
  currentToken = '';
  currentChatId = '';
  currentChatReply = undefined;
  currentDiagnosticDataPath = '';
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
}

/**
 * Restarts Telegram service.
 */
export function restartTelegramRemoteService(context: vscode.ExtensionContext, chatReply?: (chatId: string, text: string) => Promise<string>, diagnosticDataPath = ''): void {
  startTelegramRemoteService(context, chatReply, diagnosticDataPath);
}

/**
 * Long Polling loop for updates.
 */
async function pollUpdates(context: vscode.ExtensionContext, generation: number): Promise<void> {
  if (!isPolling || generation !== pollingGeneration) {
    return;
  }

  // Handle Mockupdates first in offline tests
  if (process.env.SOLOMAP_MOCK_TELEGRAM === 'true') {
    if (mockTelegramUpdates.length > 0) {
      const updatesToProcess = [...mockTelegramUpdates];
      mockTelegramUpdates.length = 0;
      for (const update of updatesToProcess) {
        if (generation !== pollingGeneration) return;
        await handleTelegramUpdate(context, update);
      }
    }
    if (generation === pollingGeneration) pollingTimeout = setTimeout(() => pollUpdates(context, generation), 50);
    return;
  }

  const pollStartedAt = Date.now();
  try {
    const payload: any = {
      timeout: 30,
      allowed_updates: ['message']
    };
    if (currentOffset > 0) {
      payload.offset = currentOffset;
    }

    const response = await callTelegramApi(currentToken, 'getUpdates', payload);
    if (generation !== pollingGeneration) return;
    if (response && response.result && Array.isArray(response.result)) {
      for (const update of response.result) {
        if (generation !== pollingGeneration) return;
        currentOffset = Math.max(currentOffset, update.update_id + 1);
        await handleTelegramUpdate(context, update, Date.now() - pollStartedAt);
      }
    }
    
    // Normal loop continuation
    if (isPolling && generation === pollingGeneration) {
      pollingTimeout = setTimeout(() => pollUpdates(context, generation), 100);
    }
  } catch (error) {
    console.warn('Error in Telegram polling loop:', error);
    if (currentDiagnosticDataPath) {
      recordLocalDiagnosticError(currentDiagnosticDataPath, 'telegram.poll', error);
      createLocalDiagnosticTrace(currentDiagnosticDataPath, 'telegram.poll').record('telegram.poll', 'error', Date.now() - pollStartedAt, error);
    }
    // Wait longer if error occurred to prevent high frequency crash
    if (isPolling && generation === pollingGeneration) {
      pollingTimeout = setTimeout(() => pollUpdates(context, generation), classifyDiagnosticFailure(error) === 'timeout' ? 1_000 : 5_000);
    }
  }
}

/**
 * Processes a single Telegram message update.
 */
async function handleTelegramUpdate(context: vscode.ExtensionContext, update: TelegramUpdate, pollDurationMs = 0): Promise<void> {
  const message = update.message;
  if (!message || !message.text) {
    return;
  }

  const senderChatId = String(message.chat.id);
  const generation = pollingGeneration;
  const text = message.text.trim();
  const settings = getSettings(context);

  // If chatId is not set yet, enable dynamic authorization binding
  if (!settings.telegramChatId) {
    if (pendingAuthRequests.has(senderChatId)) {
      return; // Already waiting for user response
    }
    pendingAuthRequests.set(senderChatId, generation);
    const username = message.from.username ? `@${message.from.username}` : message.from.first_name || 'Unknown User';
    
    const approve = 'Approve / 授权';
    const deny = 'Deny / 拒绝';
    
    const choice = await vscode.window.showWarningMessage(
      `检测到 Telegram 账号 ${username} (Chat ID: ${senderChatId}) 申请绑定控制权限，是否授权此设备控制您的本地电脑？`,
      approve,
      deny
    );

    if (generation !== pollingGeneration || pendingAuthRequests.get(senderChatId) !== generation) return;
    pendingAuthRequests.delete(senderChatId);

    if (choice === approve) {
      // Save Chat ID to VS Code configuration and globalState
      const config = vscode.workspace.getConfiguration('solopreneur');
      await config.update('telegramChatId', senderChatId, vscode.ConfigurationTarget.Global);
      const saved = context.globalState.get<any>('solopreneur.settings') || {};
      await context.globalState.update('solopreneur.settings', {
        ...saved,
        telegramChatId: senderChatId
      });
      // Broadcast settings
      await vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
      
      // Reply to TG user
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: senderChatId,
        text: '🎉 <b>绑定成功！</b>\n现在可以直接发消息询问智能内核。输入 /help 查看其他指令。',
        parse_mode: 'HTML'
      });
    } else {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: senderChatId,
        text: '❌ <b>授权已被拒绝。</b>\n您无权访问此本地电脑。',
        parse_mode: 'HTML'
      });
    }
    return;
  }

  // If chat ID is set but does not match, reject
  if (senderChatId !== settings.telegramChatId) {
    await callTelegramApi(currentToken, 'sendMessage', {
      chat_id: senderChatId,
      text: '❌ <b>无访问权限。</b>\n该本地电脑已有绑定的管理员账户。',
      parse_mode: 'HTML'
    });
    return;
  }

  // Process authorized command
  try {
    await dispatchTelegramCommand(context, senderChatId, text, message.date, pollDurationMs);
  } catch (err) {
    console.error('Failed to dispatch TG command:', err);
    if (currentDiagnosticDataPath) recordLocalDiagnosticError(currentDiagnosticDataPath, 'telegram.command', classifyDiagnosticFailure(err));
    await callTelegramApi(currentToken, 'sendMessage', {
      chat_id: senderChatId,
      text: `⚠️ 执行失败：${err instanceof Error ? err.message : String(err)}`,
      parse_mode: 'HTML'
    });
  }
}

/**
 * Dispatches the received command.
 */
async function dispatchTelegramCommand(context: vscode.ExtensionContext, chatId: string, text: string, messageDate?: number, pollDurationMs = 0): Promise<void> {
  const lowercase = text.toLowerCase();
  if (!text.startsWith('/') && lowercase !== 'approve' && lowercase !== 'deny' && currentChatReply) {
    const reply = currentChatReply;
    const token = currentToken;
    const generation = pollingGeneration;
    const previous = pendingChatReplies.get(chatId) || Promise.resolve();
    const startedAt = Date.now();
    const diagnosticDataPath = currentDiagnosticDataPath;
    const trace = diagnosticDataPath ? createLocalDiagnosticTrace(diagnosticDataPath, 'telegram.chat') : null;
    if (trace) {
      trace.record('telegram.poll', 'ok', pollDurationMs);
      const deliveredAt = Number(messageDate || 0) * 1000;
      trace.record('telegram.receive', 'ok', deliveredAt > 0 && deliveredAt <= startedAt ? startedAt - deliveredAt : 0);
      trace.record('telegram.queue', 'start');
    }
    const task = previous.catch(() => undefined).then(() => {
      const execute = async () => {
        trace?.record('telegram.queue', 'ok', Date.now() - startedAt);
        const canReply = () => isPolling && pollingGeneration === generation && currentToken === token && getSettings(context).telegramChatId === chatId;
        let typingObserved = false;
        let typingInFlight = false;
        const showTyping = () => {
          if (canReply() && !typingInFlight) {
            typingInFlight = true;
            void callTelegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).then(() => {
              if (!typingObserved) trace?.record('telegram.typing', 'ok');
              typingObserved = true;
            }).catch(error => {
              if (!typingObserved) trace?.record('telegram.typing', 'error', 0, error);
              if (!typingObserved && diagnosticDataPath) recordLocalDiagnosticError(diagnosticDataPath, 'telegram.typing', error);
              typingObserved = true;
            }).finally(() => {
              typingInFlight = false;
            });
          }
        };
        const typingTimer = setTimeout(showTyping, 250);
        const typingInterval = setInterval(showTyping, 4_000);
        typingTimer.unref();
        typingInterval.unref();
        try {
          const answer = await observeLocalDiagnosticStage('telegram.model', () => reply(chatId, text));
          if (canReply()) {
            await observeLocalDiagnosticStage('telegram.send', () => callTelegramApi(token, 'sendMessage', { chat_id: chatId, text: answer }));
            trace?.record('telegram.chat', 'ok', Date.now() - startedAt);
          } else {
            trace?.record('telegram.chat', 'cancel', Date.now() - startedAt);
          }
        } catch (error) {
          trace?.record('telegram.chat', 'error', Date.now() - startedAt, error);
          if (diagnosticDataPath) recordLocalDiagnosticError(diagnosticDataPath, 'telegram.chat', classifyDiagnosticFailure(error));
          if (canReply()) {
            try {
              await observeLocalDiagnosticStage('telegram.send_failure', () => callTelegramApi(token, 'sendMessage', {
                chat_id: chatId,
                text: `智能内核暂时无法回答：${error instanceof Error ? error.message : String(error)}`
              }));
            } catch (sendError) {
              console.warn('Failed to send Telegram intelligence reply:', sendError);
            }
          }
        } finally {
          clearTimeout(typingTimer);
          clearInterval(typingInterval);
        }
      };
      return trace ? withLocalDiagnosticTrace(trace, execute) : execute();
    });
    pendingChatReplies.set(chatId, task);
    void task.finally(() => {
      if (pendingChatReplies.get(chatId) === task) pendingChatReplies.delete(chatId);
    }).catch(error => console.warn('Telegram intelligence reply failed:', error));
    return;
  }
  
  if (lowercase === '/start' || lowercase === '/help') {
    const welcome = `🤖 <b>SoloMap 远程智能体驾驶舱</b>

可用远程指令：
• 💬 直接发送消息 - 询问智能内核
• 📊 <code>/status</code> - 查询当前项目状态与路线图进度
• 🚀 <code>/run &lt;环节ID&gt;</code> - 远程触发执行指定的路线图环节 (例如: <code>/run 12</code>)
• 🛑 <code>/stop</code> - 强制终止当前正在运行的 Agent 任务终端
• 🆗 <code>/approve</code> - 人在回路确认：批准完成当前进行中/复核环节
• 🚫 <code>/deny</code> - 人在回路确认：拒绝并终止当前步骤`;
    
    await callTelegramApi(currentToken, 'sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'HTML'
    });
    return;
  }

  if (lowercase === '/status') {
    const projectInfo = await vscode.commands.executeCommand('solopreneur.internalGetStatus') as any;
    if (!projectInfo || !projectInfo.activeProject) {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: chatId,
        text: '📭 <b>当前未选择/打开任何本地项目。</b>\n请在 VS Code 中先选定工作项目。',
        parse_mode: 'HTML'
      });
      return;
    }

    const { name, path: pPath, progressPercent, currentStep, currentStepStatus, recentExecutions } = projectInfo;
    const historyText = recentExecutions && recentExecutions.length > 0
      ? recentExecutions.map((log: any) => `• [${log.status === 'Completed' ? '✅' : log.status === 'Failed' ? '❌' : '⏳'}] 环节 ${log.nodeId}: ${log.agentCli} (${log.finishedAt ? new Date(log.finishedAt).toLocaleTimeString() : '进行中'})\n  决策: <i>${log.completionReason || log.failureReason || '-'}</i>`).join('\n\n')
      : '暂无最近执行记录';

    const reply = `📁 <b>当前项目：</b> ${name}
📍 <b>项目路径：</b> <code>${pPath}</code>
📊 <b>路线图总进度：</b> ${progressPercent}%

⏳ <b>当前推进环节：</b> [${currentStepStatus}] <code>${currentStep}</code>

📜 <b>最近推进记录：</b>
${historyText}`;

    await callTelegramApi(currentToken, 'sendMessage', {
      chat_id: chatId,
      text: reply,
      parse_mode: 'HTML'
    });
    return;
  }

  if (lowercase.startsWith('/run ')) {
    const parts = text.split(/\s+/);
    const nodeId = parts[1]?.trim();
    if (!nodeId) {
      throw new Error('请输入要运行的环节ID，例如: /run 12');
    }

    await callTelegramApi(currentToken, 'sendMessage', {
      chat_id: chatId,
      text: `⏳ <b>正在启动本地 Agent 执行环节 ${nodeId}...</b>`,
      parse_mode: 'HTML'
    });

    // Invoke command via VS Code
    await vscode.commands.executeCommand('solopreneur.internalRunAgent', nodeId);
    return;
  }

  if (lowercase === '/stop') {
    const stopped = await vscode.commands.executeCommand('solopreneur.internalStopAgent') as boolean;
    if (stopped) {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: chatId,
        text: '🛑 <b>已成功终止本地正在运行的 Agent 终端。</b>',
        parse_mode: 'HTML'
      });
    } else {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: chatId,
        text: 'ℹ️ <b>当前没有正在运行的 Agent 任务终端。</b>',
        parse_mode: 'HTML'
      });
    }
    return;
  }

  if (lowercase === '/approve' || lowercase === 'approve') {
    const projectInfo = await vscode.commands.executeCommand('solopreneur.internalGetStatus') as any;
    if (!projectInfo || !projectInfo.activeNodeId) {
      throw new Error('当前没有处于进行中或待复核的路线图环节。');
    }
    const success = await vscode.commands.executeCommand('solopreneur.internalApproveNode', projectInfo.activeNodeId);
    if (success) {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: chatId,
        text: `✅ <b>已远程批准完成环节 ${projectInfo.activeNodeId}。</b>\n状态已更新为 Completed。`,
        parse_mode: 'HTML'
      });
    } else {
      throw new Error('批准操作失败。');
    }
    return;
  }

  if (lowercase === '/deny' || lowercase === 'deny') {
    const projectInfo = await vscode.commands.executeCommand('solopreneur.internalGetStatus') as any;
    if (!projectInfo || !projectInfo.activeNodeId) {
      throw new Error('当前没有处于进行中或待复核的路线图环节。');
    }
    const success = await vscode.commands.executeCommand('solopreneur.internalDenyNode', projectInfo.activeNodeId);
    if (success) {
      await callTelegramApi(currentToken, 'sendMessage', {
        chat_id: chatId,
        text: `🚫 <b>已远程拒绝环节 ${projectInfo.activeNodeId}，终端执行已被终止。</b>\n状态已更新为 Failed。`,
        parse_mode: 'HTML'
      });
    } else {
      throw new Error('拒绝操作失败。');
    }
    return;
  }

  // Fallback for unrecognized commands
  await callTelegramApi(currentToken, 'sendMessage', {
    chat_id: chatId,
    text: '❓ <b>未识别的远程命令。</b>\n输入 /help 查看可用指令列表。',
    parse_mode: 'HTML'
  });
}
