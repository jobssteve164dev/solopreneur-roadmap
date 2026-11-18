import type { UnifiedDataStore, WriteReceipt, DataObject, DataWrite } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { ContentVerificationIdentity } from './contentVerification.js';

export interface RunReportRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;objectId:string;
  input:Omit<Parameters<UnifiedDataStore['submitRunReport']>[1],'availability'|'validationError'> & {root?:string};
  suppliedStatus?:Pick<Parameters<UnifiedDataStore['submitRunReport']>[1],'availability'|'validationError'>;
}
export interface RunReportSubmissionIdentity {executionLogId:number;generation:number;turnId:string}
export interface RunReportHeader {
  id:string;revision:number;createdAt:number;updatedAt:number;archivedAt:SqlValue;schemaVersion:SqlValue;availability:SqlValue;contentId:SqlValue;
}
export interface RunReportResultRequest extends DataWriteDatabaseIdentity {receipt:WriteReceipt;availability:string}
export interface PreparedRunReportResult {result:WriteReceipt & {availability:string};serialized:string}
export interface PreparedRunReport {
  before:Record<string,SqlValue>;
  head:RunReportHeader|null;
  report:{objectId:string;revision:number;availability:string};
  input:Parameters<UnifiedDataStore['submitRunReport']>[1];
  node?:{input:DataWrite;objectId:string;producer:'submit_run_report';reportSubmission:RunReportSubmissionIdentity;projectedPrevious?:DataObject};
  replay?:{receipt:WriteReceipt;contents:ContentVerificationIdentity[];result:PreparedRunReportResult};
  bind:boolean;bindCommitted:boolean;
  heads:Array<{id:string;revision:number|null}>;
  contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
}
