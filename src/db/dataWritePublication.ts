import { createHash } from 'crypto';
import { types } from 'util';
import { canonicalJson } from '../contentReferences.js';
import { indexTokens } from './searchIndex.js';
import type { DataWrite, DataObject, WriteReceipt, PreparedContentPublication, ContentPublicationInput } from './unifiedDataStore.js';
import type { ContentReferenceSummary } from '../contentReferences.js';
import type { ContentVerificationIdentity, ContentVerificationRequest } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { RunReportSubmissionIdentity } from './runReportPublication.js';
import type { LinkInput } from './linkPublication.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';

const byteViewPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const byteViewLengthGetter=Object.getOwnPropertyDescriptor(byteViewPrototype,'length')!.get!;
const byteViewBufferGetter=Object.getOwnPropertyDescriptor(byteViewPrototype,'buffer')!.get!;
const arrayBufferDetachedGetter=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'detached')?.get;
export const nativeBufferJson=Buffer.prototype.toJSON;

export type DataMutationIntent={operation:'write';input:DataWrite}|{operation:'link';input:LinkInput};

export interface DataWriteDatabaseIdentity {
  databaseId: string; sourceDevice: string; sourceInode: string;
}
export interface RecordedObjectReadTarget {
  objectId: string;
  revision: number;
  objectRevision: number | null;
  entityExists: boolean;
  currentContentId: string | null;
  snapshotContentId: string | null;
}
export interface RecordedObjectRead {
  contents: ContentVerificationIdentity[];
  heads: ObjectHeadObservation[];
  revisions: ObjectRevisionVerification[];
  replayTarget?: RecordedObjectReadTarget;
  replayReadIds?: string[];
}
export interface DataWriteImportSource {identity:string;key:string;hash:string}
export interface DataWritePreparationRequest extends DataWriteDatabaseIdentity {
  input: DataWrite; actorId: string; objectId: string; force?: boolean; nativeReferenceSelection?:true;
  source?:DataWriteImportSource;referenceSource?:DataWriteImportSource;
  previousPublication?:import('./learningReviewPublication.js').LearningReviewApplyPublication;
  contentBindings?:Readonly<Record<string,string>>;
  referencePublications?: ReadonlyArray<DataWriteReferenceRequest>;
  producer?: 'append_automation_event' | 'enqueue_notification' | 'submit_run_report' | 'checkpoint_run_report';
  reportSubmission?:RunReportSubmissionIdentity;
}
export interface DataWriteMetadataReference {objectId: string; revision: number}
export interface DataWriteNativeReferenceRead extends DataWriteMetadataReference {
  head?:ObjectHeadObservation & {signature:string};current:boolean;content?:{contentId:string;sha256:string};
}
export interface DataWriteReferenceDiscoveryRequest extends DataWriteDatabaseIdentity {
  input: DataWrite; normalizedData: Record<string,SqlValue>; objectId: string; time: number; actorId: string;nativeReferenceSelection?:true;
  source?:DataWriteImportSource;referenceSource?:DataWriteImportSource;
  referencePublications?: ReadonlyArray<DataWriteReferenceRequest>;
  producer?: DataWritePreparationRequest['producer'];
  reportSubmission?:RunReportSubmissionIdentity;
}
export interface DataWriteReferenceRequest extends DataWriteMetadataReference {
  content: ContentVerificationRequest;
  pendingPublication?: true;
  nativeRevision?:number|null;
}
export interface DataWriteValidatedReference {
  objectId: string; revision: number | null; kind: string; projectId: string | null;
  contentId?: string; sha256?: string;nativeCurrent?:true;
}
export interface DataWriteReferenceContext {
  previous: DataObject | null; sourceEventIds?: string[]; observedHeads: ObjectHeadObservation[]; candidateRefsInherited?: boolean;
  collecting?: boolean; requested?: ReadonlyArray<DataWriteReferenceRequest>; validated: DataWriteValidatedReference[];
  smallBudget?: number; newObject?: boolean;nativeSelection?:true;nativeReads?:DataWriteNativeReferenceRead[];
}
export interface PreparedMutationReplay {
  receipt:WriteReceipt;serialized:string;request:Record<string,SqlValue>;contents:ContentVerificationIdentity[];
}
export interface PreparedDataWrite {
  inputHash: string; replay: boolean;
  fields: Array<{field: string; publication: PreparedContentPublication}>;
  normalizedData: Record<string,SqlValue>; contentFields: Array<[string,string]>;
  references: DataWriteMetadataReference[];
  replayResult?:PreparedMutationReplay;
  nativeReferenceReads?:DataWriteNativeReferenceRead[];referenceFailure?:{name:string;message:string;code?:string};
}
export interface DataWriteSearchRequest extends DataWriteReferenceDiscoveryRequest {
  reviewPreparation?:true;
  legacyReviewImport?:true;
  projectedPrevious?:DataObject;
  registryMetadataProjection?:true;
  telegramSettingsProjection?:true;
  scheduleSyncProjection?:true;
  evidenceRoot?:true;
  retainProjectedObject?:boolean;
  contents: ReadonlyArray<ContentVerificationRequest & {field: string}>;
  references: ReadonlyArray<DataWriteReferenceRequest>;
  summarizeContentIds?: string[];
}
export interface PreparedDataWriteSearch {
  projectedObject?:DataObject;
  contents: DataWriteSearchRequest['contents']; terms: string;
  object: DataObject; normalizedData: Record<string,SqlValue>; snapshot?: PreparedContentPublication;
  snapshotFailure?:NonNullable<PreparedDataWrite['referenceFailure']>;
  reportMetadataJson?: string;
  references: DataWriteReferenceContext;
  summaries: Array<{id: string; summary: ContentReferenceSummary}>;
}

