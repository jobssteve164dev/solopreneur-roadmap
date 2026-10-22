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
import { migrationRunKinds, soloConversationRunKinds } from './runLifecycleTypes';

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
  launchSlotId?: string;
  launchSlotScope?: 'project' | 'global';
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
  return buildTaskReportInstructions(taskId);
}

function sharedRunnerCommand(workspaceRoot: string, globalDataPath: string, executionLogId: number): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'runAgentProcess.js'))} --global-data-path ${shellQuote(globalDataPath)} --project-path ${shellQuote(workspaceRoot)} --execution-log-id ${executionLogId}`;
}

function preparedRunResult(state: RunState, workspaceRoot: string, executionLogId: number, dataRoot: string): RunState & { dataRoot: string; finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  const reference = runStatusReference(workspaceRoot, executionLogId);
  return { ...state, dataRoot, finalCommand: sharedRunnerCommand(workspaceRoot, dataRoot, executionLogId), outputFilePath: runDataReference(reference, 'output'), changesFilePath: runDataReference(reference, 'changes'), commandFilePath: runDataReference(reference, 'command'), promptFilePath: runDataReference(reference, 'prompt'), runScriptPath: path.join(__dirname, 'runAgentProcess.js') };
}

function renderPreloadedMemoryContext(result: unknown, projectId: string): string {
  const items = Array.isArray((result as { items?: unknown[] } | undefined)?.items)
    ? (result as { items: Array<{ objectId?: string; projectId?: string | null; kind?: string; revision?: number; data?: Record<string, unknown> }> }).items
      .filter(item => item?.projectId === projectId || item?.projectId === null && ['verified', 'approved', 'active'].includes(String(item?.data?.status || '')))
      .map(item => ({ objectId: item.objectId, revision: item.revision, kind: item.kind, data: item.data }))
    : [];
  return [
    'SoloMap 数据库记忆上下文（宿主按本轮目标加载的固定版本）：',
    items.length ? JSON.stringify(items) : '本轮没有命中相关的可用记忆；继续以当前用户要求和项目证据为准。'
  ].join('\n');
}

function memoryContextTerms(...values: string[]): string[] {
  const terms = new Set<string>();
  const add = (value: string): void => { if (value.length >= 2) terms.add(value.slice(0, 80)); };
  for (const value of values) for (const segment of value.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || []) {
    if (/^[\p{Script=Han}]+$/u.test(segment) && segment.length > 4) {
      for (let width = 4; width >= 2 && terms.size < 40; width -= 1) {
        for (let index = 0; index <= segment.length - width && terms.size < 40; index += 1) add(segment.slice(index, index + width));
      }
    } else add(segment);
    if (terms.size >= 40) break;
  }
  return [...terms];
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
  let scope: { root?: string; projectId?: string; executionLogId: number } = { root: input.workspaceRoot, executionLogId: input.executionLogId };
  const intent = input.launchSlotId && input.launchSlotScope === 'global'
    ? { launchSlotId: input.launchSlotId, launchSlotScope: input.launchSlotScope, runKind: input.runKind, prompt: input.prompt, userMessage: input.userMessage }
    : (input.flowRole || input.launchIntentId || input.launchSlotId) ? { ...input, executionLogId: 0 } : input;
  const intentHash = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  let prepareKey = input.launchSlotId ? `prepare-run-slot:${input.launchSlotId}` : input.launchIntentId ? `prepare-run-intent:${input.launchIntentId}` : input.flowRole ? `prepare-flow-role:${input.flowRole.flowId}:${input.flowRole.loopId}:${input.flowRole.role}:${input.flowRole.attempt}` : `prepare-agent-run:${input.executionLogId}:${crypto.createHash('sha256').update(input.workspaceRoot).digest('hex')}`;
  const provider = getAgentProvider(input.agentCli);
  const interactive = isInteractiveConversationRunKind(input.runKind);
  const continuation = (interactive || input.runKind === 'agent_review_revision') && Boolean(input.nativeSessionId?.trim()) && (input.continuation ?? Boolean(input.directExecutionCommand));
  let codexNativeSourceOffset: number | undefined;
  if (provider === 'codex' && continuation && input.metadata?.codexResumeTranscriptPath) {
    const transcriptPath = String(input.metadata.codexResumeTranscriptPath);
    await assertCodexResumeTranscript(transcriptPath, input.workspaceRoot, String(input.nativeSessionId).trim());
    const stat = await fs.promises.stat(transcriptPath);
    if (!stat.isFile()) throw new Error('identity_transcript_unavailable');
    codexNativeSourceOffset = stat.size;
  }
  let state: RunState | undefined;
  try { if (input.launchSlotId) state = await call('read_run_slot', { root: input.workspaceRoot, launchSlotId: input.launchSlotId, launchSlotScope: input.launchSlotScope || 'project' }) as RunState | undefined;
    else if (input.launchIntentId) state = await call('read_run_intent', { root: input.workspaceRoot, launchIntentId: input.launchIntentId }) as RunState | undefined;
    else if (!input.flowRole) state = await call('read_run_state', scope) as RunState; }
  catch (error) { if ((error as Error).message !== 'run_missing') throw error; }
  if (!state) {
    const plannedNativeSessionId = continuation ? input.nativeSessionId!.trim() : interactive && ['claude', 'copilot', 'grok'].includes(provider) ? crypto.randomUUID() : '';
    const metadata = {
      ...(input.metadata || {}), launchIntentHash: intentHash, globalDataPath: input.globalDataPath, agentCli: input.agentCli, selectedModel: input.selectedModel,
      interactiveSession: interactive, sessionProvider: provider, sessionMode: continuation ? 'resume' : input.nativeSessionId ? 'fresh-with-reference' : 'fresh',
      bindingNonce: interactive ? crypto.randomBytes(32).toString('hex') : '', plannedNativeSessionId,
      previousNativeSessionId: input.nativeSessionId || '', nativeSessionId: '', nativeSessionIdIsCurrent: false,
      ...(codexNativeSourceOffset === undefined ? {} : { codexNativeSourceOffset }),
      taskCheckpointCommandPath: path.join(__dirname, 'taskCheckpointProcess.js'),
      agentLaunch: { schemaVersion: 1, agentCli: input.agentCli, selectedModel: input.selectedModel, taskPermissionMode: input.taskPermissionMode, continuation, direct: Boolean(input.directExecutionCommand), ...(input.readOnlyReview ? { readOnly: true } : {}) }
    };
    try {
      state = await call(input.flowRole ? 'prepare_flow_role' : input.launchSlotId ? 'prepare_run_slot' : input.launchIntentId ? 'prepare_run_intent' : 'prepare_run', { ...scope, ...(input.launchSlotId ? { launchSlotId: input.launchSlotId, launchSlotScope: input.launchSlotScope || 'project' } : {}), ...(input.launchIntentId ? { launchIntentId: input.launchIntentId } : {}), ...(input.flowRole || {}), ...(input.parentExecutionLogId ? { parentExecutionLogId: input.parentExecutionLogId } : {}), ...(input.expectedParentTurnId ? { expectedParentTurnId: input.expectedParentTurnId } : {}), nodeId: input.nodeId, runKind: input.runKind, prompt: input.prompt, ...(input.globalPrompt !== undefined ? { globalPrompt: input.globalPrompt } : {}), command: input.directExecutionCommand || '', userMessage: input.userMessage, status: 'Preparing', metadata, deliveryOwner: await getAgentRunDeliveryOwner(), launchRequest: input as unknown as Record<string, unknown>, idempotencyKey: prepareKey }) as RunState;
    } catch (error) {
      if (input.launchIntentId || input.launchSlotId || !['idempotency_conflict', 'execution_identity_conflict'].includes((error as Error).message)) throw error;
      state = await call('read_run_state', scope) as RunState;
    }
  }
  if (input.flowRole || input.launchIntentId || input.launchSlotId) {
    input = { ...input, executionLogId: Number(state.status.rootExecutionLogId) };
    scope = input.launchSlotId && input.launchSlotScope === 'global'
      ? { projectId: state.projectId, executionLogId: input.executionLogId }
      : { root: input.workspaceRoot, executionLogId: input.executionLogId };
  }
  if (input.launchSlotId) prepareKey = `${prepareKey}:${state.runId}`;
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
    const hasDatabaseInstructions = input.prompt.includes('SoloMap 数据库记忆系统（每个任务必须执行）：') || input.prompt.includes('SoloMap 数据库工具：');
    const migrationRun = migrationRunKinds.includes(input.runKind as typeof migrationRunKinds[number]);
    const hostLoadsReviewMemory = input.readOnlyReview === true && provider === 'grok';
    let preloadedMemoryContext = '';
    if (hostLoadsReviewMemory) {
      try {
        const terms = memoryContextTerms(input.userMessage, input.prompt.slice(0, 1200));
        const recalled = await call('context', { project: state.projectId, ...(terms.length ? { terms } : {}), budget: 6000 });
        preloadedMemoryContext = renderPreloadedMemoryContext(recalled, state.projectId);
      } catch (error) {
        preloadedMemoryContext = `SoloMap 数据库记忆上下文暂时不可用：${error instanceof Error ? error.message : String(error)}。不要改读旧记忆文件或建立平行存储；继续以当前用户要求和项目证据完成只读复核。`;
      }
    }
    const databaseInstructions = hostLoadsReviewMemory
      ? buildAgentDatabaseInstructions({ readOnly: true, contextProvided: true })
      : input.readOnlyReview || migrationRun
        ? hasDatabaseInstructions ? '' : buildAgentDatabaseInstructions({ readOnly: true })
        : hasDatabaseInstructions ? '' : buildAgentDatabaseInstructions({ migrationTools: soloConversationRunKinds.includes(input.runKind as typeof soloConversationRunKinds[number]) });
    const lifecycleInstructions = 'SoloMap 对话状态由 MCP 工具管理：收到本提示后，在处理任务前先调用 solomap_conversation_status({action:"start"})，确认当前对话已进入 Running。后续每收到一轮新的用户消息，也先调用 start，并把该轮完整原始消息放入 message。每轮交付结果时调用同一工具的 complete 动作，并提供 outcome、summary、可选 next 和 report。运行身份、版本、轮次与幂等性由插件绑定；不要运行检查点命令，也不要用通用写入工具修改对话账本。';
    const prompt = [input.prompt, lifecycleInstructions, ...(policyInstructions ? [policyInstructions] : []), ...(databaseInstructions ? [databaseInstructions] : []), ...(preloadedMemoryContext ? [preloadedMemoryContext] : []), ...(input.readOnlyReview ? [] : [reportInstructions(String(state.status.learningTaskId))])].join('\n\n');
    state = await call('patch_run_inputs', { ...identity, expectedRevision: state.revision, prompt, command, status: input.metadata?.startWaiting === true ? 'Waiting' : 'Running', idempotencyKey: `${prepareKey}:ready:${state.revision}` }) as RunState;
  }
  } catch (error) {
    if ((input.flowRole || input.launchIntentId || input.launchSlotId) && ['revision_conflict', 'idempotency_conflict'].includes((error as Error).message)) return prepareAgentRun(input, call);
    throw error;
  }
  return preparedRunResult(state, String(state.status.workspaceRoot || input.workspaceRoot), input.executionLogId, input.globalDataPath);
}
