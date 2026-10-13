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

export function buildDatabaseAgentCommand(launch: DatabaseAgentLaunch, runId: string, revision: number, workspaceRoot: string, interactive: boolean, sessionId = '', bindingNonce = '', claudeObserver = false): string {
  const command = buildUnobservedDatabaseAgentCommand(launch, runId, revision, workspaceRoot, interactive, sessionId, bindingNonce);
  if (!claudeObserver || launch.readOnly || getAgentProvider(launch.agentCli) !== 'claude') return command;
  const executable = `${shellQuote(launch.agentCli)} `;
  const offset = command.indexOf(executable);
  if (offset < 0) throw new Error('run_agent_launch_invalid');
  return command.slice(0, offset) + executable + `--plugin-dir ${shellQuote(path.resolve(__dirname, '../resources/claude-observer'))} ` + command.slice(offset + executable.length);
}

function buildUnobservedDatabaseAgentCommand(launch: DatabaseAgentLaunch, runId: string, revision: number, workspaceRoot: string, interactive: boolean, sessionId = '', bindingNonce = ''): string {
  if (launch.schemaVersion !== 1 || !launch.agentCli || !/^[0-9a-f-]{36}$/.test(runId) || !Number.isInteger(revision) || revision < 1) throw new Error('run_agent_launch_invalid');
  if (launch.readOnly) {
    const command = buildReadOnlyAgentCommandForPromptFile(launch.agentCli, '{{SOLOMAP_REVIEW_INPUT}}', workspaceRoot, launch.selectedModel);
    if (!command) throw new Error('reviewer_read_only_mode_unsupported');
    return command;
  }
  const read = JSON.stringify({ ref: runId, revision, view: 'full' });
  const instruction = `Read the complete SoloMap task prompt in one call using the solomap_data MCP tool solomap_read with ${read}, then follow data.prompt_content exactly; its user request has highest priority. ${interactive ? 'Stay in this interactive session after completing the current turn.' : 'Do not answer this wrapper sentence.'}${bindingNonce ? ` SoloMap binding nonce: ${bindingNonce}.` : ''}`;
  if (launch.continuation && !interactive) return getAgentProvider(launch.agentCli) === 'codex'
    ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'runCodexContinuation.js'))}`
    : buildAgentContinuationCommandForPromptFile(launch.agentCli, '', workspaceRoot, sessionId, launch.taskPermissionMode, launch.selectedModel, instruction);
  return launch.continuation
    ? buildInteractiveAgentContinuationCommandForPromptFile(launch.agentCli, '', workspaceRoot, sessionId, launch.taskPermissionMode, launch.selectedModel, instruction)
    : interactive ? buildInteractiveAgentCommandForPromptFile(launch.agentCli, '', workspaceRoot, launch.taskPermissionMode, launch.selectedModel, sessionId, bindingNonce, instruction)
      : buildAgentCommandForPromptFile(launch.agentCli, '', workspaceRoot, launch.taskPermissionMode, launch.selectedModel, sessionId, instruction);
}
