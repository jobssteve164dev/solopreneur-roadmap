import type { DataWrite } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity, DataWriteImportSource, PreparedDataWrite } from './dataWritePublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { DataValueTransfer } from './dataValueTransfer.js';
import type { LegacyReviewPriorImport } from './legacyReviewBatchPublication.js';
import type { LearningReviewApplyPublication } from './learningReviewPublication.js';

export interface ImportObjectContext extends DataWriteDatabaseIdentity {actorId:string;objectId:string;time:number;deferFields?:true;observeMetadata?:true;contentBindings?:Readonly<Record<string,string>>;priorImport?:LegacyReviewPriorImport;publications?:ReadonlyArray<LearningReviewApplyPublication>}
export type StateImport=({type:'analysis';projectId:string|null;namespace:string;key:string;value:unknown}|{type:'strategy';projectId:string|null;value:unknown}) & {nativeBuffers?:ReadonlyArray<Uint8Array>;nativeProperties?:ReadonlyArray<{value:object;properties:Record<string,unknown>}>;nativeRawJson?:ReadonlyArray<{rawJSON:string}>;transport?:DataValueTransfer};
export type ImportObjectIntent=({input:DataWrite}|{state:StateImport}) & {source:DataWriteImportSource};
export type StateImportHeader={type:'analysis';projectId:string|null;namespace:string;key:string}|{type:'strategy';projectId:string|null};
export type ImportObjectRequest=ImportObjectContext & ImportObjectIntent;
export interface ImportObjectSelection {
  mode:'unchanged'|'conflict'|'publish';before:Record<string,SqlValue>|null;
  conflict?:'source_binding_mismatch'|'newer_database_revision';
  input?:DataWrite;prepared?:PreparedDataWrite;objectId?:string;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  revisions:ObjectRevisionVerification[];
  stateChoice?:Record<string,SqlValue>|null;
}
