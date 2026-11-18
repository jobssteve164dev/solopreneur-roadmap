import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { getAgentProvider, shellQuote } from './agentCli';
import { assertCodexResumeTranscript } from './codexSessionIdentity';
import { buildDatabaseAgentCommand, DatabaseAgentLaunch } from './agentDatabaseLaunch';
import { agentDatabaseConfigPath, buildAgentDatabaseInstructions, codexDatabaseProfileName } from './agentDatabaseConfig';
import { buildTaskReportInstructions } from './taskReport';
import { isInteractiveConversationRunKind, resolveAgentInputMode } from './taskCheckpoint';
import type { SessionIdentityContract, SessionIdentityMethod } from './sessionIdentity';
import type { RunState } from './runLifecycleTypes';
import type { FlowTrace } from './flowStore';
import { runStatusReference, runDataReference } from './runLifecycleClient';
import { readWindowsProcessBirthMarkerAsync } from './processIdentity.js';
import { migrationRunKinds, soloConversationRunKinds } from './runLifecycleTypes';
import { createInteractionBudget, currentInteractionBudget, InteractionBudget } from './interactionBudget';

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
  interactionBudget?: InteractionBudget;
  deliveryOwner?: { id: string; pid: number; birth: string };
  flowRole?: { flowId: string; loopId: string; role: 'planner' | 'builder' | 'verifier'; attempt: number; initialFlow?: FlowTrace };
}

type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
export interface AgentRunPreparationPreflight {
  codexTranscript?: { path: string; workspaceRoot: string; nativeSessionId: string; size: number };
}
const deliveryOwnerId = crypto.randomUUID();

export async function preflightAgentRunPreparation(input: AgentRunPreparationInput): Promise<AgentRunPreparationPreflight> {
  const provider = getAgentProvider(input.agentCli);
  const interactive = isInteractiveConversationRunKind(input.runKind);
  const continuation = (interactive || input.runKind === 'agent_review_revision') && Boolean(input.nativeSessionId?.trim())
    && (input.continuation ?? Boolean(input.directExecutionCommand));
  if (provider !== 'codex' || !continuation || !input.metadata?.codexResumeTranscriptPath) return {};
  const transcriptPath = String(input.metadata.codexResumeTranscriptPath);
  const nativeSessionId = String(input.nativeSessionId).trim();
  await assertCodexResumeTranscript(transcriptPath, input.workspaceRoot, nativeSessionId);
  const stat = await fs.promises.stat(transcriptPath);
  if (!stat.isFile()) throw new Error('identity_transcript_unavailable');
  return { codexTranscript: { path: transcriptPath, workspaceRoot: input.workspaceRoot, nativeSessionId, size: stat.size } };
}

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

