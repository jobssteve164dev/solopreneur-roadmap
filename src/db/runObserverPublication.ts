import { randomUUID } from 'crypto';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { UnifiedDataStore } from './unifiedDataStore.js';

export interface NativeRowBuffer {offset:number;cursor:number;length:number;token?:string}
export interface RunNativeRowsRequest extends DataWriteDatabaseIdentity {
  projectId:string;executionLogId:number;stream:string;end:number;state:NativeRowBuffer;create?:boolean;
}
export interface RunNativeRowsResult {state:Required<NativeRowBuffer>;frames:Array<{row:any;offset:number;nextCursor:number}>}
export interface RunNativeRowsReleaseRequest extends DataWriteDatabaseIdentity {tokens:string[]}
export interface RunNativeRowsReleaseResult {released:number;remaining:number}
export interface RunObserverDocumentRequest extends DataWriteDatabaseIdentity {
  projectId:string;executionLogId:number;purpose:string;revision?:number;decode:'json'|'utf8'|'none';
}
export interface PreparedRunObserverDocument {objectId:string;revision:number;value?:any}
export interface RunDocumentValueRequest extends DataWriteDatabaseIdentity {
  input:Omit<Parameters<UnifiedDataStore['writeRunDocument']>[1],'bytes'>;value:unknown;encoding:'json'|'utf8';
}
interface Parser {
  projectId:string;executionLogId:number;stream:string;runId:string;generation:number;
  offset:number;cursor:number;length:number;parts:Buffer[];
}

/** Only incomplete native rows persist here; Source never carries their cumulative byte prefix. */
export class RunNativeRows {
  private readonly parsers=new Map<string,Parser>();
  constructor(private readonly identity:(projectId:string,executionLogId:number)=>{runId:string;generation:number},
    private readonly read:(projectId:string,executionLogId:number,stream:string,offset:number,limit:number)=>string) {}
  public prepare(request:RunNativeRowsRequest):RunNativeRowsResult {
    const {projectId,executionLogId,stream,end}=request,current=this.identity(projectId,executionLogId),old=request.state,token=old.token || randomUUID();
    if(!Number.isSafeInteger(end) || end<old.offset)throw new Error('native_transcript_offset_invalid');
    let parser=this.parsers.get(token);
    if(old.token && parser){
      if(parser.projectId!==projectId || parser.executionLogId!==executionLogId || parser.stream!==stream || parser.runId!==current.runId)throw new Error('native_parser_identity_conflict');
      if(parser.generation!==current.generation)throw new Error('run_owner_conflict');
      if(['offset','cursor','length'].some(key=>parser![key as 'offset'|'cursor'|'length']!==old[key as 'offset'|'cursor'|'length']))throw new Error('native_parser_state_conflict');
    }else{
      if(old.token && !request.create)throw new Error('native_parser_identity_conflict');
      if(!Number.isSafeInteger(old.offset) || old.offset<0 || old.cursor!==old.offset || old.length!==0)throw new Error('native_transcript_offset_invalid');
      parser={projectId,executionLogId,stream,...current,offset:old.offset,cursor:old.cursor,length:0,parts:[]};
    }
    if(!Number.isSafeInteger(end) || end<parser!.offset)throw new Error('native_transcript_offset_invalid');
    const frames:RunNativeRowsResult['frames']=[];
    if(parser!.offset<end){
      const bytes=Buffer.from(this.read(projectId,executionLogId,stream,parser!.offset,Math.min(1_048_576,end-parser!.offset)),'base64');
      if(!bytes.length)throw new Error('native_source_read_incomplete');
      parser!.offset+=bytes.length;let start=0,newline=bytes.indexOf(10);
      while(newline>=0){
        const segment=bytes.subarray(start,newline);parser!.parts.push(segment);parser!.length+=segment.length;
        const text=Buffer.concat(parser!.parts,parser!.length).toString('utf8');let row:any;
        try{row=JSON.parse(text);}catch{}
        const nextCursor=parser!.cursor+parser!.length+1;frames.push({row,offset:parser!.cursor,nextCursor});parser!.cursor=nextCursor;parser!.parts=[];parser!.length=0;start=newline+1;newline=bytes.indexOf(10,start);
      }
      if(start<bytes.length){const segment=bytes.subarray(start);parser!.parts.push(segment);parser!.length+=segment.length;}
    }
    this.parsers.set(token,parser!);return {frames,state:{token,offset:parser!.offset,cursor:parser!.cursor,length:parser!.length}};
  }
  public release(tokens:ReadonlyArray<string>):RunNativeRowsReleaseResult {
    if(tokens.length>128)throw new Error('native_parser_release_batch_invalid');
    let released=0;for(const token of tokens)if(this.parsers.delete(token))released++;return {released,remaining:this.parsers.size};
  }
  public close():void {this.parsers.clear();}
}
