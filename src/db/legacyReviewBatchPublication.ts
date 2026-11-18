import type { DataObject, DataWrite, LegacyReviewTarget, PreparedContentPublication } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity, DataWriteReferenceRequest, DataWriteImportSource as ImportedSource, PreparedDataWrite } from './dataWritePublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence, LearningReviewApplyPublication } from './learningReviewPublication.js';
import type { LinkInput, PreparedLink } from './linkPublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { ReviewManifest } from '../learningReview.js';
import { jsonByteViewLength, snapshotJsonByteView, snapshotDataWrite } from './dataWritePublication.js';
import { createDataValueTransfer,restoreDataValueTransfer,type DataValueTransfer } from './dataValueTransfer.js';
import { types } from 'util';

export interface LegacyReviewBatchInput {
  identity:string;runKey:string;manifest:ReviewManifest;proposal:string|null;application:any|null;
  targets?:LegacyReviewTarget[];files:Array<{key:string;hash:string}>;
}
export interface LegacyReviewBatchError {name:string;message:string;code?:string}
export interface LegacyReviewBatchSeed {
  raw:Array<{key:string;publication:PreparedContentPublication}>;
  saved:Record<string,unknown>;batchSource?:ImportedSource;batchInput?:DataWrite;
  targets:LegacyReviewTarget[];explicitTargets:boolean;applicationPrompt:unknown;
  files:LegacyReviewBatchInput['files'];identity:string;runKey:string;afterErrors?:string;
  failure?:LegacyReviewBatchError;
  nativeBuffers?:ReadonlyArray<Uint8Array>;targetBuffers?:ReadonlyArray<ReadonlyArray<Uint8Array>>;
}
/** A prior import is witnessed by its actual staged fixed snapshot, never a fabricated migration row. */
export interface LegacyReviewPriorImport {source:ImportedSource;publication:LearningReviewApplyPublication}
interface LegacyReviewBatchContext extends DataWriteDatabaseIdentity {actorId:string;time:number;objectId:string;nativeBuffers?:ReadonlyArray<Uint8Array>}
interface LegacyReviewBatchDependencies {
  publications:LearningReviewApplyPublication[];prior?:LegacyReviewPriorImport;
  references:DataWriteReferenceRequest[];
}
export type LegacyReviewBatchOperation=(
  | {kind:'batch';seed:LegacyReviewBatchSeed;bindings:Array<{key:string;contentId:string}>}
  | {kind:'target';identity:string;runKey:string;entry:LegacyReviewTarget;explicitTargets:boolean;applicationPrompt:unknown}
  | {kind:'archive';source:ImportedSource;entry:LegacyReviewTarget;targetId:string}
  | {kind:'application';identity:string;runKey:string;entry:LegacyReviewTarget;explicitTargets:boolean;file?:{key:string;hash:string};batchId:string;targetId:string}
  | {kind:'artifact';identity:string;file:{key:string;hash:string}}
  | {kind:'link';batchSource:ImportedSource;batchId:string;artifactId:string}) & {nativeBuffers?:ReadonlyArray<Uint8Array>};
export type LegacyReviewBatchRequest=LegacyReviewBatchContext & (
  | {phase:'capture';input:LegacyReviewBatchInput}
  | {phase:'fields';input:DataWrite;source:ImportedSource;references:DataWriteReferenceRequest[];previousPublication?:LearningReviewApplyPublication}
  | ({phase:'operation';operation:LegacyReviewBatchOperation} & LegacyReviewBatchDependencies)
);
export interface PreparedLegacyReviewOperation extends LearningReviewApplyEvidence {
  source?:ImportedSource;selection?:ImportObjectSelection;input?:DataWrite;objectId?:string;
  previous?:DataObject;fields?:PreparedDataWrite;inputHash?:string;
  imports:Array<{identity:string;key:string;row:Record<string,SqlValue>|null}>;
  referenceIds?:string[];
  nativeBuffers?:ReadonlyArray<Uint8Array>;
  absentContents:string[];skip?:true;link?:{input:LinkInput;prepared?:PreparedLink};
  failure?:LegacyReviewBatchError & {point:'read'|'mutation'};
}
export type PreparedLegacyReviewBatch={phase:'capture';seed:LegacyReviewBatchSeed}|{phase:'operation';value:PreparedLegacyReviewOperation};

