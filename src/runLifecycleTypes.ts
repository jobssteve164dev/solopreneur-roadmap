import type { WriteReceipt } from './db/unifiedDataStore';
import type { WorkspaceSnapshot, RunGitEvidence } from './runWorkspace';
import type { DocumentationAuditResult } from './documentationManifest';
import type { FlowTrace } from './flowStore';

export const maintenanceRunKinds = ['skill_install', 'mcp_install', 'enhancement_install', 'enhancement_uninstall', 'agent_cli_upgrade'];

export interface PrepareRunInput {
  root: string;
  executionLogId: number;
  parentExecutionLogId?: number;
  expectedParentTurnId?: string;
  nodeId: string;
  runKind: string;
  prompt: string;
  globalPrompt?: string;
  command: string;
  userMessage: string;
  status?: string;
  metadata?: Record<string, unknown>;
  deliveryOwner?: { id: string; pid: number; birth: string };
  launchRequest?: Record<string, unknown>;
  roadmapBackup?: string;
  idempotencyKey: string;
}

export interface RunState {
  projectId: string;
  runId: string;
  taskId: string;
  turnId: string;
  conversationId: string;
  generation: number;
  revision: number;
  status: Record<string, unknown>;
  receipt?: WriteReceipt;
  proof?: string;
}

export interface RunCheckpointInput {
  executionLogId: number;
  generation: number;
  proof: string;
  expectedRevision: number;
  expectedTurnId?: string;
  action: 'start' | 'complete' | 'session-close';
  outcome?: string;
  summary?: string;
  message?: string;
  next?: string;
  exitCode?: number;
  report?: unknown;
  reportAvailability?: string;
  reportValidationError?: string;
  workspaceSnapshot?: WorkspaceSnapshot;
  gitEvidence?: RunGitEvidence;
  gitBaseline?: string;
  workspaceEvidenceSource?: 'checkpoint' | 'recovery' | 'native';
  nativeStartedAt?: number;
  nativeCompletedAt?: number;
  nativeTokenUsage?: import('./tokenUsage').AgentTokenUsage;
  nativeReply?: string;
  nativeSessionObservation?: { provider: 'claude'; sessionId: string; source: 'CLAUDE_CODE_SESSION_ID' };
  nativeLogRange?: { start: number; end: number };
  nativeWorkspaceObservation?: { workspaceSnapshot: WorkspaceSnapshot; gitEvidence: RunGitEvidence; observedAt: string };
  gitAfterHash?: string;
  requireDeliverable?: boolean;
  preserveRoadmapState?: boolean;
  idempotencyKey: string;
}

export interface RunOutputFinalizationInput {
  executionLogId: number; generation: number; proof: string; expectedRevision: number; expectedTurnId: string;
  exitCode: number; source: 'host' | 'recovery'; workspaceSnapshot?: WorkspaceSnapshot; gitEvidence?: RunGitEvidence; idempotencyKey: string;
}

export interface RunLogInput {
  executionLogId: number;
  generation: number;
  stream: string;
  sequence: number;
  offset: number;
  bytes: string;
  idempotencyKey: string;
}

export interface RunConsumerInput {
  executionLogId: number;
  generation: number;
  expectedRevision: number;
  expectedTurnId: string;
}

export interface RunConsumerLease extends RunConsumerInput {
  token: string;
}

export interface RunSettlementInput extends RunConsumerLease {
  journal: { agentCli: string; command: string; output: string; status: string };
  digest: Record<string, unknown>;
  documentationAudit?: DocumentationAuditResult;
  flowUpdate?: { flow: FlowTrace; expectedRevision: number };
  handoff?: Record<string, unknown>;
  learning?: { eventType: string; summary: string; metadata: Record<string, unknown> };
  index?: { record: Record<string, unknown>; files: Array<Record<string, unknown>>; signals: Array<Record<string, unknown>> };
  effects?: Array<{ kind: RunEffectKind; payload: Record<string, unknown> }>;
  idempotencyKey: string;
}

export type RunEffectKind = 'roadmap' | 'review' | 'revision' | 'refresh' | 'telegram' | 'automation' | 'flow';

export interface RunEffectReference {
  effectId: string;
  projectId: string;
  runId: string;
  turnId: string;
  executionLogId: number;
  sourceRevision: number;
  checkpointSequence: number;
  kind: RunEffectKind;
  error: string;
  token?: string;
}

export interface RunEffect extends RunEffectReference {
  payload: Record<string, any>;
}
