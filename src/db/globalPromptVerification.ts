import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';

/** Observes policy selection and the unfinished applications selected by a user save. */
export class GlobalPromptVerification {
  private initialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public begin():string {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_global_prompt_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_global_prompt_watches(token TEXT PRIMARY KEY,dirty INTEGER NOT NULL CHECK(dirty IN (0,1))) WITHOUT ROWID');
        for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          const conditions=sides.map(side=>`${side}.kind='global_prompt'`).join(' OR ');
          this.database.run(`CREATE TEMP TRIGGER solomap_global_prompt_policy_${action.toLowerCase()} AFTER ${action} ON main.policies WHEN ${conditions} BEGIN UPDATE solomap_global_prompt_watches SET dirty=1 WHERE dirty=0; END`);
          const relevant=sides.map(side=>`EXISTS(SELECT 1 FROM main.policies p WHERE p.id=${side}.target_object_id AND p.kind='global_prompt') OR EXISTS(SELECT 1 FROM main.legacy_learning_review_controls l WHERE l.batch_id=${side}.review_id)`).join(' OR ');
          this.database.run(`CREATE TEMP TRIGGER solomap_global_prompt_application_${action.toLowerCase()} AFTER ${action} ON main.applications WHEN ${relevant} BEGIN UPDATE solomap_global_prompt_watches SET dirty=1 WHERE dirty=0; END`);
          this.database.run(`CREATE TEMP TRIGGER solomap_global_prompt_legacy_${action.toLowerCase()} AFTER ${action} ON main.legacy_learning_review_controls BEGIN UPDATE solomap_global_prompt_watches SET dirty=1 WHERE dirty=0; END`);
        }
        this.database.run("CREATE TEMP TRIGGER solomap_global_prompt_object_update AFTER UPDATE ON main.objects WHEN EXISTS(SELECT 1 FROM main.policies p WHERE p.id IN (OLD.id,NEW.id) AND p.kind='global_prompt') BEGIN UPDATE solomap_global_prompt_watches SET dirty=1 WHERE dirty=0; END");
        this.database.run('RELEASE solomap_global_prompt_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_global_prompt_bootstrap');this.database.run('RELEASE solomap_global_prompt_bootstrap');throw error;}
    }
    this.flushRetired();const token=randomUUID();this.database.run('INSERT INTO temp.solomap_global_prompt_watches VALUES(?,0)',[token]);return token;
  }
  public current(token:string):boolean {
    if(!this.database.isOpen)return false;
    const statement=this.database.prepare('SELECT dirty FROM temp.solomap_global_prompt_watches WHERE token=?');
    try{statement.bind([token]);return statement.step() && statement.getAsObject().dirty===0;}finally{statement.free();}
  }
  public release(token:string):void {
    this.releaseFailure=undefined;
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return;}
    this.retired.add(token);
    try{this.database.run('DELETE FROM temp.solomap_global_prompt_watches WHERE token=?',[token]);this.retired.delete(token);this.reported.delete(token);}
    catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap global prompt proof release pending: ${String(error)}\n`);this.reported.add(token);}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}
    if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.release(token);
    if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size>0;
  }
}
