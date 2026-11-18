import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';

/** Exact archive input keys, registered in bounded Source batches and retired by existing Cold work. */
export class ArchiveSourceVerification {
  private initialized=false;
  private readonly active=new Set<string>();
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public bootstrap():void {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_archive_source_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_archive_source_watches(token TEXT NOT NULL,kind INTEGER NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,c TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN(0,1)),PRIMARY KEY(token,kind,a,b,c)) WITHOUT ROWID');
        this.database.run('CREATE INDEX temp.solomap_archive_source_dirty ON solomap_archive_source_watches(token,dirty)');this.database.run('CREATE INDEX temp.solomap_archive_source_key ON solomap_archive_source_watches(kind,a,b,c,dirty)');
        for(const [kind,table,a,b,c] of [[0,'migration_items','source_identity','source_key',null],[1,'requests','actor_id','idempotency_key',null],[2,'legacy_lesson_sources','source_identity','project_id','legacy_lesson_id'],[3,'project_run_artifacts','project_id','execution_log_id','relative_path'],[4,'run_control','project_id','execution_log_id',null],[5,'log_chunks','run_id','stream',null],[6,'run_documents','run_id','purpose',null],[7,'legacy_report_turns','project_id','task_id','execution_log_id'],[8,'schedule_bindings',null,null,null],[9,'scheduled_occurrences','schedule_id',null,null],[10,'run_digest_sources','project_id','source_key',null],[11,'project_run_artifacts','project_id','execution_log_id',null],[12,'project_locations','project_id',null,null],[13,'run_digests','project_id','execution_log_id',null],[14,'project_locations',null,null,null],[15,'schedules',null,null,null],[16,'objects',null,null,null],[17,'roadmap_file_states','project_id',null,null],[18,'today_learning_revisions','scope_key',null,null],[19,'objects',null,null,null],[20,'growth_report_projection','project_id','key',null],[21,'project_run_indexes','project_id','execution_log_id',null],[22,'run_index_import_sources','project_id','execution_log_id',null],[23,'run_digest_index_sources','project_id','execution_log_id',null],[24,'scheduled_occurrences',null,null,null]] as const)for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          const key=(side:string)=>kind===7?`(${side}.execution_log_id || ':' || ${side}.legacy_sequence)`:c?`${side}.${c}`:"''";
          const filter=kind===16?'schedule':kind===19?'project':undefined;
          const actionColumns=kind===19 && action==='UPDATE'?'UPDATE OF archived_at,kind':action;
          const where=filter?` WHEN ${sides.map(side=>`${side}.kind='${filter}'`).join(' OR ')}`:'';
          const match=(side:string)=>kind===20?`${side}.key>'' AND ${side}.key LIKE b || '%'`:`b=${b?`${side}.${b}`:"''"}`;
          this.database.run(`CREATE TEMP TRIGGER solomap_archive_${table}_${kind}_${action.toLowerCase()} AFTER ${actionColumns} ON main.${table}${where} BEGIN ${sides.map(side=>`UPDATE solomap_archive_source_watches SET dirty=1 WHERE kind=${kind} AND a=${a?`${side}.${a}`:"''"} AND ${match(side)} AND c=${key(side)} AND dirty=0;`).join(' ')} END`);
        }
        this.database.run('RELEASE solomap_archive_source_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_archive_source_bootstrap');this.database.run('RELEASE solomap_archive_source_bootstrap');throw error;}
    }
  }
  public begin():string {
    this.bootstrap();
    this.flushRetired();const token=randomUUID();this.active.add(token);return token;
  }
  public register(token:string,kind:0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24,a:string,b:string,current:boolean,c=''):void {
    if(!this.active.has(token) || !this.database.inTransaction)throw new Error('archive_source_verification_batch_invalid');
    this.database.run('INSERT INTO temp.solomap_archive_source_watches VALUES(?,?,?,?,?,?) ON CONFLICT(token,kind,a,b,c) DO UPDATE SET dirty=MAX(solomap_archive_source_watches.dirty,excluded.dirty)',[token,kind,a,b,c,current?0:1]);
  }
  public current(token:string):boolean {
    if(!this.database.isOpen || !this.active.has(token))return false;const statement=this.database.prepare('SELECT 1 FROM temp.solomap_archive_source_watches WHERE token=? AND dirty=1 LIMIT 1');try{statement.bind([token]);return !statement.step();}finally{statement.free();}
  }
  private releaseBatch(token:string):boolean {
    this.releaseFailure=undefined;this.active.delete(token);
    if(!this.database.isOpen){this.active.clear();this.retired.clear();this.reported.clear();return false;}
    this.retired.add(token);
    try{
      this.database.run('DELETE FROM temp.solomap_archive_source_watches WHERE (token,kind,a,b,c) IN (SELECT token,kind,a,b,c FROM temp.solomap_archive_source_watches WHERE token=? LIMIT 128)',[token]);
      const statement=this.database.prepare('SELECT 1 FROM temp.solomap_archive_source_watches WHERE token=? LIMIT 1');let pending:boolean;try{statement.bind([token]);pending=statement.step();}finally{statement.free();}
      if(!pending){this.retired.delete(token);this.reported.delete(token);}return pending;
    }catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap archive source proof release pending: ${String(error)}\n`);this.reported.add(token);return false;}
  }
  public async release(token:string):Promise<void> {while(this.releaseBatch(token))await new Promise<void>(resolve=>setImmediate(resolve));}
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.active.clear();this.retired.clear();this.reported.clear();return false;}if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.releaseBatch(token);if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;return this.retired.size>0;
  }
}
