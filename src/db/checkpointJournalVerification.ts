import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';

/** Source-local invalidation for the unbounded TEXT row consumed by a checkpoint. */
export class CheckpointJournalVerification {
  private initialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public begin(projectId:string,executionLogId:number):string {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.flushRetired();
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_checkpoint_journal_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_checkpoint_journal_watches(token TEXT PRIMARY KEY,project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,dirty INTEGER NOT NULL) WITHOUT ROWID');
        this.database.run('CREATE INDEX temp.solomap_checkpoint_journal_target ON solomap_checkpoint_journal_watches(project_id,execution_log_id,dirty)');
        this.database.run('CREATE TEMP TABLE solomap_checkpoint_log_watches(token TEXT NOT NULL,run_id TEXT NOT NULL,stream TEXT NOT NULL,max_sequence INTEGER NOT NULL,PRIMARY KEY(token,stream)) WITHOUT ROWID');
        this.database.run('CREATE INDEX temp.solomap_checkpoint_log_target ON solomap_checkpoint_log_watches(run_id,stream,max_sequence)');
        for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          this.database.run(`CREATE TEMP TRIGGER solomap_checkpoint_journal_${action.toLowerCase()} AFTER ${action} ON main.project_journal_entries BEGIN ${sides.map(side=>`UPDATE solomap_checkpoint_journal_watches SET dirty=1 WHERE project_id=${side}.project_id AND execution_log_id=${side}.execution_log_id AND dirty=0;`).join(' ')} END`);
        }
        for(const action of ['UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:['OLD'];
          this.database.run(`CREATE TEMP TRIGGER solomap_checkpoint_log_${action.toLowerCase()} AFTER ${action} ON main.log_chunks BEGIN ${sides.map(side=>`UPDATE solomap_checkpoint_journal_watches SET dirty=1 WHERE dirty=0 AND token IN (SELECT token FROM solomap_checkpoint_log_watches WHERE run_id=${side}.run_id AND stream=${side}.stream AND max_sequence>=${side}.sequence);`).join(' ')} END`);
          this.database.run(`CREATE TEMP TRIGGER solomap_checkpoint_log_content_${action.toLowerCase()} AFTER ${action} ON main.contents BEGIN UPDATE solomap_checkpoint_journal_watches SET dirty=1 WHERE dirty=0 AND token IN (SELECT w.token FROM main.log_chunks l JOIN solomap_checkpoint_log_watches w ON w.run_id=l.run_id AND w.stream=l.stream AND w.max_sequence>=l.sequence WHERE l.content_id=OLD.id); END`);
        }
        this.database.run(`CREATE TEMP TRIGGER solomap_checkpoint_log_insert AFTER INSERT ON main.log_chunks BEGIN UPDATE solomap_checkpoint_journal_watches SET dirty=1 WHERE dirty=0 AND token IN (SELECT token FROM solomap_checkpoint_log_watches WHERE run_id=NEW.run_id AND stream=NEW.stream AND max_sequence>=NEW.sequence); END`);
        this.database.run('RELEASE solomap_checkpoint_journal_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_checkpoint_journal_bootstrap');this.database.run('RELEASE solomap_checkpoint_journal_bootstrap');throw error;}
    }
    const token=randomUUID();this.database.run('INSERT INTO temp.solomap_checkpoint_journal_watches VALUES(?,?,?,0)',[token,projectId,executionLogId]);return token;
  }
  public logs(token:string,runId:string,values:ReadonlyArray<{stream:string;sequence:number}>):void {
    for(const value of values)this.database.run('INSERT INTO temp.solomap_checkpoint_log_watches VALUES(?,?,?,?)',[token,runId,value.stream,value.sequence]);
  }
  public current(token:string):boolean {
    if(!this.database.isOpen)return false;
    const statement=this.database.prepare('SELECT dirty FROM temp.solomap_checkpoint_journal_watches WHERE token=?');
    try{statement.bind([token]);return statement.step() && statement.getAsObject().dirty===0;}finally{statement.free();}
  }
  public release(token:string):void {
    this.releaseFailure=undefined;
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return;}
    this.retired.add(token);
    try{this.database.run('DELETE FROM temp.solomap_checkpoint_log_watches WHERE token=?',[token]);this.database.run('DELETE FROM temp.solomap_checkpoint_journal_watches WHERE token=?',[token]);this.retired.delete(token);this.reported.delete(token);}
    catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap checkpoint proof release pending: ${String(error)}\n`);this.reported.add(token);}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}
    if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.release(token);
    if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size>0;
  }
}
