import type { UnifiedDataStore, PreparedContentPublication, DataObject, WriteReceipt } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity, ContentVerificationRequest } from './contentVerification.js';
import type { RunControlProjectedState } from './runControlPublication.js';
import type { SqlValue } from './diskDatabase.js';

export interface RunDocumentRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;objectId:string;time:number;
  input:Parameters<UnifiedDataStore['writeRunDocument']>[1];
  projectedBase?:RunControlProjectedState;projectedTurn?:DataObject;
}
export interface PreparedRunDocument {
  inputHash:string;sha256:string;runId:string;
  request:Record<string,SqlValue>|null;
  current:{id:string;revision:number;contentId:string}|null;
  objectId:string;revision:number;
  body?:PreparedContentPublication;
  replay?:{receipt:WriteReceipt;serialized:string;contents:ContentVerificationIdentity[]};
}
export interface RunDocumentPlanRequest extends Omit<RunDocumentRequest,'input'> {
  input:Omit<RunDocumentRequest['input'],'bytes'>;
  prepared:Omit<PreparedRunDocument,'body'>;content:ContentVerificationRequest;
}
export interface PreparedRunDocumentPlan {
  object:DataObject;terms:string;snapshot:PreparedContentPublication;content:ContentVerificationRequest;
}
