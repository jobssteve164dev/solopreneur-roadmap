import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';

/** Watches the actual Source TEMP input and the growth collection used by its final transaction. */
export class GrowthStageVerification {
  private initialized=false;
  private stageInputsInitialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public bootstrap(includeStageInputs=true):void {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_growth_stage_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_growth_stage_watches(token TEXT PRIMARY KEY,stage_id TEXT,project_id TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1))) WITHOUT ROWID');
        for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          this.database.run(`CREATE TEMP TRIGGER solomap_growth_snapshot_${action.toLowerCase()} AFTER ${action} ON main.growth_snapshots BEGIN ${sides.map(side=>`UPDATE solomap_growth_stage_watches SET dirty=1 WHERE dirty=0 AND project_id=${side}.project_id;`).join(' ')} END`);
          this.database.run(`CREATE TEMP TRIGGER solomap_growth_object_${action.toLowerCase()} AFTER ${action} ON main.objects BEGIN ${sides.map(side=>`UPDATE solomap_growth_stage_watches SET dirty=1 WHERE dirty=0 AND ${side}.kind='growth_snapshot' AND project_id=${side}.project_id;`).join(' ')} END`);
        }
        this.database.run('RELEASE solomap_growth_stage_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_growth_stage_bootstrap');this.database.run('RELEASE solomap_growth_stage_bootstrap');throw error;}
    }
    if(includeStageInputs && !this.stageInputsInitialized){
      this.database.run('SAVEPOINT solomap_growth_stage_inputs_bootstrap');
      try{
        for(const table of ['runtime_growth_refresh_stages','runtime_growth_refresh_stage_items'])for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          this.database.run(`CREATE TEMP TRIGGER solomap_growth_stage_${table}_${action.toLowerCase()} AFTER ${action} ON temp.${table} BEGIN ${sides.map(side=>`UPDATE solomap_growth_stage_watches SET dirty=1 WHERE dirty=0 AND stage_id=${side}.stage_id;`).join(' ')} END`);
        }
        this.database.run('RELEASE solomap_growth_stage_inputs_bootstrap');this.stageInputsInitialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_growth_stage_inputs_bootstrap');this.database.run('RELEASE solomap_growth_stage_inputs_bootstrap');throw error;}
    }
  }
  public beginProject(projectId:string):string {
    this.bootstrap(false);this.flushRetired();const token=randomUUID();this.database.run('INSERT INTO temp.solomap_growth_stage_watches VALUES(?,NULL,?,0)',[token,projectId]);return token;
  }
  public begin(stageId:string,projectId:string):string {
    this.bootstrap();this.flushRetired();const token=randomUUID();this.database.run('INSERT INTO temp.solomap_growth_stage_watches VALUES(?,?,?,0)',[token,stageId,projectId]);return token;
  }
  public current(token:string):boolean {
    if(!this.database.isOpen)return false;const statement=this.database.prepare('SELECT dirty FROM temp.solomap_growth_stage_watches WHERE token=?');
    try{statement.bind([token]);return statement.step() && statement.getAsObject().dirty===0;}finally{statement.free();}
  }
  public release(token:string):void {
    this.releaseFailure=undefined;
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return;}
    this.retired.add(token);try{this.database.run('DELETE FROM temp.solomap_growth_stage_watches WHERE token=?',[token]);this.retired.delete(token);this.reported.delete(token);}catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap growth stage proof release pending: ${String(error)}\n`);this.reported.add(token);}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}
    if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.release(token);
    if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size>0;
  }
}
