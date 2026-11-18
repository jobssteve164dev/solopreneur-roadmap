import { randomUUID } from 'crypto';
import { continueRuntimeWork, readRuntimeWorkContinuation, resumeRuntimeWork, type RuntimeSchedulerAdmission, type RuntimeWorkContinuation } from './runtimePriorityScheduler.js';
import { recyclingProjectScopeOperations } from './db/recyclingProjectScopeProof.js';

export const runtimeContinuableOperations=new Set(['maintain_database_storage','import_project',...recyclingProjectScopeOperations]);

export interface RuntimeContinuationDescriptor { token: string; waiting: boolean }

/** Private worker transport: executable work never leaves its owning thread. */
export class RuntimeContinuationSource {
  private readonly pending=new Map<string,{work:RuntimeWorkContinuation<unknown>;ready:boolean}>();
  constructor(private readonly notifyReady:(token:string,error?:string)=>void) {}
  public expose(value:unknown):RuntimeContinuationDescriptor | undefined {
    const work=readRuntimeWorkContinuation(value);if(!work)return undefined;
    const token=randomUUID(),entry={work,ready:work.waitFor===undefined};this.pending.set(token,entry);
    if(work.waitFor!==undefined)void Promise.resolve(work.waitFor).then(()=>{
      if(this.pending.get(token)!==entry)return;entry.ready=true;this.notifyReady(token);
    },error=>{
      if(this.pending.get(token)!==entry)return;this.pending.delete(token);
      this.notifyReady(token,error instanceof Error?error.message:String(error));
    });
    return {token,waiting:!entry.ready};
  }
  public async resume(token:string,admission:RuntimeSchedulerAdmission):Promise<unknown> {
    const entry=this.pending.get(token);
    if(!entry)throw new Error('runtime_continuation_missing');
    if(!entry.ready)throw new Error('runtime_continuation_not_ready');
    this.pending.delete(token);return resumeRuntimeWork(entry.work,admission);
  }
  public clear():void {this.pending.clear();}
}

export interface RuntimeContinuationSession {readonly done:Promise<void>;readonly context?:unknown}
interface Session extends RuntimeContinuationSession {resolve():void;reject(error:unknown):void}

/** Converts transport tokens back into the existing Scheduler's accepted work. */
export class RuntimeContinuationClient {
  private readonly waiting=new Map<string,{resolve():void;reject(error:unknown):void}>();
  private readonly sessions=new Set<Session>();
  constructor(private readonly resume:(token:string,admission:RuntimeSchedulerAdmission,session:RuntimeContinuationSession)=>Promise<unknown>) {}
  public accept(descriptor:RuntimeContinuationDescriptor,existing?:RuntimeContinuationSession,context?:unknown):RuntimeWorkContinuation<unknown> {
    let session=existing as Session | undefined;
    if(session && !this.sessions.has(session))throw new Error('runtime_continuation_session_finished');
    if(!session){
      let resolve!:()=>void,reject!:(error:unknown)=>void;
      const done=new Promise<void>((a,b)=>{resolve=a;reject=b;});void done.catch(()=>undefined);
      session={done,resolve,reject,context};this.sessions.add(session);
    }
    let waitFor:Promise<void> | undefined;
    if(descriptor.waiting)waitFor=new Promise<void>((resolve,reject)=>this.waiting.set(descriptor.token,{resolve,reject}));
    const accepted=session;
    if(waitFor)void waitFor.catch(error=>this.finish(accepted,error));
    return continueRuntimeWork(admission=>this.resume(descriptor.token,admission,accepted),waitFor);
  }
  public ready(token:string,error?:string):void {
    const waiting=this.waiting.get(token);if(!waiting)return;
    this.waiting.delete(token);if(error!==undefined)waiting.reject(new Error(error));else waiting.resolve();
  }
  public active(session:RuntimeContinuationSession):boolean {return this.sessions.has(session as Session);}
  public get activeCount():number {return this.sessions.size;}
  public finish(session:RuntimeContinuationSession,error?:unknown):void {
    const owned=session as Session;if(!this.sessions.delete(owned))return;
    if(error!==undefined)owned.reject(error);else owned.resolve();
  }
  public fail(error:unknown):void {
    for(const pending of this.waiting.values())pending.reject(error);this.waiting.clear();
    for(const session of [...this.sessions])this.finish(session,error);
  }
  public async drain():Promise<void> {while(this.sessions.size)await Promise.allSettled([...this.sessions].map(session=>session.done));}
}
