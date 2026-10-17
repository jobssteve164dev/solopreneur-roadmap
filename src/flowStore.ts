import * as crypto from 'crypto';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import type { FlowSnapshot } from './db/unifiedDataStore';

export type FlowLifecycleStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_user_confirmation'
  | 'paused'
  | 'abandoned';

export type FlowLoopStatus =
  | 'created'
  | 'planned'
  | 'building'
  | 'evidence_collected'
  | 'verifying'
  | 'closed'
  | 'planning_incomplete'
  | 'no_effect'
  | 'implemented_unverified'
  | 'verified_failed'
  | 'partial'
  | 'deviated'
  | 'needs_review'
  | 'spawned_followup'
  | 'needs_user_confirmation'
  | 'abandoned';

export type FlowRole = 'planner' | 'builder' | 'verifier';

export interface FlowRoleExecution {
  status: 'pending' | 'running' | 'completed' | 'failed';
  executionLogId?: number;
  startedAt?: string;
  finishedAt?: string;
  command?: string;
  outputTail?: string;
  validationErrors?: string[];
  data?: Record<string, any>;
  retryCount?: number;
}

export interface FlowLoopEvidence {
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  commandFilePath: string;
  outputFilePath: string;
  changesFilePath: string;
  touchedFilesPath: string;
}

export interface FlowLoopScoring {
  hardEvidencePass: boolean;
  intentPass: boolean;
  judgmentPass: boolean;
  recommendedStatus: FlowLoopStatus;
  reasons: string[];
}

export interface FlowLoopTrace {
  loopId: string;
  index: number;
  goal: string;
  status: FlowLoopStatus;
  createdAt: string;
  updatedAt: string;
  planner: FlowRoleExecution;
  builder: FlowRoleExecution;
  verifier: FlowRoleExecution;
  evidence?: FlowLoopEvidence;
  scoring?: FlowLoopScoring;
  summary?: string;
}

export interface FlowTrace {
  schemaVersion: 1;
  flowId: string;
  projectPath: string;
  goal: string;
  status: FlowLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  source: {
    type: 'goal';
    userInput: string;
    roadmapStepId?: string;
    supplementFiles?: string[];
    selectedAgentCli?: string;
    selectedModel?: string;
  };
  currentLoopIndex: number;
  loops: FlowLoopTrace[];
  latestSummary?: string;
}

export interface FlowStatePayload {
  hasProAccess: boolean;
  flow: FlowTrace | null;
  history: Array<{
    flowId: string;
    goal: string;
    status: FlowLifecycleStatus;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
  }>;
}

const schemaVersion = 1;
type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;

function flowOperation(projectPath: string, globalDataPath: string, operation?: Operation): Operation {
  return operation || ((name, input) => sendRuntimeDataRequest(normalizeGlobalDataPathForExtension(globalDataPath, projectPath), { operation: name, input }));
}

export function createFlowId(): string {
  return `flow-${Date.now()}-${crypto.randomUUID()}`;
}

export function createFlowTrace(
  projectPath: string,
  goal: string,
  input: {
    roadmapStepId?: string;
    supplementFiles?: string[];
    selectedAgentCli?: string;
    selectedModel?: string;
  } = {}
): FlowTrace {
  const now = new Date().toISOString();
  return {
    schemaVersion,
    flowId: createFlowId(),
    projectPath,
    goal,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    source: {
      type: 'goal',
      userInput: goal,
      ...(input.roadmapStepId ? { roadmapStepId: input.roadmapStepId } : {}),
      ...(Array.isArray(input.supplementFiles) && input.supplementFiles.length ? { supplementFiles: input.supplementFiles } : {}),
      ...(input.selectedAgentCli ? { selectedAgentCli: input.selectedAgentCli } : {}),
      ...(input.selectedModel ? { selectedModel: input.selectedModel } : {})
    },
    currentLoopIndex: 1,
    loops: [],
    latestSummary: ''
  };
}

export function matchesFlowLaunchIntent(
  flow: FlowTrace,
  goal: string,
  input: { supplementFiles?: string[]; selectedAgentCli?: string; selectedModel?: string } = {}
): boolean {
  const expectedFiles = Array.isArray(input.supplementFiles) ? input.supplementFiles : [];
  const actualFiles = Array.isArray(flow.source.supplementFiles) ? flow.source.supplementFiles : [];
  return flow.goal === goal
    && flow.source.userInput === goal
    && String(flow.source.selectedAgentCli || '') === String(input.selectedAgentCli || '')
    && String(flow.source.selectedModel || '') === String(input.selectedModel || '')
    && actualFiles.length === expectedFiles.length
    && actualFiles.every((file, index) => file === expectedFiles[index]);
}

