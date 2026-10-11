import { buildAgentCommandForPromptFile, buildInteractiveAgentCommandForPromptFile, buildInteractiveAgentContinuationCommandForPromptFile, buildReadOnlyAgentCommandForPromptFile, buildAgentContinuationCommandForPromptFile, getAgentProvider, shellQuote } from './agentCli';
import * as path from 'path';

export interface DatabaseAgentLaunch {
  schemaVersion: number;
  agentCli: string;
  selectedModel: string;
  taskPermissionMode: string;
  continuation: boolean;
  direct: boolean;
  readOnly?: boolean;
}

export function buildDatabaseAgentCommand(launch: DatabaseAgentLaunch, runId: string, revision: number, workspaceRoot: string, interactive: boolean, sessionId = '', bindingNonce = ''): string {
  if (launch.schemaVersion !== 1 || !launch.agentCli || !/^[0-9a-f-]{36}$/.test(runId) || !Number.isInteger(revision) || revision < 1) throw new Error('run_agent_launch_invalid');
  if (launch.readOnly) {
    const command = buildReadOnlyAgentCommandForPromptFile(launch.agentCli, '{{SOLOMAP_REVIEW_INPUT}}', workspaceRoot, launch.selectedModel);
    if (!command) throw new Error('reviewer_read_only_mode_unsupported');
    return command;
  }
  const read = JSON.stringify({ ref: runId, revision, view: 'content', field: 'prompt_content' });
  const instruction = `Read the complete SoloMap task prompt using the solomap_data MCP tool solomap_read with ${read}. Keep reading every base64 data page with its cursor until cursor=null; join all decoded bytes before decoding the complete UTF-8 text. Follow the complete prompt exactly; its user request has highest priority. ${interactive ? 'Stay in this interactive session after completing the current turn.' : 'Do not answer this wrapper sentence.'}${bindingNonce ? ` SoloMap binding nonce: ${bindingNonce}.` : ''}`;
  if (launch.continuation && !interactive) return getAgentProvider(launch.agentCli) === 'codex'
    ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'runCodexContinuation.js'))}`
    : buildAgentContinuationCommandForPromptFile(launch.agentCli, '', workspaceRoot, sessionId, launch.taskPermissionMode, launch.selectedModel, instruction);
  return launch.continuation
    ? buildInteractiveAgentContinuationCommandForPromptFile(launch.agentCli, '', workspaceRoot, sessionId, launch.taskPermissionMode, launch.selectedModel, instruction)
    : interactive ? buildInteractiveAgentCommandForPromptFile(launch.agentCli, '', workspaceRoot, launch.taskPermissionMode, launch.selectedModel, sessionId, bindingNonce, instruction)
      : buildAgentCommandForPromptFile(launch.agentCli, '', workspaceRoot, launch.taskPermissionMode, launch.selectedModel, sessionId, instruction);
}
