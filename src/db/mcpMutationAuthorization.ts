import type { DataWriteDatabaseIdentity, DataMutationIntent } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
export type McpMutationIntent=DataMutationIntent;
export interface McpMutationAuthorizationRequest extends DataWriteDatabaseIdentity {
  intent:McpMutationIntent;scope:string;reviewBatchId?:string;
}
export interface PreparedMcpMutationAuthorization {
  heads:Array<{id:string;revision:number|null}>;
  contents:ContentVerificationIdentity[];
  reviewControls:Array<{batchId:string;inputContentId:string}>;
  reviewProjects:string[];
  locations:Array<{root:string;projectIds:string[]}>;
}
export interface McpMutationAuthorizationHandle {check():void;release():Promise<void>}
export class McpMutationAuthorizationChanged extends Error {
  constructor(){super('mcp_mutation_authorization_changed');}
}