/** Only private leaves that still occur in this message need their original Buffer identity. */
export function legacyReviewBufferHints(value:unknown,pool:ReadonlyArray<Uint8Array>):Uint8Array[] {
  if(!pool.length)return[];const declared=new Set(pool),seen=new WeakSet<object>(),pending:unknown[]=[value],result:Uint8Array[]=[];
  while(pending.length){const current=pending.pop();if(!current || typeof current!=='object' || seen.has(current))continue;seen.add(current);if(declared.has(current as Uint8Array))result.push(current as Uint8Array);const prototype=Object.getPrototypeOf(current);if(Array.isArray(current) || prototype===null || prototype===Object.prototype){for(const item of Object.values(current))pending.push(item);}else for(const [,item] of legacyReviewCapturedFields(current))pending.push(item);}
  return result;
}

/** Compute restores the type on the actual privately captured view, without encoding bytes on Source. */
export function restoreLegacyReviewBuffers(values:ReadonlyArray<Uint8Array>):void {
  for(const value of values){if(!(value instanceof Uint8Array))throw new Error('prepared_content_invalid');if(!Buffer.isBuffer(value))Object.setPrototypeOf(value,Buffer.prototype);}
}

type LegacyReviewNativeField=[string,unknown,boolean];
const legacyReviewNativeKeys=new WeakMap<object,Array<[string,boolean]>>();
const legacyReviewJsonValues=new WeakMap<object,string>(),nativeUrlJson=URL.prototype.toJSON;
const legacyReviewRawValues=new WeakSet<object>(),nativeLegacyJson=JSON as typeof JSON & {isRawJSON?:(value:unknown)=>boolean;rawJSON?:(text:string)=>unknown};
function legacyReviewCapturedFields(value:object):LegacyReviewNativeField[] {
  return (legacyReviewNativeKeys.get(value) || []).map(([key,enumerable])=>[key,Reflect.get(value,key),enumerable]);
}
/** Native cloning preserves intrinsic data, but omits JSON-visible own fields. */
function legacyReviewNativeFields(value:object,canonical=false):{fields:LegacyReviewNativeField[];deferred:boolean} {
  if(!canonical && types.isBoxedPrimitive(value) && !types.isSymbolObject(value))return{fields:[],deferred:true};
  let current:object|null=value,hook:PropertyDescriptor|undefined;
  while(current && !(hook=Object.getOwnPropertyDescriptor(current,'toJSON')))current=Object.getPrototypeOf(current);
  if(!canonical && hook && (!('value' in hook) || typeof hook.value==='function'))return{fields:[],deferred:true};
  const span=ArrayBuffer.isView(value) && !(value instanceof DataView)?jsonByteViewLength(value):0,fields:LegacyReviewNativeField[]=[];
  for(const key of Object.keys(value)){
    if((key==='0' || /^[1-9]\d*$/.test(key)) && Number(key)<span)continue;
    fields.push([key,Reflect.get(value,key),true]);
  }
  if(hook && 'value' in hook && typeof hook.value!=='function' && !fields.some(([key])=>key==='toJSON'))fields.push(['toJSON',hook.value,false]);
  return{fields,deferred:false};
}