/** Array JSON reads indexed properties regardless of their owner or enumerability. */
export function jsonArrayKeys(value:ReadonlyArray<unknown>):string[] {
  const length=value.length,keys=new Set<string>();
  for(let object:object|null=value;object;object=Object.getPrototypeOf(object)){
    for(const key of Object.getOwnPropertyNames(object))if((key==='0' || /^[1-9]\d*$/.test(key)) && Number(key)<length)keys.add(key);
  }
  return [...keys].sort((left,right)=>Number(left)-Number(right));
}

/** Read the intrinsic indexed span without consuming caller properties. */
export function jsonByteViewLength(value:ArrayBufferView):number {
  return Reflect.apply(byteViewLengthGetter,value,[]);
}
export function canCaptureNativeBuffer(value:unknown):boolean {
  if(!types.isUint8Array(value))return false;
  let length:PropertyDescriptor|undefined;
  for(let current:object|null=value;current;current=Object.getPrototypeOf(current)){
    if(types.isProxy(current))return false;
    length ??=Object.getOwnPropertyDescriptor(current,'length');
  }
  return Buffer.isBuffer(value) && length?.get===byteViewLengthGetter;
}
/** Detached numeric views still have JSON-visible named fields, but no indexed bytes. */
export function snapshotJsonByteView(value:ArrayBufferView):ArrayBufferView {
  const buffer=Reflect.apply(byteViewBufferGetter,value,[]);
  if(types.isArrayBuffer(buffer)){
    if(arrayBufferDetachedGetter){if(Reflect.apply(arrayBufferDetachedGetter,buffer,[]))return new Uint8Array(0);}
    else try{new Uint8Array(buffer,0,0);}catch{return new Uint8Array(0);}
  }
  return snapshotDataWrite(value);
}

