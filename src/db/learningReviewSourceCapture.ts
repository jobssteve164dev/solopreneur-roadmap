import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';

export interface LearningReviewSourceCaptureRequest extends DataWriteDatabaseIdentity {captureId:string;scopes:ReadonlyArray<string|null>}
export interface LearningReviewSourceCapturePage extends DataWriteDatabaseIdentity {captureId:string;limit?:number}
export interface LearningReviewSourceCaptureRowRequest extends LearningReviewSourceCapturePage {objectId:string}
export interface LearningReviewSourceRow {
  objectId:string;kind:string;projectId:string|null;revision:number;createdAt:number;updatedAt:number;
  data:Readonly<Record<string,SqlValue>>;
  relations:ReadonlyArray<{relation:string;target:string}>;
  referenceRows?:ReadonlyArray<Readonly<Record<string,SqlValue>>>;
}
export interface LearningReviewSourceCaptureProgress extends DataWriteDatabaseIdentity {
  captureId:string;sequence:number;migrationVersion:number;captured:number;retained:number;done:boolean;
}
interface Capture {
  identity:DataWriteDatabaseIdentity;captureId:string;scopes:ReadonlyArray<string|null>;
  sequence:number;migrationVersion:number;cursor:string;captured:number;
  open:boolean;rows:Map<string,LearningReviewSourceRow>;
  scopeIndex:number;queues:Map<string|null,{ids:string[];offset:number}>;
}
interface CaptureAccess {
  database:DiskDatabase;rows:(sql:string,values?:SqlValue[])=>Array<Record<string,SqlValue>>;
  load:(header:Record<string,SqlValue>)=>LearningReviewSourceRow;
}
const kinds=['memory','lesson','lesson_decision','learning_event','task','turn','report','verification','evidence'];

/** One actual read view fixes native metadata; bodies are processed only after sealing. */
export class LearningReviewSourceCapture {
  private capture?:Capture;
  constructor(private readonly access:CaptureAccess) {}
  private current(request:LearningReviewSourceCapturePage):Capture {
    const capture=this.capture;if(!capture || capture.captureId!==request.captureId)throw new Error('learning_review_capture_missing');
    if(Object.entries(capture.identity).some(([key,value])=>request[key as keyof DataWriteDatabaseIdentity]!==value))throw new Error('learning_review_capture_identity_changed');return capture;
  }
  private progress(capture:Capture):LearningReviewSourceCaptureProgress {
    return {...capture.identity,captureId:capture.captureId,sequence:capture.sequence,migrationVersion:capture.migrationVersion,captured:capture.captured,retained:capture.rows.size,done:!capture.open};
  }
  public begin(request:LearningReviewSourceCaptureRequest):LearningReviewSourceCaptureProgress {
    if(!/^[a-f0-9-]{36}$/i.test(request.captureId) || !Array.isArray(request.scopes) || !request.scopes.length || request.scopes.some(scope=>scope!==null && typeof scope!=='string') || new Set(request.scopes).size!==request.scopes.length)throw new Error('learning_review_capture_invalid');
    if(this.capture){
      if(this.capture.captureId!==request.captureId)throw new Error('learning_review_capture_busy');
      const current=this.current(request);if(current.scopes.length!==request.scopes.length || current.scopes.some((scope,index)=>scope!==request.scopes[index]))throw new Error('learning_review_capture_identity_changed');return this.progress(current);
    }
    if(this.access.database.inTransaction)throw new Error('content_verification_snapshot_active');
    this.access.database.run('BEGIN');
    try{
      const sequence=Number(this.access.rows('SELECT COALESCE(MAX(sequence),0) AS value FROM events')[0].value),migrationVersion=Number(this.access.rows('SELECT COALESCE(MAX(version),0) AS value FROM schema_migrations')[0].value);
      this.capture={identity:{databaseId:request.databaseId,sourceDevice:request.sourceDevice,sourceInode:request.sourceInode},captureId:request.captureId,scopes:Object.freeze([...request.scopes]),sequence,migrationVersion,cursor:'',captured:0,open:true,rows:new Map(),scopeIndex:0,queues:new Map(request.scopes.map(scope=>[scope,{ids:[],offset:0}]))};return this.progress(this.capture);
    }catch(error){this.access.database.run('ROLLBACK');throw error;}
  }
  public page(request:LearningReviewSourceCapturePage):LearningReviewSourceCaptureProgress {
    const capture=this.current(request),limit=request.limit ?? 64;if(!Number.isInteger(limit) || limit<1 || limit>128)throw new Error('learning_review_capture_limit_invalid');if(!capture.open)return this.progress(capture);
    try{
      const headers=this.access.rows('SELECT id,kind,project_id,revision,created_at,updated_at,archived_at FROM objects WHERE id>? ORDER BY id LIMIT ?',[capture.cursor,limit]);let processed=0,units=0;
      for(const header of headers){
        capture.cursor=String(header.id);processed++;
        if(header.archived_at!==null || !kinds.includes(String(header.kind)) || !capture.scopes.includes(header.project_id===null?null:String(header.project_id)))continue;
        const row=this.access.load(header);capture.rows.set(row.objectId,row);capture.captured++;
        capture.queues.get(row.projectId)!.ids.push(row.objectId);
        const count=(value:SqlValue)=>typeof value==='string'?value.length*2:value instanceof Uint8Array?value.byteLength:8;
        for(const value of Object.values(row.data))units+=count(value);
        for(const value of row.relations)units+=value.relation.length*2+value.target.length*2;
        for(const reference of row.referenceRows || [])for(const value of Object.values(reference))units+=count(value);
        if(units>=2*1024*1024)break;
      }
      if(processed===headers.length && headers.length<limit){this.access.database.run('COMMIT');capture.open=false;}
      return this.progress(capture);
    }catch(error){this.close();throw error;}
  }
  public peek(request:LearningReviewSourceCaptureRowRequest):LearningReviewSourceRow|undefined {
    const capture=this.current(request);if(capture.open)throw new Error('learning_review_capture_not_sealed');return capture.rows.get(request.objectId);
  }
  public consume(request:LearningReviewSourceCaptureRowRequest):boolean {
    const capture=this.current(request);if(capture.open)throw new Error('learning_review_capture_not_sealed');return capture.rows.delete(request.objectId);
  }
  public next(request:LearningReviewSourceCapturePage):LearningReviewSourceRow|undefined {
    const capture=this.current(request);if(capture.open)throw new Error('learning_review_capture_not_sealed');
    while(capture.scopeIndex<capture.scopes.length){
      const queue=capture.queues.get(capture.scopes[capture.scopeIndex])!;
      while(queue.offset<queue.ids.length){const row=capture.rows.get(queue.ids[queue.offset]);if(row)return row;queue.ids[queue.offset++]='';}
      capture.scopeIndex++;
    }
    return undefined;
  }
  public release(request:LearningReviewSourceCapturePage):{released:boolean} {
    if(!this.capture)return {released:false};this.current(request);this.close();return {released:true};
  }
  public hasOpenView():boolean {return Boolean(this.capture?.open);}
  public close():void {
    const capture=this.capture;this.capture=undefined;
    try{if(capture?.open && this.access.database.isOpen)this.access.database.run('ROLLBACK');}
    finally{capture?.rows.clear();capture?.queues.clear();}
  }
}
