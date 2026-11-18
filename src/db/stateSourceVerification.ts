import { randomUUID } from 'crypto';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';
import type { StateSourceProject } from './stateWritePublication.js';

/** Actual source membership and project counters consumed by a guarded daily save. */
export class StateSourceVerification {
  private initialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  private rows(sql:string,values:SqlValue[]=[]):Array<Record<string,SqlValue>> {
    const statement=this.database.prepare(sql),result:Array<Record<string,SqlValue>>=[];
    try{statement.bind(values);while(statement.step())result.push(statement.getAsObject());return result;}finally{statement.free();}
  }
  public begin(learning:boolean):string {
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    if(!this.initialized){
      this.database.run('SAVEPOINT solomap_state_source_bootstrap');
      try{
        this.database.run('CREATE TEMP TABLE solomap_state_source_watches(token TEXT PRIMARY KEY,learning INTEGER NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1))) WITHOUT ROWID');
        this.database.run('CREATE INDEX temp.solomap_state_source_learning ON solomap_state_source_watches(learning,dirty)');
        this.database.run('CREATE TEMP TABLE solomap_state_source_projects(token TEXT NOT NULL,project_id TEXT NOT NULL,mode TEXT NOT NULL,PRIMARY KEY(token,project_id,mode)) WITHOUT ROWID');
        this.database.run('CREATE INDEX temp.solomap_state_source_project ON solomap_state_source_projects(project_id,mode,token)');
        for(const action of ['INSERT','UPDATE','DELETE']){
          const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
          for(const table of ['learning_events','lessons','lesson_decisions'])this.database.run(`CREATE TEMP TRIGGER solomap_state_source_${table}_${action.toLowerCase()} AFTER ${action} ON main.${table} ${action==='UPDATE'?'WHEN OLD.id IS NOT NEW.id':''} BEGIN UPDATE solomap_state_source_watches SET dirty=1 WHERE learning=1 AND dirty=0; END`);
          const member=sides.map(side=>['learning_events','lessons','lesson_decisions'].map(table=>`EXISTS(SELECT 1 FROM main.${table} d WHERE d.id=${side}.id)`).join(' OR ')).join(' OR ');
          this.database.run(`CREATE TEMP TRIGGER solomap_state_source_objects_${action.toLowerCase()} AFTER ${action} ON main.objects ${action==='UPDATE'?'WHEN OLD.id IS NOT NEW.id OR OLD.revision IS NOT NEW.revision OR OLD.archived_at IS NOT NEW.archived_at OR OLD.project_id IS NOT NEW.project_id':''} BEGIN
            UPDATE solomap_state_source_watches SET dirty=1 WHERE learning=1 AND dirty=0 AND (${member});
            UPDATE solomap_state_source_watches SET dirty=1 WHERE dirty=0 AND token IN (SELECT p.token FROM solomap_state_source_projects p JOIN main.settings s ON s.owner_scope=p.project_id AND s.namespace='strategy' AND s.key='preferences' WHERE p.mode='strategy' AND s.id IN (${sides.map(side=>`${side}.id`).join(',')}));
          END`);
          this.database.run(`CREATE TEMP TRIGGER solomap_state_source_settings_${action.toLowerCase()} AFTER ${action} ON main.settings ${action==='UPDATE'?'WHEN OLD.id IS NOT NEW.id OR OLD.namespace IS NOT NEW.namespace OR OLD.key IS NOT NEW.key OR OLD.owner_scope IS NOT NEW.owner_scope':''} BEGIN ${sides.map(side=>`UPDATE solomap_state_source_watches SET dirty=1 WHERE dirty=0 AND ${side}.namespace='strategy' AND ${side}.key='preferences' AND token IN (SELECT token FROM solomap_state_source_projects WHERE project_id=${side}.owner_scope AND mode='strategy');`).join(' ')} END`);
          this.database.run(`CREATE TEMP TRIGGER solomap_state_source_counters_${action.toLowerCase()} AFTER ${action} ON main.project_analysis_sources BEGIN ${sides.map(side=>`UPDATE solomap_state_source_watches SET dirty=1 WHERE dirty=0 AND token IN (SELECT token FROM solomap_state_source_projects WHERE project_id=${side}.project_id ${action==='UPDATE'?"AND (OLD.project_id IS NOT NEW.project_id OR (mode='conversation' AND OLD.conversation_revision IS NOT NEW.conversation_revision) OR (mode='strategy' AND OLD.run_index_revision IS NOT NEW.run_index_revision))":''});`).join(' ')} END`);
        }
        this.database.run('RELEASE solomap_state_source_bootstrap');this.initialized=true;
      }catch(error){this.database.run('ROLLBACK TO solomap_state_source_bootstrap');this.database.run('RELEASE solomap_state_source_bootstrap');throw error;}
    }
    this.flushRetired();const token=randomUUID();this.database.run('INSERT INTO temp.solomap_state_source_watches VALUES(?,?,0)',[token,learning?1:0]);return token;
  }
  public register(token:string,projects:ReadonlyArray<StateSourceProject>):void {
    if(!this.database.inTransaction || projects.length>128)throw new Error('state_source_verification_batch_invalid');
    for(const project of projects){
      this.database.run('INSERT OR IGNORE INTO temp.solomap_state_source_projects VALUES(?,?,?)',[token,project.projectId,project.mode]);
      const counter=project.mode==='conversation'?'conversation_revision':'run_index_revision';
      let matches=this.rows(`SELECT 1 FROM main.project_analysis_sources WHERE project_id=? AND ${counter} IS ?`,[project.projectId,project.revision]).length>0;
      if(project.revision===null && !this.rows('SELECT 1 FROM main.project_analysis_sources WHERE project_id=?',[project.projectId]).length)matches=true;
      if(project.mode==='strategy'){
        const choice=this.rows("SELECT s.id,o.revision FROM main.settings s JOIN main.objects o ON o.id=s.id WHERE s.namespace='strategy' AND s.key='preferences' AND s.owner_scope=? AND o.project_id=? AND o.archived_at IS NULL",[project.projectId,project.projectId])[0];
        matches &&= (choice?.id ?? null)===(project.preferenceId ?? null) && (choice?.revision ?? null)===(project.preferenceRevision ?? null);
      }
      if(!matches)this.database.run('UPDATE temp.solomap_state_source_watches SET dirty=1 WHERE token=?',[token]);
    }
  }
  public current(token:string):boolean {return this.database.isOpen && this.rows('SELECT dirty FROM temp.solomap_state_source_watches WHERE token=?',[token])[0]?.dirty===0;}
  public releaseBatch(token:string):boolean {
    this.releaseFailure=undefined;if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}this.retired.add(token);
    try{
      this.database.run('DELETE FROM temp.solomap_state_source_projects WHERE token=? AND (project_id,mode) IN (SELECT project_id,mode FROM temp.solomap_state_source_projects WHERE token=? LIMIT 128)',[token,token]);
      const pending=this.rows('SELECT 1 FROM temp.solomap_state_source_projects WHERE token=? LIMIT 1',[token]).length>0;
      if(!pending){this.database.run('DELETE FROM temp.solomap_state_source_watches WHERE token=?',[token]);this.retired.delete(token);}this.reported.delete(token);return pending;
    }catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap state source proof release pending: ${String(error)}\n`);this.reported.add(token);return false;}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.releaseBatch(token);if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;return this.retired.size>0;
  }
}