/** Copy mutable request containers while sharing immutable, potentially very large strings. */
export function snapshotDataWrite<T>(input: T, observeCopy?:(source:object,result:object)=>void, options?:{jsonValue?:boolean;preserveArraySlots?:boolean;defer?:(value:unknown)=>boolean;observeProperties?:(value:object,properties:Record<string,unknown>)=>void}): T {
  const seen=new WeakMap<object,unknown>();
  const copy=(value: unknown): unknown=>{
    if(options?.defer?.(value))return value;
    if(options?.jsonValue && (typeof value==='function' || typeof value==='symbol'))return undefined;
    if(!value || typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    const nativeJson=JSON as typeof JSON & {isRawJSON?:(value:unknown)=>boolean};
    if(options?.jsonValue && nativeJson.isRawJSON?.(value)){const result=Object.assign(Object.create(null),{rawJSON:(value as {rawJSON:string}).rawJSON});seen.set(value,result);observeCopy?.(value,result);return result;}
    if(options?.jsonValue && value instanceof URL && typeof value.toJSON==='function')return value.href;
    const prototype=Object.getPrototypeOf(value),leaf=!options?.jsonValue || types.isDate(value) && typeof (value as {toJSON?:unknown}).toJSON==='function' || ArrayBuffer.isView(value) && !types.isDataView(value) || types.isBoxedPrimitive(value) && !types.isSymbolObject(value);
    if(!Array.isArray(value) && ![null,Object.prototype].includes(prototype) && leaf){
      let result=options?.jsonValue && ArrayBuffer.isView(value) && !types.isDataView(value)?snapshotJsonByteView(value):structuredClone(value);
      if(ArrayBuffer.isView(result) && typeof SharedArrayBuffer!=='undefined' && result.buffer instanceof SharedArrayBuffer){
        const buffer=new ArrayBuffer(result.byteLength);new Uint8Array(buffer).set(new Uint8Array(result.buffer,result.byteOffset,result.byteLength));
        const View=result.constructor as new(buffer:ArrayBuffer,offset:number,length:number)=>object;result=new View(buffer,0,(result as unknown as {length:number}).length);
      }
      seen.set(value,result);observeCopy?.(value,result);
      if(options?.jsonValue && ArrayBuffer.isView(value) && (!Buffer.isBuffer(value) || value.toJSON!==nativeBufferJson)){
        const length=jsonByteViewLength(result as ArrayBufferView),properties:Record<string,unknown>=Object.create(null);let count=0;
        for(const key of Object.keys(value)){
          if((key==='0' || /^[1-9]\d*$/.test(key)) && Number(key)<length)continue;
          const descriptor={value:copy((value as unknown as Record<string,unknown>)[key]),enumerable:true,configurable:true,writable:true};Object.defineProperty(properties,key,descriptor);Object.defineProperty(result,key,descriptor);count++;
        }
        if(count)options.observeProperties?.(result,properties);
      }
      return result;
    }
    const result: Record<string,unknown> | unknown[]=Array.isArray(value)?new Array(value.length):Object.create(options?.jsonValue && prototype!==null?Object.prototype:prototype);seen.set(value,result);
    if(options?.jsonValue)observeCopy?.(value,result);
    if(options?.preserveArraySlots && Array.isArray(value)){
      const length=(result as unknown[]).length;
      for(let index=0;index<length;index++)if(index in value)Object.defineProperty(result,String(index),{value:copy(Reflect.get(value,String(index))),enumerable:true,configurable:true,writable:true});
    }else if(options?.jsonValue && Array.isArray(value)){
      for(const key of jsonArrayKeys(value))Object.defineProperty(result,key,{value:copy(Reflect.get(value,key)),enumerable:true,configurable:true,writable:true});
    }else for(const [key,item] of Object.entries(value))Object.defineProperty(result,key,{value:copy(item),enumerable:true,configurable:true,writable:true});
    return result;
  };
  return copy(input) as T;
}

function boundedJsonStringBytes(value: string, budget: number): number | undefined {
  let bytes=2;
  if(value.length>budget || bytes>budget)return undefined;
  for(let index=0;index<value.length;index++){
    const code=value.charCodeAt(index);
    if(code===34 || code===92)bytes+=2;
    else if(code<32)bytes+=[8,9,10,12,13].includes(code)?2:6;
    else if(code<128)bytes++;
    else if(code<2048)bytes+=2;
    else if(code>=0xd800 && code<=0xdbff){
      const next=value.charCodeAt(index+1);
      if(next>=0xdc00 && next<=0xdfff){bytes+=4;index++;}else bytes+=6;
    }else bytes+=code>=0xdc00 && code<=0xdfff?6:3;
    if(bytes>budget)return undefined;
  }
  return bytes;
}

export function boundedDataWriteBytes(value: unknown, budget: number): number | undefined {
  let remaining=budget;const seen=new WeakSet<object>(),pending: unknown[]=[value];
  while(pending.length){
    const item=pending.pop();
    if(item && typeof item==='object'){
      if(seen.has(item))return undefined;seen.add(item);remaining-=2;
      if(Array.isArray(item)){
        if(item.length>remaining)return undefined;
        for(let index=0;index<item.length;index++){remaining--;pending.push(item[index]);}
      }else for(const key in item){
        if(!Object.prototype.hasOwnProperty.call(item,key))continue;
        const bytes=boundedJsonStringBytes(key,remaining-2);if(bytes===undefined)return undefined;
        remaining-=bytes+2;
        if(remaining<0)return undefined;pending.push((item as Record<string,unknown>)[key]);
      }
    }else{
      if(typeof item==='string'){
        const bytes=boundedJsonStringBytes(item,remaining);if(bytes===undefined)return undefined;remaining-=bytes;
      }else{
        const encoded=JSON.stringify(item);if(encoded===undefined)return undefined;remaining-=Buffer.byteLength(encoded);
      }
    }
    if(remaining<0 || pending.length>remaining)return undefined;
  }
  return budget-remaining;
}

export function normalizeDataWriteFields<T>(kind: string, input: Record<string,unknown>, allowed: ReadonlySet<string>, encode: (field: string,value: unknown)=>T,encodeNullFields?:ReadonlySet<string>): Record<string,SqlValue | T> {
    if (kind === 'learning_event' && input.occurred_at != null) {
      const value = input.occurred_at;
      if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 8.64e15) throw new Error('learning_timestamp_invalid: occurred_at');
    }
    if (kind === 'lesson' && input.semantic_review_json != null) {
      let value: any;
      try { value = typeof input.semantic_review_json === 'string' ? JSON.parse(input.semantic_review_json) : input.semantic_review_json; }
      catch { throw new Error('lesson_field_invalid: semantic_review_json'); }
      if (!value || value.schemaVersion !== 2 || typeof value.runId !== 'string' || !value.runId || typeof value.proposalHash !== 'string' || !value.proposalHash || !Array.isArray(value.evidence) || value.evidence.some((id: unknown) => typeof id !== 'string') || typeof value.target !== 'string' || typeof value.reason !== 'string') throw new Error('lesson_field_invalid: semantic_review_json');
    }
    if (kind === 'lesson') for (const field of ['external_created_at', 'external_updated_at']) {
      const value = input[field];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 8.64e15) throw new Error(`lesson_timestamp_invalid: ${field}`);
    }
    if (kind === 'lesson') for (const field of ['evidence_refs_json', 'source_event_ids_json']) {
      if (input[field] == null) continue;
      let value: unknown;
      try { value = typeof input[field] === 'string' ? JSON.parse(input[field]) : input[field]; }
      catch { throw new Error(`lesson_field_invalid: ${field}`); }
      const valid = Array.isArray(value) && value.every(item => field === 'source_event_ids_json' ? typeof item === 'string' : item && typeof item === 'object' && typeof item.type === 'string' && typeof item.ref === 'string' && (item.summary === undefined || typeof item.summary === 'string'));
      if (!valid) throw new Error(`lesson_field_invalid: ${field}`);
    }
    const result: Record<string, SqlValue | T> = {};
    for (const [inputKey, value] of Object.entries(input)) {
      if (kind === 'lesson_decision' && inputKey === 'candidate_refs') continue;
      if (kind === 'lesson' && inputKey === 'event_refs') continue;
      const key = inputKey === 'content' ? 'content_id' : (inputKey.endsWith('_content') ? `${inputKey}_id` : inputKey);
      if (!allowed.has(key) || kind === 'growth_snapshot' && key === 'snapshot_sequence' || kind === 'report' && key === 'creation_sequence') throw new Error(`invalid_field: ${kind}.${inputKey}`);
      if (key !== inputKey) {
        result[key] = value===null && !encodeNullFields?.has(inputKey)?null:encode(inputKey,value);
      } else if (typeof value === 'boolean') result[key] = value ? 1 : 0;
      else if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
      else if (key.endsWith('_json')) result[key] = canonicalJson(value);
      else throw new Error(`invalid_value: ${kind}.${inputKey}`);
    }
    return result;
  }

