import type { DataWriteDatabaseIdentity, PreparedDataWrite, PreparedMutationReplay } from './dataWritePublication.js';
import type { StateJsonSnapshot } from './stateJsonValue.js';
import type { SqlValue } from './diskDatabase.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { DataWrite } from './unifiedDataStore.js';
import { dataValueTransferIfDeep,restoreDataValueTransfer,type DataValueTransfer } from './dataValueTransfer.js';

export interface StateWriteReservation {requestId:string;generation:number}
export interface StateWriteResult {objectId:string;revision:number;value:unknown}
export interface StateWriteRejection {rejected:{objectId:string|null;revision:number;value:unknown}}
export type StateWriteHeader=({type:'analysis';projectId:string|null;namespace:string;key:string}|{type:'strategy';projectId:string|null;sourceProjectIds?:string[]}) & {idempotencyKey:string;expectedSourceRevision?:string;reservation?:StateWriteReservation;growthReservationRequestId?:string} & ({expectedRevision:number}|{selectCurrentRevision:true});
export type StateWriteRequest=DataWriteDatabaseIdentity & {actorId:string;objectId:string;time:number;state:StateWriteHeader & StateJsonSnapshot};
export interface StateSourceProject {
  projectId:string;mode:'conversation'|'strategy';revision:SqlValue;
  preferenceId?:string|null;preferenceRevision?:number|null;
}
export interface StateWriteSelection {
  mode:'publish'|'rejected'|'growth-replay';choice:Record<string,SqlValue>|null;request:Record<string,SqlValue>|null;
  growthRequest?:Record<string,SqlValue>|null;growthReplay?:PreparedMutationReplay;
  reservationChoice?:Record<string,SqlValue>|null;rejected?:StateWriteRejection['rejected'];serializedRejection?:string;
  sourceProjects:StateSourceProject[];heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
  input?:DataWrite;prepared?:PreparedDataWrite;objectId?:string;value?:unknown;serializedValue?:string;
  valueTransport?:DataValueTransfer;rejectedValueTransport?:DataValueTransfer;
}

export function stateWriteSelectionForTransfer(selection:StateWriteSelection):StateWriteSelection {
  const valueTransport=dataValueTransferIfDeep(selection.value),rejectedValueTransport=dataValueTransferIfDeep(selection.rejected?.value);
  if(!valueTransport && !rejectedValueTransport)return selection;
  return{...selection,...(valueTransport?{value:undefined,valueTransport}:{}),...(rejectedValueTransport?{rejected:{...selection.rejected!,value:undefined},rejectedValueTransport}:{})};
}

export function restoreStateWriteSelection(selection:StateWriteSelection):StateWriteSelection {
  if(!selection.valueTransport && !selection.rejectedValueTransport)return selection;
  const {valueTransport,rejectedValueTransport,...rest}=selection;
  return{...rest,...(valueTransport?{value:restoreDataValueTransfer(valueTransport)}:{}),...(rejectedValueTransport?{rejected:{...selection.rejected!,value:restoreDataValueTransfer(rejectedValueTransport)}}:{})};
}
