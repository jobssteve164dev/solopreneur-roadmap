import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { getAgentProvider, shellQuote } from './agentCli';
import { assertCodexResumeTranscript } from './codexSessionIdentity';
import { buildDatabaseAgentCommand, DatabaseAgentLaunch } from './agentDatabaseLaunch';
import { agentDatabaseConfigPath, buildAgentDatabaseInstructions } from './agentDatabaseConfig';
import { buildTaskReportInstructions } from './taskReport';
import { isInteractiveConversationRunKind } from './taskCheckpoint';
import type { NativeSessionBinding, SessionIdentityContract, SessionIdentityMethod } from './sessionIdentity';
import type { RunState } from './runLifecycleTypes';
import type { FlowTrace } from './flowStore';
import { runStatusReference, runDataReference } from './runLifecycleClient';
import { readWindowsProcessBirthMarkerAsync } from './processIdentity.js';

export interface AgentRunPreparationInput {
  agentCli: string;
  selectedModel: string;
  prompt: string;
  globalPrompt?: string;
  workspaceRoot: string;
  nodeId: string;
  executionLogId: number;
  userMessage: string;
  runKind: string;
  globalDataPath: string;
  taskPermissionMode: string;
  nativeSessionId?: string;
  continuation?: boolean;
  directExecutionCommand?: string;
  parentExecutionLogId?: number;
  expectedParentTurnId?: string;
  metadata?: Record<string, unknown>;
  launchIntentId?: string;
  readOnlyReview?: boolean;
  reviewEvidence?: Record<string, unknown>;
  flowRole?: { flowId: string; loopId: string; role: 'planner' | 'builder' | 'verifier'; attempt: number; initialFlow?: FlowTrace };
}

type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
const deliveryOwnerId = crypto.randomUUID();

