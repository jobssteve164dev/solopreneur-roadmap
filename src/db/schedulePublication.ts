import type { DataWriteDatabaseIdentity, PreparedMutationReplay, RecordedObjectRead } from './dataWritePublication.js';
import type { DataWrite, PreparedContentPublication } from './unifiedDataStore.js';
import type { HostSettingsPatch } from './hostSettingsPublication.js';
import type { SqlValue } from './diskDatabase.js';

export interface ScheduleSyncInput {
  schedules: Array<{ id:string; timezone:string; trigger:Record<string,unknown>; enabled:boolean; nextDueAt:number; task:Record<string,unknown> }>;
  expectedVersion?: string;
  idempotencyKey: string;
}

export interface ScheduleSyncPreparation extends DataWriteDatabaseIdentity {
  input: ScheduleSyncInput;
  actorId: string;
}

export interface ScheduleSyncPlan {
  inputHash: string;
  evidence?: DataWrite;
  replay?: PreparedMutationReplay;
  replayFailure?: { name:string;message:string;code?:string };
  requests: Array<{key:string;header:Record<string,SqlValue>|null}>;
  templateReads: string[];
  versionConflict?: boolean;
  failure?: { itemIndex?: number; disabledId?: string; name: string; message: string; code?: string };
  entries: Array<{
    unchanged: boolean;
    shapeUnchanged: boolean;
    dueAt: number;
    write?: DataWrite;
    objectId?: string;
    priorRequestHash?: string;
    occurrenceId?: string;
    payload?: PreparedContentPublication;
    payloadFailure?: { name: string; message: string; code?: string };
  }>;
  disabled: DataWrite[];
}

export interface PiTimeSchedulePreparation extends DataWriteDatabaseIdentity {
  input: Record<string, unknown>;
  now: number;
}

export interface PiTimeSchedulePlan {
  project?: { root: string; projectId: string };
  settings?: HostSettingsPatch;
  schedules?: ScheduleSyncInput;
  result?: Record<string, unknown>;
  inputValidUntil?: number;
  dailyValidUntil?: number;
  failure?: { name: string; message: string; code?: string };
}

export interface ScheduleClaimInput {
  owner: { id: string; pid: number; birth: string };
  now?: number;
  leaseMs?: number;
  limit?: number;
}

export type ScheduleClaimPreparation = DataWriteDatabaseIdentity & {
  candidates: Array<{ row: Record<string, SqlValue>; token: string }>;
};
export type PreparedScheduleClaims = { result: { items: Array<Record<string, unknown>> }; serialized: string }
  | { failure: { index: number; name: string; message: string; code?: string } };

export interface ScheduleSettlementInput {
  occurrenceId: string;
  token: string;
  state: 'pending' | 'completed' | 'failed' | 'cancelled';
  retryAt?: number;
  error?: string;
  idempotencyKey: string;
}
export interface ScheduleSettlementResult { occurrenceId: string; state: ScheduleSettlementInput['state']; generation: number }
export type ScheduleSettlementPreparation = DataWriteDatabaseIdentity & { actorId: string; input: ScheduleSettlementInput };
type SettlementFailure = { name: string; message: string; code?: string };
export interface PreparedScheduleSettlement extends RecordedObjectRead {
  inputHash: string;
  replay?: PreparedMutationReplay;
  replayFailure?: SettlementFailure;
  result?: ScheduleSettlementResult;
  resultFailure?: SettlementFailure;
  next?: { input: DataWrite; dueAt: number; occurrenceKey: string; body?: PreparedContentPublication; bodyFailure?: SettlementFailure };
  afterUpdateFailure?: SettlementFailure;
}