export function prepareDataWriteFields(request: DataWritePreparationRequest, allowed: ReadonlySet<string>,
  previousHash: string | undefined, prepare: (input: ContentPublicationInput)=>PreparedContentPublication, expandedFields: Record<string,unknown> | (()=>Record<string,unknown>)=request.input.data): PreparedDataWrite {
  const intent=request.contentBindings && Object.keys(request.contentBindings).length?{input:request.input,source:request.source,contentBindings:request.contentBindings}:request.source?{input:request.input,source:request.source}:request.producer==='append_automation_event'?{operation:'append_automation_event',projectId:request.input.scope,event:request.input.data.content}
    :request.producer==='enqueue_notification'?{operation:'enqueue_notification',...(request.input.data.content as Record<string,unknown>)}
    :request.producer==='checkpoint_run_report'?{operation:'checkpoint_report',projectId:request.input.scope,runId:request.input.data.run_id,turnId:request.input.data.turn_id,report:request.input.data.content,availability:request.input.data.availability,validationError:request.input.data.validation_error || ''}
    :request.producer==='submit_run_report'?{operation:'submit_run_report',projectId:request.input.scope,...request.reportSubmission,report:request.input.data.content,availability:request.input.data.availability,validationError:request.input.data.validation_error || ''}:request.input;
  const inputHash=createHash('sha256').update(canonicalJson(intent)).digest('hex');
  if(previousHash!==undefined){
    if(previousHash!==inputHash)throw new Error('idempotency_conflict');
    if(!request.force)return {inputHash,replay:true,fields:[],normalizedData:{},contentFields:[],references:[]};
  }
  const fields: PreparedDataWrite['fields']=[];
  const normalized=normalizeDataWriteFields<{field: string}>(request.input.kind,typeof expandedFields==='function'?expandedFields():expandedFields,allowed,(field,value)=>{
    const binary=request.producer?undefined:value as {encoding?: string; data?: string; mimeType?: string};
    const structuredReport=['submit_run_report','checkpoint_run_report'].includes(request.producer || '') && field==='content';
    const input: ContentPublicationInput=binary && binary.encoding==='base64'
      ? {bytes:binary.data as string,transportEncoding:'base64',mimeType:binary.mimeType || 'application/octet-stream',encoding:'binary'}
      : {bytes:typeof value==='string' && !structuredReport?value:canonicalJson(value),mimeType:typeof value==='string' && !structuredReport?'text/plain':'application/json',encoding:'utf8'};
    if(binary && binary.encoding==='base64' && typeof binary.data!=='string')throw new Error('invalid_binary_content');
    try{fields.push({field,publication:prepare(input)});}
    catch(error){if(error instanceof Error && error.message==='content_source_encoding_invalid')throw new Error('invalid_binary_content');throw error;}
    return {field};
  },['submit_run_report','checkpoint_run_report'].includes(request.producer || '')?new Set(['content']):undefined);
  const normalizedData: Record<string,SqlValue>={},contentFields: Array<[string,string]>=[];
  for(const [column,value] of Object.entries(normalized)){
    if(value && typeof value==='object' && !(value instanceof Uint8Array))contentFields.push([column,(value as {field: string}).field]);
    else normalizedData[column]=value as SqlValue;
  }
  const used=new Set(contentFields.map(([,field])=>field));
  return {inputHash,replay:false,fields:fields.filter(field=>used.has(field.field)),normalizedData,contentFields,references:[]};
}

/** FTS is a candidate index; the existing full substring check remains authoritative. */
export function dataWriteFieldSearchTerms(field: string, decoded: unknown): string {
  return indexTokens(`${JSON.stringify(field)}:${canonicalJson(decoded)},"}`);
}
