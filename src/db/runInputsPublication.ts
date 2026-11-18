import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity, ContentVerificationRequest } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject, PreparedContentPublication, WriteReceipt } from './unifiedDataStore.js';
import type { RunState } from '../runLifecycleTypes.js';
import type { ContentReferenceSummary } from '../contentReferences.js';
import type { RunControlProjectedState } from './runControlPublication.js';

export interface RunInputsPatchInput {
  executionLogId: number; generation: number; expectedRevision: number;
  prompt?: string; command?: string; status?: string; idempotencyKey: string;
}
export interface RunInputsPreparationRequest extends DataWriteDatabaseIdentity {
  projectId: string; actorId: string; input: RunInputsPatchInput;
  projectedBase?:RunControlProjectedState;
  projectedTurn?:DataObject;
  projectReplay?:boolean;
}
export interface RunInputsHeads {
  runId: string; revision: number; generation: number; turnId: string;
  promptId: string; commandId: string; metadataId: string;
}
export interface PreparedRunInputs {
  inputHash: string; replay: boolean; before: RunInputsHeads;
  fields: Array<{field: 'prompt' | 'command'; publication: PreparedContentPublication}>;
  replayProjection?:PreparedRunInputsResult & {
    request:Record<string,SqlValue>;descriptor:RunInputsResultRequest;contents:ContentVerificationIdentity[];
  };
}
export interface RunInputsPlanRequest extends RunInputsPreparationRequest {
  time: number;
  contents: ReadonlyArray<ContentVerificationRequest & {field: 'prompt' | 'command' | 'metadata'}>;
  summarizeContentIds?: string[];
}
export interface PreparedRunInputsPlan {
  contents: RunInputsPlanRequest['contents']; before: RunInputsHeads;
  beforeRun: Record<string, SqlValue>; object: DataObject; terms: string;
  snapshot: PreparedContentPublication;
  summaries: Array<{id: string; summary: ContentReferenceSummary}>;
  turn: {id: string; revision: number; finishedAt: SqlValue};
  lessonHeads: Array<{id: string; revision: number | null}>;
  lessons: Array<{objectId: string; revision: number; projectId: string | null}>;
}
export interface RunInputsResultRequest extends DataWriteDatabaseIdentity {
  agentLaunch?:{fallbackWorkspaceRoot:string;dataRoot:string;omitReceipt?:boolean};
  claudeNativeResume?:boolean;
  proof?: string;
  projectId: string; executionLogId: number; runId: string;
  snapshotId: string; control: Record<string, SqlValue>;
  journalExecutionLogId: number | null; learningTaskId: string; receipt: WriteReceipt;
  historical: boolean;
}
export interface PreparedRunInputsResult { result: RunState; serialized: string }

const serializedResults = new WeakMap<object, string>();
export function cacheRunInputsResult(value: object, serialized: string): void { serializedResults.set(value, serialized); }
export function runInputsSerializedResult(value: object): string | undefined { return serializedResults.get(value); }