export function identityPolicy(provider: string): { method: SessionIdentityMethod; contract: SessionIdentityContract } {
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

export function preparedRunResult(state: RunState, workspaceRoot: string, executionLogId: number, dataRoot: string): RunState & { dataRoot: string; finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string } {
  const reference = runStatusReference(workspaceRoot, executionLogId);
  return { ...state, dataRoot, finalCommand: sharedRunnerCommand(workspaceRoot, dataRoot, executionLogId), outputFilePath: runDataReference(reference, 'output'), changesFilePath: runDataReference(reference, 'changes'), commandFilePath: runDataReference(reference, 'command'), promptFilePath: runDataReference(reference, 'prompt'), runScriptPath: path.join(__dirname, 'runAgentProcess.js') };
}

export function renderPreloadedMemoryContext(result: unknown, projectId: string): string {
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

export function memoryContextTerms(...values: string[]): string[] {
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

export async function resumePreparedAgentRun(state: RunState, operation: Operation, dataRoot?: string,
  deliveryOwner?: { id: string; pid: number; birth: string }): Promise<Awaited<ReturnType<typeof prepareAgentRun>>> {
  return operation('prepare_agent_launch', { resumeRun: { projectId: state.projectId, runId: state.runId, executionLogId: Number(state.status.rootExecutionLogId) },
    ...(state.status.deliveryPending ? { preparationOwner: deliveryOwner || await getAgentRunDeliveryOwner() } : {}),
    providerContext: defaultAgentRunProviderContext(String(state.status.agentCli || '')),
    ...(currentInteractionBudget()?{interactionBudget:currentInteractionBudget()}:{}), ...(dataRoot?{globalDataPath:dataRoot}:{}) }) as Promise<Awaited<ReturnType<typeof prepareAgentRun>>>;
}

export function describeAgentRunMode(input:AgentRunPreparationInput) {
  const provider = getAgentProvider(input.agentCli);
  const interactive = isInteractiveConversationRunKind(input.runKind);
  const sessionReentry = input.metadata?.agentInputMode === 'session_reentry';
  if (sessionReentry && (!interactive || !input.nativeSessionId?.trim() || !input.directExecutionCommand
    || input.prompt.trim() || input.userMessage.trim())) throw new Error('agent_input_mode_invalid');
  const agentInputMode = resolveAgentInputMode(input.runKind, sessionReentry);
  const continuation = (interactive || input.runKind === 'agent_review_revision') && Boolean(input.nativeSessionId?.trim()) && (input.continuation ?? Boolean(input.directExecutionCommand));
  return {provider,interactive,sessionReentry,agentInputMode,continuation};
}

export function describeAgentRunIntent(input:AgentRunPreparationInput) {
  const mode=describeAgentRunMode(input);
  const interactionBudget = input.interactionBudget || currentInteractionBudget() || createInteractionBudget();
  input = { ...input, interactionBudget };
  if (input.globalPrompt === undefined && Object.prototype.hasOwnProperty.call(input, 'globalPrompt')) {
    input = { ...input };
    delete input.globalPrompt;
  }
  // The data root is delivery routing, not user intent. A queued launch can be
  // reclaimed from its physical owner after the saved root changes without
  // becoming a different conversation request.
  const { interactionBudget: _interactionBudget, globalDataPath: _globalDataPath, deliveryOwner: _deliveryOwner, ...stableIntentInput } = input;
  const intent = input.launchSlotId && input.launchSlotScope === 'global'
    ? { launchSlotId: input.launchSlotId, launchSlotScope: input.launchSlotScope, runKind: input.runKind, prompt: input.prompt, userMessage: input.userMessage }
    : (input.flowRole || input.launchIntentId || input.launchSlotId) ? { ...stableIntentInput, executionLogId: 0 } : stableIntentInput;
  const intentHash = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const prepareKey = input.launchSlotId ? `prepare-run-slot:${input.launchSlotId}` : input.launchIntentId ? `prepare-run-intent:${input.launchIntentId}` : input.flowRole ? `prepare-flow-role:${input.flowRole.flowId}:${input.flowRole.loopId}:${input.flowRole.role}:${input.flowRole.attempt}` : `prepare-agent-run:${input.executionLogId}:${crypto.createHash('sha256').update(input.workspaceRoot).digest('hex')}`;
  return {input,...mode,interactionBudget,intentHash,prepareKey};
}

export function buildAgentRunInitialMetadata(intent:ReturnType<typeof describeAgentRunIntent>,codexNativeSourceOffset?:number):Record<string,unknown> {
  const {input,provider,interactive,agentInputMode,interactionBudget,intentHash,continuation}=intent;
  const plannedNativeSessionId = continuation ? input.nativeSessionId!.trim() : interactive && ['claude', 'copilot', 'grok'].includes(provider) ? crypto.randomUUID() : '';
  const metadata = {
    ...(input.metadata || {}), agentInputMode, interactionBudget, interactionId: interactionBudget.interactionId,
    launchIntentHash: intentHash, globalDataPath: input.globalDataPath, agentCli: input.agentCli, selectedModel: input.selectedModel,
    interactiveSession: interactive, sessionProvider: provider, sessionMode: continuation ? 'resume' : input.nativeSessionId ? 'fresh-with-reference' : 'fresh',
    bindingNonce: interactive ? crypto.randomBytes(32).toString('hex') : '', plannedNativeSessionId,
    previousNativeSessionId: input.nativeSessionId || '', nativeSessionId: '', nativeSessionIdIsCurrent: false,
    ...(codexNativeSourceOffset === undefined ? {} : { codexNativeSourceOffset }),
    taskCheckpointCommandPath: path.join(__dirname, 'taskCheckpointProcess.js'),
    agentLaunch: { schemaVersion: 1, agentCli: input.agentCli, selectedModel: input.selectedModel, taskPermissionMode: input.taskPermissionMode, continuation, direct: Boolean(input.directExecutionCommand),
      ...(provider === 'codex' ? { codexProfile: codexDatabaseProfileName(input.globalDataPath) } : {}),
      ...(input.readOnlyReview ? { readOnly: true } : {}) }
  };
  return metadata;
}

export function defaultAgentRunProviderContext(agentCli:string):Record<string,unknown>|undefined {
  const provider=getAgentProvider(agentCli);
  if(provider==='codex')return {codex:{codexHome:path.resolve(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'))}};
  if(provider==='claude')return {claude:{claudeHome:path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude')).normalize('NFC'),configDirOverride:process.env.CLAUDE_CONFIG_DIR?path.resolve(process.env.CLAUDE_CONFIG_DIR):null,configPath:agentDatabaseConfigPath('claude')}};
  return undefined;
}
export function buildAgentRunBindingSeed(input:AgentRunPreparationInput,state:RunState,providerContext=defaultAgentRunProviderContext(input.agentCli)) {
  const provider=getAgentProvider(input.agentCli);
  return { runId: String(input.executionLogId), provider, workspaceRoot: input.workspaceRoot, cliPath: input.agentCli, bindingNonce: String(state.status.bindingNonce), createdAt: state.status.startedAt, ...identityPolicy(provider), ...(input.metadata?.nativeResumeProviderContext?{providerContext:input.metadata.nativeResumeProviderContext}:providerContext?{providerContext}:{}) };
}

export function renderAgentRunPolicyInstructions(policyRef:{objectId:string;revision:number},policy:{objectId:string;kind:string;projectId:string|null;revision:number;data:Record<string,unknown>},readOnlyReview?:boolean):string {
  if (policy.objectId !== policyRef.objectId || policy.revision !== policyRef.revision || policy.kind !== 'policy' || policy.projectId !== null || policy.data.kind !== 'global_prompt' || typeof policy.data.content !== 'string') throw new Error('run_global_prompt_policy_mismatch');
  return [`用户全局要求（本轮固定版本 ${JSON.stringify(policyRef)}）：`, policy.data.content, '与本轮用户最新要求冲突时，以本轮用户要求为准。', ...(readOnlyReview ? [] : ['后续每轮 start 返回 globalPromptPolicyRef；有引用时，通过 solomap_read 读取该 objectId 和 revision 的全文，保留固定版本，不用最新版本代替。'])].join('\n');
}

export function buildAgentRunCommand(input:AgentRunPreparationInput,state:RunState):string {
  const provider=getAgentProvider(input.agentCli),interactive=isInteractiveConversationRunKind(input.runKind),plannedSessionId=String(state.status.plannedNativeSessionId || '');
  return input.directExecutionCommand || buildDatabaseAgentCommand(state.status.agentLaunch as DatabaseAgentLaunch, state.runId, state.revision + 1, String(state.status.maintenanceWorkspaceRoot || input.workspaceRoot), interactive, plannedSessionId, provider === 'codex' ? String(state.status.bindingNonce) : '');
}

export function buildAgentRunPrompt(input:AgentRunPreparationInput,state:RunState,policyInstructions:string,preloadedMemoryContext:string):string {
  const provider=getAgentProvider(input.agentCli),sessionReentry=input.metadata?.agentInputMode==='session_reentry',interactionBudget=input.interactionBudget!;
  const hasDatabaseInstructions = input.prompt.includes('SoloMap 数据库记忆系统（每个任务必须执行）：') || input.prompt.includes('SoloMap 数据库工具：');
  const migrationRun = migrationRunKinds.includes(input.runKind as typeof migrationRunKinds[number]);
  const hostLoadsReviewMemory = input.readOnlyReview === true && provider === 'grok';
  const databaseInstructions = sessionReentry ? '' : hostLoadsReviewMemory
    ? buildAgentDatabaseInstructions({ readOnly: true, contextProvided: true })
    : input.readOnlyReview || migrationRun
      ? hasDatabaseInstructions ? '' : buildAgentDatabaseInstructions({ readOnly: true })
      : hasDatabaseInstructions ? '' : buildAgentDatabaseInstructions({ migrationTools: soloConversationRunKinds.includes(input.runKind as typeof soloConversationRunKinds[number]) });
  const lifecycleInstructions = `SoloMap 对话状态由 MCP 工具管理：收到本提示后，在处理任务前先调用 solomap_conversation_status({action:"start",turnId:"${state.turnId}",interactionId:"${interactionBudget.interactionId}"})，确认当前对话已进入 Running。后续每收到一轮新的用户消息，也使用该轮提示给出的 turnId 与 interactionId 调用 start，并把该轮完整原始消息放入 message。每轮交付结果时调用 solomap_conversation_status({action:"complete",turnId:"${state.turnId}",interactionId:"${interactionBudget.interactionId}",outcome:"...",summary:"..."})，并提供可选 next 和 report。运行身份、版本和幂等性由插件绑定；不要运行检查点命令，也不要用通用写入工具修改对话账本。`;
  const prompt = sessionReentry ? '' : [input.prompt, lifecycleInstructions, ...(policyInstructions ? [policyInstructions] : []), ...(databaseInstructions ? [databaseInstructions] : []), ...(preloadedMemoryContext ? [preloadedMemoryContext] : []), ...(input.readOnlyReview ? [] : [reportInstructions(String(state.status.learningTaskId))])].join('\n\n');
  return prompt;
}

export async function prepareAgentRun(input: AgentRunPreparationInput, operation?: Operation, _preflight: AgentRunPreparationPreflight = {}): Promise<RunState & { dataRoot: string; finalCommand: string; outputFilePath: string; changesFilePath: string; commandFilePath: string; promptFilePath: string; runScriptPath: string }> {
  const call: Operation = operation || ((name, data) => sendRuntimeDataRequest(input.globalDataPath, { operation: name, input: data }));
  const budget=input.interactionBudget || currentInteractionBudget();
  return call('prepare_agent_launch', { ...input, ...(budget?{interactionBudget:budget}:{}), resumeSavedIntent:false,
    preparationOwner:input.deliveryOwner || await getAgentRunDeliveryOwner(), providerContext:defaultAgentRunProviderContext(input.agentCli) }) as Promise<Awaited<ReturnType<typeof prepareAgentRun>>>;
}