/** Keep plain containers and native own fields in the same private reference graph. */
export function snapshotLegacyReviewInput(input:LegacyReviewBatchInput,observeCopy:(source:object,result:object)=>void):LegacyReviewBatchInput {
  const seen=new WeakMap<object,unknown>(),deferredNative=new WeakMap<object,object>(),frames:Array<{source:object;target:object;index:number;length:number;entries?:LegacyReviewNativeField[]}>=[];
  const captureFields=(source:object,target:object,fields:LegacyReviewNativeField[])=>{const entries=fields.filter(([key])=>Object.getOwnPropertyDescriptor(target,key)?.configurable!==false);if(entries.length){legacyReviewNativeKeys.set(target,entries.map(([key,,enumerable])=>[key,enumerable]));frames.push({source,target,index:0,length:0,entries});}};
  const copy=(value:unknown):unknown=>{
    if(!value || typeof value!=='object')return value;if(seen.has(value))return seen.get(value);
    if(nativeLegacyJson.isRawJSON?.(value)){const text=(value as {rawJSON:string}).rawJSON,result=Object.assign(Object.create(null),{rawJSON:text});seen.set(value,result);legacyReviewJsonValues.set(result,text);legacyReviewRawValues.add(result);return result;}
    if(value instanceof URL && value.toJSON===nativeUrlJson){const result={};seen.set(value,result);legacyReviewJsonValues.set(result,Reflect.apply(nativeUrlJson,value,[]));deferredNative.set(result,value);return result;}
    const prototype=Object.getPrototypeOf(value),intrinsic=types.isDate(value) || types.isBoxedPrimitive(value) && !types.isSymbolObject(value) || ArrayBuffer.isView(value) && !types.isDataView(value);
    if(intrinsic){let result:object;if(ArrayBuffer.isView(value) && !types.isDataView(value)){result=snapshotJsonByteView(value);observeCopy(value,result);}else result=snapshotDataWrite(value,observeCopy);seen.set(value,result);const selected=legacyReviewNativeFields(value);if(selected.deferred)deferredNative.set(result,value);captureFields(value,result,selected.fields);return result;}
    const target=Array.isArray(value)?new Array(value.length):Object.create(prototype===null?null:Object.prototype);seen.set(value,target);
    frames.push({source:value,target,index:0,length:Array.isArray(value)?target.length:0,...(Array.isArray(value)?{}:{entries:Object.entries(value).map(([key,item])=>[key,item,true] as LegacyReviewNativeField)})});return target;
  };
  const flush=()=>{while(frames.length){const frame=frames[frames.length-1];if(frame.index===(frame.entries?.length ?? frame.length)){frames.pop();continue;}const index=frame.index++;let key:string,item:unknown,enumerable=true;if(frame.entries)[key,item,enumerable]=frame.entries[index];else{key=String(index);if(!(index in frame.source))continue;item=Reflect.get(frame.source,key);}Object.defineProperty(frame.target,key,{value:copy(item),enumerable,configurable:true,writable:true});}};
  const result=copy(input) as LegacyReviewBatchInput;flush();
  // These original consumers use canonicalJson rather than JSON.stringify. Upgrade
  // their actual private aliases without rereading ordinary caller containers.
  const pending:unknown[]=[result.identity,result.runKey,result.files,result.proposal,result.application?.targetPrompt],canonicalSeen=new WeakSet<object>();
  if(Array.isArray(result.targets))for(const target of result.targets)pending.push(target?.data,target?.before,target?.after,target?.afterSource,target?.afterError);
  while(pending.length){const value=pending.pop();if(!value || typeof value!=='object' || canonicalSeen.has(value))continue;canonicalSeen.add(value);const source=deferredNative.get(value);if(source){deferredNative.delete(value);captureFields(source,value,legacyReviewNativeFields(source,true).fields);flush();}
    const prototype=Object.getPrototypeOf(value);if(Array.isArray(value) || prototype===null || prototype===Object.prototype){for(const child of Object.values(value))pending.push(child);}else for(const [,child] of legacyReviewCapturedFields(value))pending.push(child);
  }
  return result;
}

