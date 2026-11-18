import type { DataObject, PreparedContentPublication, WriteReceipt } from './unifiedDataStore.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { StepMemoryContext, StepMemoryStateSelection } from './stepMemoryPublication.js';

export interface StepMemoryImportInput {nodeId:string;source:{identity:string;key:string;hash:string};bytes:Buffer;format:'json'|'md'}
export interface StepMemoryImportContext extends Omit<StepMemoryContext,'key'> {sourceObjectId:string}
export interface StepMemoryImportRequest extends StepMemoryImportContext {input:StepMemoryImportInput}
export interface StepMemoryImportUnchanged {unchanged:true;before:Record<string,SqlValue>|null}
export interface PreparedStepMemoryImport {
  unchanged:false;before:Record<string,SqlValue>|null;key:string;inputHash:string;
  sourceId:string;entryCount:number;sourceRequest:Record<string,SqlValue>|null;
  sourceReceipt?:WriteReceipt;projectionReceipt?:WriteReceipt;
  selection:StepMemoryStateSelection;removals:string[];assignments:string[];
  source?:PreparedContentPublication;metadata?:PreparedContentPublication;sourceRefs?:PreparedContentPublication;
}
export type StepMemoryImportPreparation=StepMemoryImportUnchanged|PreparedStepMemoryImport;
export interface StepMemoryImportSourcePlanRequest extends StepMemoryImportContext {content:ContentVerificationIdentity}
export interface StepMemoryImportSourcePlan {object:DataObject;terms:string;snapshot:PreparedContentPublication}
