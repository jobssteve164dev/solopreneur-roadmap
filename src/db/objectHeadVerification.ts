import { randomUUID } from 'crypto';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';

export interface ObjectRevisionVerification {
  objectId:string;revision:number;contentId:string;sha256:string;
}
export interface ObjectHeadObservation {
  id:string;revision:number|null;
  content?:{table:string;column:string;contentId:string|null};
  legacyEventMapping?:{identity:string|null;key:string;objectId:string|null;revision:number|null};
}
/** Source-local proof for heads observed by Compute, including absent objects. */
export class ObjectHeadVerification {
  private initialized = false;
  private revisionsInitialized=false;
  private legacyMappingsInitialized=false;
  private readonly entities=new Set<string>();
  private readonly retired = new Set<string>();
  private releaseFailure: unknown;
  private readonly reportedFailures = new Set<string>();
  constructor(private readonly database: DiskDatabase) {}
  private rows(sql: string, values: SqlValue[] = []): Array<Record<string, SqlValue>> {
    const statement = this.database.prepare(sql), result: Array<Record<string, SqlValue>> = [];
    try { statement.bind(values); while (statement.step()) result.push(statement.getAsObject()); return result; }
    finally { statement.free(); }
  }
  public bootstrap(): void {
    if (this.initialized) return;
    if (this.database.inTransaction) throw new Error('content_verification_transaction_active');
    this.database.run('SAVEPOINT solomap_object_head_bootstrap');
    try {
    this.database.run(`CREATE TEMP TABLE solomap_object_head_watches(
      token TEXT NOT NULL,object_id TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
      PRIMARY KEY(token,object_id)) WITHOUT ROWID`);
    this.database.run('CREATE INDEX temp.solomap_object_head_dirty ON solomap_object_head_watches(token,dirty)');
    this.database.run('CREATE INDEX temp.solomap_object_head_target ON solomap_object_head_watches(object_id,dirty)');
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const keys = action === 'UPDATE' ? 'OLD.id,NEW.id' : `${action === 'DELETE' ? 'OLD' : 'NEW'}.id`;
      this.database.run(`CREATE TEMP TRIGGER solomap_object_head_${action.toLowerCase()}
        AFTER ${action} ON main.objects BEGIN
        UPDATE solomap_object_head_watches SET dirty=1 WHERE object_id IN (${keys}) AND dirty=0;
      END`);
    }
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const keys = action === 'UPDATE' ? 'OLD.source_id,NEW.source_id' : `${action === 'DELETE' ? 'OLD' : 'NEW'}.source_id`;
      this.database.run(`CREATE TEMP TRIGGER solomap_object_relations_${action.toLowerCase()}
        AFTER ${action} ON main.relations BEGIN
        UPDATE solomap_object_head_watches SET dirty=1 WHERE object_id IN (${keys}) AND dirty=0;
      END`);
    }
      this.database.run('RELEASE solomap_object_head_bootstrap');
      this.initialized = true;
    } catch (error) {
      try {
        this.database.run('ROLLBACK TO solomap_object_head_bootstrap');
        this.database.run('RELEASE solomap_object_head_bootstrap');
      } catch { /* Preserve the original storage failure. */ }
      throw error;
    }
  }
  public token(): string { this.bootstrap(); this.flushRetired(); return randomUUID(); }
  public prepareEntity(table:string,column='id'):void {
    if(!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column))throw new Error('object_head_verification_table_invalid');
    this.bootstrap();const identity=`${table}_${column}`;if(this.entities.has(identity))return;
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.database.run('SAVEPOINT solomap_entity_watch_bootstrap');
    try{
      for(const action of ['INSERT','UPDATE','DELETE']){
        const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
        this.database.run(`CREATE TEMP TRIGGER solomap_object_entity_${identity}_${action.toLowerCase()} AFTER ${action} ON main.${table} BEGIN ${sides.map(side=>`UPDATE solomap_object_head_watches SET dirty=1 WHERE object_id=${side}.${column} AND dirty=0;`).join(' ')} END`);
      }
      this.database.run('RELEASE solomap_entity_watch_bootstrap');this.entities.add(identity);
    }catch(error){this.database.run('ROLLBACK TO solomap_entity_watch_bootstrap');this.database.run('RELEASE solomap_entity_watch_bootstrap');throw error;}
  }
  public prepareRevisions():void {
    this.bootstrap();if(this.revisionsInitialized)return;
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.database.run('SAVEPOINT solomap_revision_map_bootstrap');
    try{
      this.database.run('CREATE TEMP TABLE solomap_object_revision_watches(token TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),PRIMARY KEY(token,object_id,revision)) WITHOUT ROWID');
      this.database.run('CREATE INDEX temp.solomap_object_revision_dirty ON solomap_object_revision_watches(token,dirty)');
      this.database.run('CREATE INDEX temp.solomap_object_revision_target ON solomap_object_revision_watches(object_id,revision,dirty)');
      for(const action of ['INSERT','UPDATE','DELETE']){
        const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
        this.database.run(`CREATE TEMP TRIGGER solomap_object_revision_${action.toLowerCase()} AFTER ${action} ON main.object_revisions BEGIN ${sides.map(side=>`UPDATE solomap_object_revision_watches SET dirty=1 WHERE object_id=${side}.object_id AND revision=${side}.revision AND dirty=0;`).join(' ')} END`);
      }
      this.database.run('RELEASE solomap_revision_map_bootstrap');this.revisionsInitialized=true;
    }catch(error){this.database.run('ROLLBACK TO solomap_revision_map_bootstrap');this.database.run('RELEASE solomap_revision_map_bootstrap');throw error;}
  }
  public registerRevisions(token:string,revisions:ReadonlyArray<ObjectRevisionVerification>):void {
    if(!this.revisionsInitialized || !this.database.inTransaction || revisions.length>128)throw new Error('object_head_verification_batch_invalid');
    for(const value of revisions)this.database.run(`INSERT INTO temp.solomap_object_revision_watches
      SELECT ?,?,?,CASE WHEN EXISTS(SELECT 1 FROM main.object_revisions r JOIN main.contents c ON c.id=r.content_id WHERE r.object_id=? AND r.revision=? AND r.content_id=? AND c.sha256=?) THEN 0 ELSE 1 END
      ON CONFLICT(token,object_id,revision) DO UPDATE SET dirty=MAX(solomap_object_revision_watches.dirty,excluded.dirty)`,
    [token,value.objectId,value.revision,value.objectId,value.revision,value.contentId,value.sha256]);
  }
  public register(token: string, heads: ReadonlyArray<ObjectHeadObservation>): void {
    if (!this.initialized || !this.database.inTransaction || heads.length > 128) throw new Error('object_head_verification_batch_invalid');
    for (const head of heads){
      if(head.content && (!/^[a-z_]+$/.test(head.content.table) || !/^[a-z_]+$/.test(head.content.column)))throw new Error('object_head_verification_table_invalid');
      this.database.run(`INSERT INTO temp.solomap_object_head_watches
      SELECT ?,?,CASE WHEN (SELECT revision FROM main.objects WHERE id=?) IS ?${head.content?` AND (SELECT ${head.content.column} FROM main.${head.content.table} WHERE id=?) IS ?`:''} THEN 0 ELSE 1 END
      ON CONFLICT(token,object_id) DO UPDATE SET dirty=MAX(solomap_object_head_watches.dirty,excluded.dirty)`,
      [token,head.id,head.id,head.revision,...(head.content?[head.id,head.content.contentId]:[])]);
      if(head.legacyEventMapping){
        if(!this.legacyMappingsInitialized)throw new Error('object_head_verification_mapping_unprepared');
        const mapping=head.legacyEventMapping;
        this.database.run(`INSERT INTO temp.solomap_legacy_event_mapping_watches VALUES(?,?,?,?,?) ON CONFLICT(token,lesson_id,source_key) DO UPDATE SET dirty=MAX(solomap_legacy_event_mapping_watches.dirty,excluded.dirty)`,[token,head.id,mapping.identity,mapping.key,this.legacyEventMappingCurrent(head)?0:1]);
      }
    }
  }
  public prepareLegacyEventMappings():void {
    this.bootstrap();if(this.legacyMappingsInitialized)return;
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.database.run('SAVEPOINT solomap_legacy_event_mapping_bootstrap');
    try{
      this.database.run('CREATE TEMP TABLE solomap_legacy_event_mapping_watches(token TEXT NOT NULL,lesson_id TEXT NOT NULL,source_identity TEXT,source_key TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),PRIMARY KEY(token,lesson_id,source_key)) WITHOUT ROWID');
      this.database.run('CREATE INDEX temp.solomap_legacy_event_mapping_dirty ON solomap_legacy_event_mapping_watches(token,dirty)');
      this.database.run('CREATE INDEX temp.solomap_legacy_event_mapping_source ON solomap_legacy_event_mapping_watches(source_identity,source_key,dirty)');
      this.database.run('CREATE INDEX temp.solomap_legacy_event_mapping_lesson ON solomap_legacy_event_mapping_watches(lesson_id,dirty)');
      for(const action of ['INSERT','UPDATE','DELETE']){
        const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
        this.database.run(`CREATE TEMP TRIGGER solomap_legacy_event_mapping_source_${action.toLowerCase()} AFTER ${action} ON main.migration_items ${action==='UPDATE'?'WHEN OLD.source_identity IS NOT NEW.source_identity OR OLD.source_key IS NOT NEW.source_key OR OLD.object_id IS NOT NEW.object_id OR OLD.imported_revision IS NOT NEW.imported_revision':''} BEGIN ${sides.map(side=>`UPDATE solomap_legacy_event_mapping_watches SET dirty=1 WHERE source_identity=${side}.source_identity AND source_key=${side}.source_key AND dirty=0;`).join(' ')} END`);
        this.database.run(`CREATE TEMP TRIGGER solomap_legacy_event_mapping_lesson_${action.toLowerCase()} AFTER ${action} ON main.legacy_lesson_sources ${action==='UPDATE'?'WHEN OLD.source_identity IS NOT NEW.source_identity OR OLD.object_id IS NOT NEW.object_id':''} BEGIN ${sides.map(side=>`UPDATE solomap_legacy_event_mapping_watches SET dirty=1 WHERE lesson_id=${side}.object_id AND dirty=0;`).join(' ')} END`);
      }
      this.database.run('RELEASE solomap_legacy_event_mapping_bootstrap');this.legacyMappingsInitialized=true;
    }catch(error){this.database.run('ROLLBACK TO solomap_legacy_event_mapping_bootstrap');this.database.run('RELEASE solomap_legacy_event_mapping_bootstrap');throw error;}
  }
  public legacyEventMappingCurrent(head:ObjectHeadObservation):boolean {
    const expected=head.legacyEventMapping;if(!expected)return true;
    const actual=this.rows("SELECT l.source_identity || ':event' AS identity,e.object_id,e.imported_revision FROM main.legacy_lesson_sources l LEFT JOIN main.migration_items e ON e.source_identity=l.source_identity || ':event' AND e.source_key=? WHERE l.object_id=?",[expected.key,head.id])[0];
    return(actual?String(actual.identity):null)===expected.identity && (actual?.object_id==null?null:String(actual.object_id))===expected.objectId && (actual?.imported_revision==null?null:Number(actual.imported_revision))===expected.revision;
  }
  public unchanged(token: string): boolean {
    return this.database.isOpen && !this.rows(`SELECT 1 FROM temp.solomap_object_head_watches WHERE token=? AND dirty=1${this.revisionsInitialized?' UNION ALL SELECT 1 FROM temp.solomap_object_revision_watches WHERE token=? AND dirty=1':''}${this.legacyMappingsInitialized?' UNION ALL SELECT 1 FROM temp.solomap_legacy_event_mapping_watches WHERE token=? AND dirty=1':''} LIMIT 1`,[token,...(this.revisionsInitialized?[token]:[]),...(this.legacyMappingsInitialized?[token]:[])]).length;
  }
  public releaseBatch(token: string): boolean {
    this.releaseFailure=undefined;
    if (!this.database.isOpen) { this.retired.clear(); return false; }
    this.retired.add(token);
    try {
      this.database.run(`DELETE FROM temp.solomap_object_head_watches WHERE token=? AND object_id IN
        (SELECT object_id FROM temp.solomap_object_head_watches WHERE token=? LIMIT 128)`, [token, token]);
      let remaining=128-this.database.getRowsModified();
      if(this.revisionsInitialized && remaining>0){this.database.run(`DELETE FROM temp.solomap_object_revision_watches WHERE token=? AND (object_id,revision) IN (SELECT object_id,revision FROM temp.solomap_object_revision_watches WHERE token=? LIMIT ?)`,[token,token,remaining]);remaining-=this.database.getRowsModified();}
      if(this.legacyMappingsInitialized && remaining>0)this.database.run('DELETE FROM temp.solomap_legacy_event_mapping_watches WHERE token=? AND (lesson_id,source_key) IN (SELECT lesson_id,source_key FROM temp.solomap_legacy_event_mapping_watches WHERE token=? LIMIT ?)',[token,token,remaining]);
      const pending = this.rows(`SELECT 1 FROM temp.solomap_object_head_watches WHERE token=?${this.revisionsInitialized?' UNION ALL SELECT 1 FROM temp.solomap_object_revision_watches WHERE token=?':''}${this.legacyMappingsInitialized?' UNION ALL SELECT 1 FROM temp.solomap_legacy_event_mapping_watches WHERE token=?':''} LIMIT 1`,[token,...(this.revisionsInitialized?[token]:[]),...(this.legacyMappingsInitialized?[token]:[])]).length > 0;
      this.retired.delete(token); if (pending) this.retired.add(token);
      this.reportedFailures.delete(token);
      return pending;
    } catch (error) {
      // Cleanup must not replace the accepted operation's result or original error.
      this.retired.delete(token); this.retired.add(token);
      this.releaseFailure=error;
      if(!this.reportedFailures.has(token))process.stderr.write(`SoloMap object proof release pending: ${String(error)}\n`);
      this.reportedFailures.add(token);
      return false;
    }
  }
  public flushRetired(throwOnFailure=false): boolean {
    if(!this.database.isOpen){this.retired.clear();this.reportedFailures.clear();return false;}
    if (this.database.inTransaction) return this.retired.size > 0;
    const token = this.retired.values().next().value;
    if (token !== undefined) this.releaseBatch(token);
    if(token!==undefined && throwOnFailure && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size > 0;
  }
}