type LegacyReviewInvisible={kind:'function'}|{kind:'symbol';description?:string;global?:string;wellKnown?:string};
interface LegacyReviewPrivateReference {reference?:number;value?:unknown;legacyReviewInvisible?:number}
interface LegacyReviewBatchWire {legacyReviewData:DataValueTransfer;jsonInvisible:LegacyReviewInvisible[]}
interface LegacyReviewPrivateData {value:unknown;nativeFields:Array<{value:object;fields:LegacyReviewNativeField[]}>;jsonValues:Array<{value:object;json?:string;raw?:true}>}
function legacyReviewPrivateReferences(transfer:DataValueTransfer,visit:(value:LegacyReviewPrivateReference)=>void):void {
  visit(transfer.root);for(const node of transfer.nodes)if(node.kind!=='native')for(const [,field] of node.fields)visit(field);
}
function legacyReviewWire(value:unknown):LegacyReviewBatchWire {
  const nativeFields:LegacyReviewPrivateData['nativeFields']=[],jsonValues:LegacyReviewPrivateData['jsonValues']=[],pending:unknown[]=[value],seen=new WeakSet<object>();let hasInvisible=false;
  while(pending.length){const item=pending.pop();if(typeof item==='function' || typeof item==='symbol'){hasInvisible=true;continue;}if(!item || typeof item!=='object' || seen.has(item))continue;seen.add(item);const prototype=Object.getPrototypeOf(item);
    if(legacyReviewJsonValues.has(item))jsonValues.push(legacyReviewRawValues.has(item)?{value:item,raw:true}:{value:item,json:legacyReviewJsonValues.get(item)!});
    if(Array.isArray(item) || prototype===null || prototype===Object.prototype){for(const child of Object.values(item))pending.push(child);}
    else{const fields=legacyReviewCapturedFields(item);if(fields.length)nativeFields.push({value:item,fields});for(const [,child] of fields)pending.push(child);}
  }
  const legacyReviewData=createDataValueTransfer({value,nativeFields,jsonValues}),jsonInvisible:LegacyReviewInvisible[]=[],ids=new Map<symbol|Function,number>();
  if(hasInvisible)legacyReviewPrivateReferences(legacyReviewData,field=>{
    const item=field.value;if(typeof item!=='symbol' && typeof item!=='function')return;let id=ids.get(item);
    if(id===undefined){id=jsonInvisible.length;ids.set(item,id);jsonInvisible.push(typeof item==='function'?{kind:'function'}:{kind:'symbol',description:item.description,global:Symbol.keyFor(item),wellKnown:Object.getOwnPropertyNames(Symbol).find(key=>Object.getOwnPropertyDescriptor(Symbol,key)?.value===item)});}
    field.value=undefined;field.legacyReviewInvisible=id;
  });
  return{legacyReviewData,jsonInvisible};
}
export function legacyReviewRequestForTransfer(value:LegacyReviewBatchRequest):LegacyReviewBatchWire {return legacyReviewWire(value);}
export function legacyReviewResultForTransfer(value:PreparedLegacyReviewBatch):LegacyReviewBatchWire {return legacyReviewWire(value);}
function readLegacyReviewWire(value:unknown):unknown {
  if(!value || typeof value!=='object' || !('legacyReviewData' in value))throw new Error('legacy_review_preparation_invalid');const wire=value as LegacyReviewBatchWire,leaves=wire.jsonInvisible.map(item=>item.kind==='function'?function legacyReviewDataFunction(){throw new Error('legacy_review_input_requires_fixed_data');}:item.wellKnown?Reflect.get(Symbol,item.wellKnown) as symbol:item.global!==undefined?Symbol.for(item.global):Symbol(item.description));
  if(leaves.length)legacyReviewPrivateReferences(wire.legacyReviewData,field=>{if(field.legacyReviewInvisible===undefined)return;const id=field.legacyReviewInvisible;if(!Number.isInteger(id) || id<0 || id>=leaves.length)throw new Error('legacy_review_preparation_invalid');field.value=leaves[id];delete field.legacyReviewInvisible;});
  const restored=restoreDataValueTransfer(wire.legacyReviewData) as LegacyReviewPrivateData;
  for(const item of restored.nativeFields){legacyReviewNativeKeys.set(item.value,item.fields.map(([key,,enumerable])=>[key,enumerable]));for(const [key,field,enumerable] of item.fields)Object.defineProperty(item.value,key,{value:field,enumerable,configurable:true,writable:true});}
  for(const item of restored.jsonValues){const text=item.raw?(item.value as {rawJSON:unknown}).rawJSON:item.json;if(typeof text!=='string')throw new Error('legacy_review_preparation_invalid');legacyReviewJsonValues.set(item.value,text);if(item.raw)legacyReviewRawValues.add(item.value);let projection:unknown;Object.defineProperty(item.value,'toJSON',{value:()=>item.raw?(projection??=nativeLegacyJson.rawJSON!(text)):text,enumerable:false,configurable:true,writable:true});}return restored.value;
}
export function restoreLegacyReviewRequest(value:unknown):LegacyReviewBatchRequest {return readLegacyReviewWire(value) as LegacyReviewBatchRequest;}
export function restoreLegacyReviewResult(value:unknown):PreparedLegacyReviewBatch {return readLegacyReviewWire(value) as PreparedLegacyReviewBatch;}
