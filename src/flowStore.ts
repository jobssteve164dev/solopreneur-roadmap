import * as fs from 'fs';
import * as path from 'path';

export type FlowLifecycleStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_user_confirmation'
  | 'paused';

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

function getFlowsRoot(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'flows');
}

function getFlowTracePath(projectPath: string, flowId: string): string {
  return path.join(getFlowsRoot(projectPath), `${flowId}.json`);
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function ensureFlowsRoot(projectPath: string): void {
  fs.mkdirSync(getFlowsRoot(projectPath), { recursive: true });
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, filePath);
}

export function createFlowId(): string {
  return `flow-${Date.now()}`;
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

export function saveFlowTrace(projectPath: string, flow: FlowTrace): void {
  ensureFlowsRoot(projectPath);
  writeJsonAtomic(getFlowTracePath(projectPath, flow.flowId), flow);
}

export function readFlowTrace(projectPath: string, flowId: string): FlowTrace | null {
  const trace = safeReadJson<FlowTrace>(getFlowTracePath(projectPath, flowId));
  if (!trace || trace.schemaVersion !== schemaVersion || !Array.isArray(trace.loops)) {
    return null;
  }
  return trace;
}

export function listFlowTraces(projectPath: string): FlowTrace[] {
  const root = getFlowsRoot(projectPath);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root)
    .filter((file) => file.endsWith('.json'))
    .map((file) => safeReadJson<FlowTrace>(path.join(root, file)))
    .filter((trace): trace is FlowTrace => Boolean(trace && trace.schemaVersion === schemaVersion && Array.isArray(trace.loops)))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function getLatestFlowTrace(projectPath: string): FlowTrace | null {
  return listFlowTraces(projectPath)[0] || null;
}

export function buildFlowStatePayload(projectPath: string, hasProAccess: boolean): FlowStatePayload {
  const traces = listFlowTraces(projectPath);
  return {
    hasProAccess,
    flow: traces[0] || null,
    history: traces.slice(0, 8).map((trace) => ({
      flowId: trace.flowId,
      goal: trace.goal,
      status: trace.status,
      createdAt: trace.createdAt,
      updatedAt: trace.updatedAt,
      completedAt: trace.completedAt
    }))
  };
}

export function updateFlowTrace(projectPath: string, flowId: string, updater: (flow: FlowTrace) => FlowTrace): FlowTrace | null {
  const current = readFlowTrace(projectPath, flowId);
  if (!current) {
    return null;
  }
  const next = updater({
    ...current,
    loops: current.loops.map((loop) => ({
      ...loop,
      planner: { ...loop.planner },
      builder: { ...loop.builder },
      verifier: { ...loop.verifier },
      evidence: loop.evidence ? { ...loop.evidence } : undefined,
      scoring: loop.scoring ? { ...loop.scoring, reasons: [...(loop.scoring.reasons || [])] } : undefined
    }))
  });
  saveFlowTrace(projectPath, {
    ...next,
    updatedAt: new Date().toISOString()
  });
  return readFlowTrace(projectPath, flowId);
}
