import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { RunConsumerInput, RunConsumerLease } from '../runLifecycleTypes.js';

export interface RunConsumerClaimRequest extends DataWriteDatabaseIdentity {
  projectId:string;input:RunConsumerInput & {owner:{id:string;pid:number;birth:string}};
}
export interface PreparedRunConsumerClaim {
  before:Record<string,SqlValue>;source:Record<string,SqlValue>|null;
  lease?:Record<string,SqlValue>|null;history?:Record<string,SqlValue>;live?:boolean;
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
  decision:{type:'none'}|{type:'existing';value:RunConsumerLease}|{type:'claim'};
}
