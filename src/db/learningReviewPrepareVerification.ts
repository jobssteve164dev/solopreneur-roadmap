import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';

/** Selection inputs outside the fixed source capture, observed on the existing Writer. */
export class LearningReviewPrepareVerification {
  private initialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public begin():string {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_review_prepare_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_review_prepare_watches(token TEXT PRIMARY KEY,dirty INTEGER NOT NULL CHECK(dirty IN (0,1))) WITHOUT ROWID');
        for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          const tables:Array<{table:string;when?:string}>=[
            {table:'projects'},{table:'project_locations'},{table:'review_batches'},
            {table:'learning_review_controls'},{table:'legacy_learning_review_controls'},
            {table:'legacy_learning_review_cursor_inputs'},
            {table:'file_bindings'},{table:'documents'},
            {table:'settings',when:sides.map(side=>`${side}.namespace IN ('learning_review','learning_review_legacy') AND ${side}.owner_scope='global'`).join(' OR ')},
            {table:'policies',when:sides.map(side=>`${side}.kind='global_prompt'`).join(' OR ')},
            {table:'applications',when:sides.map(side=>`EXISTS(SELECT 1 FROM main.learning_review_controls c WHERE c.batch_id=${side}.review_id) OR EXISTS(SELECT 1 FROM main.legacy_learning_review_controls c WHERE c.batch_id=${side}.review_id)`).join(' OR ')},
            {table:'run_control',when:sides.map(side=>`EXISTS(SELECT 1 FROM main.learning_review_controls c JOIN main.review_batches b ON b.id=c.batch_id WHERE c.run_id=${side}.run_id AND b.status IN ('draft','interrupted'))`).join(' OR ')},
            {table:'runs',when:sides.map(side=>`EXISTS(SELECT 1 FROM main.learning_review_controls c JOIN main.review_batches b ON b.id=c.batch_id WHERE c.run_id=${side}.id AND b.status IN ('draft','interrupted'))`).join(' OR ')}
          ];
          for(const entry of tables)this.database.run(`CREATE TEMP TRIGGER solomap_review_prepare_${entry.table}_${action.toLowerCase()} AFTER ${action} ON main.${entry.table} ${entry.when?`WHEN ${entry.when}`:''} BEGIN UPDATE solomap_review_prepare_watches SET dirty=1 WHERE dirty=0; END`);
        }
        this.database.run("CREATE TEMP TRIGGER solomap_review_prepare_object_archive AFTER UPDATE OF archived_at ON main.objects WHEN NEW.archived_at IS NOT OLD.archived_at AND (NEW.kind IN ('project','review_batch') OR EXISTS(SELECT 1 FROM main.policies p WHERE p.id=NEW.id AND p.kind='global_prompt')) BEGIN UPDATE solomap_review_prepare_watches SET dirty=1 WHERE dirty=0; END");
        this.database.run('RELEASE solomap_review_prepare_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_review_prepare_bootstrap');this.database.run('RELEASE solomap_review_prepare_bootstrap');throw error;}
    }
    this.flushRetired();const token=randomUUID();this.database.run('INSERT INTO temp.solomap_review_prepare_watches VALUES(?,0)',[token]);return token;
  }
  public current(token:string):boolean {
    if(!this.database.isOpen)return false;
    const statement=this.database.prepare('SELECT dirty FROM temp.solomap_review_prepare_watches WHERE token=?');
    try{statement.bind([token]);return statement.step() && statement.getAsObject().dirty===0;}finally{statement.free();}
  }
  public release(token:string):void {
    this.releaseFailure=undefined;
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return;}
    this.retired.add(token);
    try{this.database.run('DELETE FROM temp.solomap_review_prepare_watches WHERE token=?',[token]);this.retired.delete(token);this.reported.delete(token);}
    catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap review preparation proof release pending: ${String(error)}\n`);this.reported.add(token);}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}
    if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.release(token);
    if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size>0;
  }
}