export async function getAgentRunDeliveryOwner(): Promise<{ id: string; pid: number; birth: string }> {
  if (process.platform === 'win32') return { id: deliveryOwnerId, pid: process.pid, birth: await readWindowsProcessBirthMarkerAsync(process.pid) };
  let birth = '';
  try {
    const stat = await fs.promises.readFile(`/proc/${process.pid}/stat`, 'utf8');
    birth = `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
  } catch {
    birth = await new Promise<string>(resolve => execFile('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }, (error, output) => resolve(!error && output.trim() ? `ps:${output.trim()}` : '')));
  }
  return { id: deliveryOwnerId, pid: process.pid, birth };
}

function identityPolicy(provider: string): { method: SessionIdentityMethod; contract: SessionIdentityContract } {
  if (['claude', 'copilot', 'grok'].includes(provider)) return { method: 'caller_assigned', contract: 'official_stable' };
  if (['cursor', 'opencode'].includes(provider)) return { method: 'provider_created', contract: 'official_stable' };
  if (provider === 'antigravity') return { method: 'provider_callback', contract: 'official_stable' };
  return { method: 'transcript_correlated_compat', contract: 'compatibility' };
}

function reportInstructions(taskId: string): string {
  return buildTaskReportInstructions(taskId, '{{SOLOMAP_REPORT_JSON}}', true).split('\n').map(line => {
    if (line.startsWith('- 在 {{SOLOMAP_REPORT_JSON}}')) return '- 本轮汇报使用严格 JSON：schemaVersion=1，summary 为本轮结果，其余字段为数组：unmetRequirements、decisions、corrections、verification、commits、experienceUsage、lessons。没有内容用 []，不制造经验或提交。';
    if (line.startsWith('- 保存报告后、结算前')) return `- 提交前，在 Node 中加载 ${JSON.stringify(path.join(__dirname, 'taskReport.js'))}，调用 validateTaskReport(报告对象, 当前项目绝对路径) 预检；校验失败先精简原稿并重检。`;
    if (line.startsWith('- 沿原有 complete')) return '- 沿原有 complete 命令结算，并附加 --report-json 参数，传入上述 JSON 的完整文本；报告问题不阻断原任务。不要为报告额外结算，也不需要生成内部报告文件。';
    return line;
  }).join('\n');
}

function sharedRunnerCommand(workspaceRoot: string, globalDataPath: string, executionLogId: number): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'runAgentProcess.js'))} --global-data-path ${shellQuote(globalDataPath)} --project-path ${shellQuote(workspaceRoot)} --execution-log-id ${executionLogId}`;
}

function preparedRunResult(state: RunState, workspaceRoot: string, executionLogId: number, dataRoot: string): RunState & { dataRoot: string; finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  const reference = runStatusReference(workspaceRoot, executionLogId);
  return { ...state, dataRoot, finalCommand: sharedRunnerCommand(workspaceRoot, dataRoot, executionLogId), outputFilePath: runDataReference(reference, 'output'), changesFilePath: runDataReference(reference, 'changes'), commandFilePath: runDataReference(reference, 'command'), promptFilePath: runDataReference(reference, 'prompt'), runScriptPath: path.join(__dirname, 'runAgentProcess.js') };
}

export async function resumePreparedAgentRun(state: RunState, operation: Operation, dataRoot?: string): Promise<Awaited<ReturnType<typeof prepareAgentRun>>> {
  const executionLogId = Number(state.status.rootExecutionLogId);
  const document = await operation('read_run_document', { projectId: state.projectId, executionLogId, purpose: 'launch_request' }) as { bytes: string } | null;
  if (!document) throw new Error('run_launch_request_missing');
  const input = JSON.parse(Buffer.from(document.bytes, 'base64').toString('utf8')) as AgentRunPreparationInput;
  if (input.executionLogId !== executionLogId || input.workspaceRoot !== state.status.workspaceRoot || input.nodeId !== state.status.nodeId) throw new Error('run_launch_request_identity_mismatch');
  if (!state.status.deliveryPending) return preparedRunResult(state, input.workspaceRoot, executionLogId, dataRoot || input.globalDataPath);
  const owner = await getAgentRunDeliveryOwner();
  const claimed = await operation('claim_run_delivery', { projectId: state.projectId, executionLogId, generation: state.generation, expectedRevision: state.revision, owner, idempotencyKey: `run:${state.runId}:${state.generation}:resume-delivery:${owner.id}:${state.revision}` }) as RunState;
  try {
    const prepared = await prepareAgentRun(input, operation);
    if (prepared.runId !== claimed.runId || prepared.taskId !== claimed.taskId || prepared.turnId !== claimed.turnId || prepared.generation !== claimed.generation) throw new Error('run_delivery_identity_changed');
    return dataRoot ? { ...prepared, dataRoot, finalCommand: sharedRunnerCommand(input.workspaceRoot, dataRoot, executionLogId) } : prepared;
  } catch (error) {
    if (state.status.deliveryPending) await operation('release_run_delivery', { projectId: state.projectId, executionLogId, generation: claimed.generation, owner, error: error instanceof Error ? error.message : String(error), idempotencyKey: `run:${claimed.runId}:${claimed.generation}:release-preparation:${claimed.revision}` });
    throw error;
  }
}

export async function prepareAgentRun(input: AgentRunPreparationInput, operation?: Operation): Promise<RunState & { dataRoot: string; finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string }> {
  if (input.globalPrompt === undefined && Object.prototype.hasOwnProperty.call(input, 'globalPrompt')) {
    input = { ...input };
    delete input.globalPrompt;
  }
  const call: Operation = operation || ((name, data) => sendRuntimeDataRequest(input.globalDataPath, { operation: name, input: data }));
  const scope = { root: input.workspaceRoot, executionLogId: input.executionLogId };
  const intentHash = crypto.createHash('sha256').update(JSON.stringify((input.flowRole || input.launchIntentId) ? { ...input, executionLogId: 0 } : input)).digest('hex');
  const prepareKey = input.launchIntentId ? `prepare-run-intent:${input.launchIntentId}` : input.flowRole ? `prepare-flow-role:${input.flowRole.flowId}:${input.flowRole.loopId}:${input.flowRole.role}:${input.flowRole.attempt}` : `prepare-agent-run:${input.executionLogId}:${crypto.createHash('sha256').update(input.workspaceRoot).digest('hex')}`;
  const provider = getAgentProvider(input.agentCli);
  const interactive = isInteractiveConversationRunKind(input.runKind);
  const continuation = (interactive || input.runKind === 'agent_review_revision') && Boolean(input.nativeSessionId?.trim()) && (input.continuation ?? Boolean(input.directExecutionCommand));
  if (provider === 'codex' && continuation && input.metadata?.codexResumeTranscriptPath) {
    await assertCodexResumeTranscript(String(input.metadata.codexResumeTranscriptPath), input.workspaceRoot, String(input.nativeSessionId).trim());
  }
  let state: RunState | undefined;
  try { if (input.launchIntentId) state = await call('read_run_intent', { root: input.workspaceRoot, launchIntentId: input.launchIntentId }) as RunState | undefined;
    else if (!input.flowRole) state = await call('read_run_state', scope) as RunState; }
  catch (error) { if ((error as Error).message !== 'run_missing') throw error; }
  if (!state) {
    const plannedNativeSessionId = continuation ? input.nativeSessionId!.trim() : interactive && ['claude', 'copilot', 'grok'].includes(provider) ? crypto.randomUUID() : '';
    const metadata = {
      ...(input.metadata || {}), launchIntentHash: intentHash, globalDataPath: input.globalDataPath, agentCli: input.agentCli, selectedModel: input.selectedModel,
      interactiveSession: interactive, sessionProvider: provider, sessionMode: continuation ? 'resume' : input.nativeSessionId ? 'fresh-with-reference' : 'fresh',
      bindingNonce: interactive ? crypto.randomBytes(32).toString('hex') : '', plannedNativeSessionId,
      previousNativeSessionId: input.nativeSessionId || '', nativeSessionId: '', nativeSessionIdIsCurrent: false,
      taskCheckpointCommandPath: path.join(__dirname, 'taskCheckpointProcess.js'),
      agentLaunch: { schemaVersion: 1, agentCli: input.agentCli, selectedModel: input.selectedModel, taskPermissionMode: input.taskPermissionMode, continuation, direct: Boolean(input.directExecutionCommand), ...(input.readOnlyReview ? { readOnly: true } : {}) }
    };
    try {
      state = await call(input.flowRole ? 'prepare_flow_role' : input.launchIntentId ? 'prepare_run_intent' : 'prepare_run', { ...scope, ...(input.launchIntentId ? { launchIntentId: input.launchIntentId } : {}), ...(input.flowRole || {}), ...(input.parentExecutionLogId ? { parentExecutionLogId: input.parentExecutionLogId } : {}), ...(input.expectedParentTurnId ? { expectedParentTurnId: input.expectedParentTurnId } : {}), nodeId: input.nodeId, runKind: input.runKind, prompt: input.prompt, ...(input.globalPrompt !== undefined ? { globalPrompt: input.globalPrompt } : {}), command: input.directExecutionCommand || '', userMessage: input.userMessage, status: 'Preparing', metadata, deliveryOwner: await getAgentRunDeliveryOwner(), launchRequest: input as unknown as Record<string, unknown>, idempotencyKey: prepareKey }) as RunState;
    } catch (error) {
      if (input.launchIntentId || !['idempotency_conflict', 'execution_identity_conflict'].includes((error as Error).message)) throw error;
      state = await call('read_run_state', scope) as RunState;
    }
  }
  if (input.flowRole || input.launchIntentId) { input = { ...input, executionLogId: Number(state.status.rootExecutionLogId) }; scope.executionLogId = input.executionLogId; }
  if (state.status.launchIntentHash !== intentHash) throw new Error('execution_identity_conflict');
  const identity = { projectId: state.projectId, ...scope, generation: state.generation };
  try {
  if (String(state.status.status) === 'Preparing') {
    let binding = await call('read_run_binding', identity) as NativeSessionBinding | null;
    if ((interactive || continuation) && !binding) binding = await call('write_run_binding', {
      ...identity, expectedHeadRevision: 0, seed: { runId: String(input.executionLogId), provider, workspaceRoot: input.workspaceRoot, cliPath: input.agentCli, bindingNonce: String(state.status.bindingNonce), createdAt: state.status.startedAt, ...identityPolicy(provider), ...(input.metadata?.nativeResumeProviderContext ? { providerContext: input.metadata.nativeResumeProviderContext } : provider === 'codex' ? { providerContext: { codex: { codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) } } } : provider === 'claude' ? { providerContext: { claude: { claudeHome: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC'), configDirOverride: process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null, configPath: agentDatabaseConfigPath('claude') } } } : {}) }, idempotencyKey: `${prepareKey}:binding`
    }) as NativeSessionBinding;
    const plannedSessionId = String(state.status.plannedNativeSessionId || '');
    if (binding && binding.headRevision === 1 && plannedSessionId) binding = await call('write_run_binding', {
      ...identity, expectedHeadRevision: 1, revision: { sessionId: plannedSessionId, ...identityPolicy(provider), state: 'planned', createdAt: state.status.startedAt, ...(binding.revisions[binding.headRevision - 1].providerContext ? { providerContext: binding.revisions[binding.headRevision - 1].providerContext } : {}), evidence: { source: continuation ? 'confirmed_resume_target' : 'official_cli_parameter' } }, idempotencyKey: `${prepareKey}:planned-session`
    }) as NativeSessionBinding;
    let nativeSessionIdIsCurrent = false;
    const transcriptPath = String(input.metadata?.codexResumeTranscriptPath || '');
    if (binding && provider === 'codex' && continuation && transcriptPath && binding.headRevision === 2) {
      const stat = await fs.promises.stat(transcriptPath);
      if (!stat.isFile()) throw new Error('identity_transcript_unavailable');
      binding = await call('write_run_binding', { ...identity, expectedHeadRevision: 2, confirmSessionId: plannedSessionId, evidence: { source: 'confirmed_resume_target', transcriptPath: path.resolve(transcriptPath) }, idempotencyKey: `${prepareKey}:confirmed-session` }) as NativeSessionBinding;
      nativeSessionIdIsCurrent = true;
    }
    state = await call('read_run_state', scope) as RunState;
    state = await call('patch_run_state', { ...identity, expectedRevision: state.revision, patch: { sessionBindingHeadRevision: binding?.headRevision || 0, nativeSessionId: nativeSessionIdIsCurrent ? plannedSessionId : '', nativeSessionIdIsCurrent }, idempotencyKey: `${prepareKey}:identity-state:${state.revision}` }) as RunState;
    const command = input.directExecutionCommand || buildDatabaseAgentCommand(state.status.agentLaunch as DatabaseAgentLaunch, state.runId, state.revision + 1, String(state.status.maintenanceWorkspaceRoot || input.workspaceRoot), interactive, plannedSessionId, provider === 'codex' ? String(state.status.bindingNonce) : '');
    const policyRef = state.status.globalPromptPolicyRef as { objectId: string; revision: number } | null;
    let policyInstructions = '';
    if (policyRef) {
      const policy = await call('read', { ref: policyRef.objectId, revision: policyRef.revision }) as { objectId: string; kind: string; projectId: string | null; revision: number; data: Record<string, unknown> };
      if (policy.objectId !== policyRef.objectId || policy.revision !== policyRef.revision || policy.kind !== 'policy' || policy.projectId !== null || policy.data.kind !== 'global_prompt' || typeof policy.data.content !== 'string') throw new Error('run_global_prompt_policy_mismatch');
      policyInstructions = [`用户全局要求（本轮固定版本 ${JSON.stringify(policyRef)}）：`, policy.data.content, '与本轮用户最新要求冲突时，以本轮用户要求为准。', ...(input.readOnlyReview ? [] : ['后续每轮 start 返回 globalPromptPolicyRef；有引用时，通过 solomap_read 读取该 objectId 和 revision 的全文，保留固定版本，不用最新版本代替。'])].join('\n');
    }
    const prompt = [input.prompt, ...(policyInstructions ? [policyInstructions] : []), ...(input.readOnlyReview ? [] : [...(input.prompt.includes('SoloMap 数据库工具：') ? [] : [buildAgentDatabaseInstructions()]), `SoloMap 检查点命令：${path.join(__dirname, 'taskCheckpointProcess.js')}。通过 node "$SOLOMAP_TASK_COMMAND" 调用当前任务的 start、complete 和 session-close。初轮 complete 使用 --turn-id ${state.turnId}；后续 start 的 --turn-id 先使用上一轮 turnId，保留返回的新 turnId，并在对应 complete 的 --turn-id 中使用它。每轮结算绑定自己的 turnId，重试沿用原 turnId。`, reportInstructions(String(state.status.learningTaskId))])].join('\n\n');
    state = await call('patch_run_inputs', { ...identity, expectedRevision: state.revision, prompt, command, status: input.metadata?.startWaiting === true ? 'Waiting' : 'Running', idempotencyKey: `${prepareKey}:ready:${state.revision}` }) as RunState;
  }
  } catch (error) {
    if ((input.flowRole || input.launchIntentId) && ['revision_conflict', 'idempotency_conflict'].includes((error as Error).message)) return prepareAgentRun(input, call);
    throw error;
  }
  return preparedRunResult(state, input.workspaceRoot, input.executionLogId, input.globalDataPath);
}