export function createFlowLoop(goal: string, index: number): FlowLoopTrace {
  const now = new Date().toISOString();
  return {
    loopId: `loop-${index}`,
    index,
    goal,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    planner: { status: 'pending' },
    builder: { status: 'pending' },
    verifier: { status: 'pending' }
  };
}

export async function saveFlowTrace(projectPath: string, flow: FlowTrace, globalDataPath = '', operation?: Operation): Promise<void> {
  const call = flowOperation(projectPath, globalDataPath, operation);
  const value = JSON.parse(JSON.stringify(flow)) as FlowTrace;
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await call('write_flow_trace', { root: projectPath, flow: value, expectedRevision: 0, idempotencyKey: `flow:${value.flowId}:create:${hash}` });
}

export async function readFlowTrace(projectPath: string, flowId: string, globalDataPath = '', operation?: Operation): Promise<FlowTrace | null> {
  const snapshot = await flowOperation(projectPath, globalDataPath, operation)('read_flow_trace', { root: projectPath, flowId }) as FlowSnapshot | null;
  return snapshot?.flow || null;
}

async function listFlowHeaders(projectPath: string, globalDataPath: string, operation?: Operation): Promise<Array<Omit<FlowTrace, 'loops'>>> {
  const call = flowOperation(projectPath, globalDataPath, operation);
  const items: Array<Omit<FlowTrace, 'loops'>> = []; let cursor: number | null = 0;
  do {
    const page = await call('list_flow_traces', { root: projectPath, cursor, limit: 100 }) as { items: Array<{ flow: Omit<FlowTrace, 'loops'> }>; nextCursor: number | null };
    items.push(...page.items.map(item => item.flow)); cursor = page.nextCursor;
  } while (cursor !== null);
  return items.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export async function listFlowTraces(projectPath: string, globalDataPath = '', operation?: Operation): Promise<FlowTrace[]> {
  const result: FlowTrace[] = [];
  for (const header of await listFlowHeaders(projectPath, globalDataPath, operation)) {
    const trace = await readFlowTrace(projectPath, header.flowId, globalDataPath, operation);
    if (trace) result.push(trace);
  }
  return result;
}

export async function getLatestFlowTrace(projectPath: string, globalDataPath = '', operation?: Operation): Promise<FlowTrace | null> {
  const header = (await listFlowHeaders(projectPath, globalDataPath, operation))[0];
  return header ? readFlowTrace(projectPath, header.flowId, globalDataPath, operation) : null;
}

export async function buildFlowStatePayload(projectPath: string, hasProAccess: boolean, globalDataPath = '', operation?: Operation): Promise<FlowStatePayload> {
  const headers = await listFlowHeaders(projectPath, globalDataPath, operation);
  return { hasProAccess, flow: headers[0] ? await readFlowTrace(projectPath, headers[0].flowId, globalDataPath, operation) : null,
    history: headers.slice(0, 8).map(trace => ({ flowId: trace.flowId, goal: trace.goal, status: trace.status, createdAt: trace.createdAt, updatedAt: trace.updatedAt, ...(trace.completedAt ? { completedAt: trace.completedAt } : {}) })) };
}

export async function updateFlowTrace(projectPath: string, flowId: string, updater: (flow: FlowTrace) => FlowTrace, globalDataPath = '', operation?: Operation): Promise<FlowTrace | null> {
  const call = flowOperation(projectPath, globalDataPath, operation);
  for (;;) {
    const current = await call('read_flow_trace', { root: projectPath, flowId }) as FlowSnapshot | null;
    if (!current) return null;
    const next = JSON.parse(JSON.stringify(updater(structuredClone(current.flow)))) as FlowTrace;
    next.updatedAt = new Date().toISOString();
    const hash = crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex');
    try {
      const saved = await call('write_flow_trace', { root: projectPath, flow: next, expectedRevision: current.revision, idempotencyKey: `flow:${flowId}:${current.revision}:update:${hash}` }) as FlowSnapshot;
      return saved.flow;
    } catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
  }
}
