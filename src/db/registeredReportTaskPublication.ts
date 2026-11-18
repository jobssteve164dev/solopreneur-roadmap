import type { DataWriteDatabaseIdentity,PreparedDataWrite,DataWriteImportSource } from './dataWritePublication.js';
import type { LearningReviewApplyEvidence,LearningReviewApplyNode } from './learningReviewPublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { PreparedContentPublication } from './unifiedDataStore.js';
import type { SqlValue } from './diskDatabase.js';

export interface RegisteredReportTaskData {
  taskId:string;userMessage:string;startedAt:string;executions:Array<{id:number;nodeId:string}>;
}
interface RegisteredReportTaskBase extends DataWriteDatabaseIdentity {
  actorId:string;time:number;objectId:string;projectId:string;source:DataWriteImportSource;task:RegisteredReportTaskData;
}
export type RegisteredReportTaskRequest=RegisteredReportTaskBase & (
  | {phase:'capture';bytes:Uint8Array}
  | {phase:'conversation'}
  | {phase:'task';conversationId:string}
);
export interface RegisteredReportTaskFailure {name:string;message:string;code?:string}
export interface PreparedRegisteredReportTask extends LearningReviewApplyEvidence {
  phase:RegisteredReportTaskRequest['phase'];sha256?:string;capture?:PreparedContentPublication;
  captureFailure?:RegisteredReportTaskFailure;legacy?:Record<string,SqlValue>|null;
  conversation?:LearningReviewApplyNode & {prepared?:PreparedDataWrite};conversationId?:string;
  selection?:ImportObjectSelection;inputHash?:string;absentContents:string[];
  tail?:{executionsJson:string;startedAt:string;titlePreview:string;update:boolean};
  failure?:RegisteredReportTaskFailure & {point:'before_capture'|'after_capture'|'conversation'|'task'|'tail'};
}
