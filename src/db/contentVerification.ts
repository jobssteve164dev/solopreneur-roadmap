import { randomUUID } from 'crypto';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';

export interface ContentVerificationIdentity {
  contentId: string; sha256: string; mimeType: string; baseEncoding: string; byteLength: number;
}
export interface ContentVerificationRequest extends ContentVerificationIdentity {
  databaseId: string; incarnation: string; token: string; sourceDevice: string; sourceInode: string;
}
export type ContentVerificationProof = ContentVerificationRequest;
export interface ContentVerificationWatch {
  contentId: string; token: string; dataVersion: number; schemaCookie: number; tempSchemaCookie: number;
}
export type ContentVerificationQualification = Pick<ContentVerificationWatch,'dataVersion' | 'schemaCookie' | 'tempSchemaCookie'>;
export type ContentVerificationGroup = ContentVerificationQualification & {token:string};

const table='solomap_content_verification_watches';
const triggerDefinitions: Array<{name: string; sql: string}> = [];
for(const [source,key] of [['contents','id'],['content_chunks','content_id']]) for(const action of ['INSERT','UPDATE','DELETE']){
  const name=`solomap_verify_${source}_${action.toLowerCase()}`;
  const ids=action==='INSERT'?`content_id=NEW.${key}`:action==='DELETE'?`content_id=OLD.${key}`:`(content_id=OLD.${key} OR content_id=NEW.${key})`;
  triggerDefinitions.push({name,sql:`CREATE TEMP TRIGGER IF NOT EXISTS ${name} AFTER ${action} ON main.${source}
    BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0 AND ${ids}; END`});
}

/** A transient qualification on this Writer connection, never a content root. */
export class ContentVerificationWatches {
  private cookie: number | undefined;
  private readonly retired=new Map<string,ContentVerificationWatch>();
  private readonly triggerSql=new Map<string,string>();
  constructor(private readonly database: DiskDatabase) {}
  private rows(sql: string,values: SqlValue[]=[]): Array<Record<string,SqlValue>> {
    const statement=this.database.prepare(sql),result: Array<Record<string,SqlValue>>=[];
    try{statement.bind(values);while(statement.step())result.push(statement.getAsObject());return result;}
    finally{statement.free();}
  }
  private version(pragma: string): number {return Number(this.database.exec(`PRAGMA ${pragma}`)[0].values[0][0]);}
  public bootstrap(): void {
    if(!this.database.isOpen)throw new Error('prepared_content_owner_finished');
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.flushRetired();
    const cookie=this.version('temp.schema_version');
    if(this.cookie===cookie)return;
    const exists=this.rows("SELECT 1 FROM temp.sqlite_schema WHERE type='table' AND name=?",[table]).length>0;
    if(exists)this.database.run(`UPDATE temp.${table} SET dirty=1 WHERE dirty=0`);
    this.database.run(`CREATE TEMP TABLE IF NOT EXISTS ${table}(
      content_id TEXT NOT NULL,token TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),PRIMARY KEY(content_id,token)) WITHOUT ROWID`);
    this.database.run(`CREATE INDEX IF NOT EXISTS temp.solomap_verify_group_dirty ON ${table}(token,dirty)`);
    for(const definition of triggerDefinitions){
      const before=this.rows("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name=?",[definition.name])[0];
      if(before && this.triggerSql.has(definition.name) && this.triggerSql.get(definition.name)!==before.sql)throw new Error('content_verification_schema_changed');
      this.database.run(definition.sql);
      this.triggerSql.set(definition.name,String(this.rows("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name=?",[definition.name])[0].sql));
    }
    this.cookie=this.version('temp.schema_version');
    this.flushRetired();
  }
  public beginGroup():Readonly<ContentVerificationGroup> {
    return Object.freeze({token:randomUUID(),...this.qualification()});
  }
  public currentGroup(group:ContentVerificationGroup):boolean {
    return this.qualified(group) && this.rows(`SELECT 1 FROM temp.${table} WHERE token=? AND dirty=1 LIMIT 1`,[group.token]).length===0;
  }
  public begin(contentId: string,group?:ContentVerificationGroup): ContentVerificationWatch {
    this.bootstrap();
    const watch=group?{contentId,...group}:{contentId,token:randomUUID(),...this.qualification()};
    this.database.run(`INSERT ${group?'OR IGNORE ':''}INTO temp.${table} VALUES(?,?,0)`,[contentId,watch.token]);
    return watch;
  }
  public beginInTransaction(contentId: string): ContentVerificationWatch {
    if(!this.database.isOpen)throw new Error('prepared_content_owner_finished');
    if(!this.database.inTransaction || this.cookie===undefined || this.cookie!==this.version('temp.schema_version'))throw new Error('content_verification_transaction_active');
    const watch={contentId,token:randomUUID(),dataVersion:this.version('main.data_version'),schemaCookie:this.version('main.schema_version'),tempSchemaCookie:this.cookie};
    this.database.run(`INSERT INTO temp.${table} VALUES(?,?,0)`,[contentId,watch.token]);
    return watch;
  }
  public current(watch: ContentVerificationWatch): boolean {
    if(!this.qualified(watch))return false;
    return this.rows(`SELECT 1 FROM temp.${table} WHERE content_id=? AND token=? AND dirty=0`,[watch.contentId,watch.token]).length===1;
  }
  public qualification(): ContentVerificationQualification {
    this.bootstrap();return {dataVersion:this.version('main.data_version'),schemaCookie:this.version('main.schema_version'),tempSchemaCookie:this.version('temp.schema_version')};
  }
  public qualified(value: ContentVerificationQualification): boolean {
    return this.database.isOpen && value.schemaCookie===this.version('main.schema_version') && value.tempSchemaCookie===this.version('temp.schema_version') && value.dataVersion===this.version('main.data_version');
  }
  public release(watch: ContentVerificationWatch): void {
    if(!this.database.isOpen){this.retired.clear();return;}
    this.retired.set(`${watch.token}:${watch.contentId}`,watch);
    this.flushRetired();
  }
  public hasRetired():boolean {return this.retired.size>0;}
  public flushRetired(throwOnFailure=false): void {
    if(!this.database.isOpen){this.retired.clear();return;}
    if(!this.retired.size || this.database.inTransaction)return;
    let released=0;
    for(const [key,watch] of this.retired){
      if(released>=128)return;
      try{this.database.run(`DELETE FROM temp.${table} WHERE content_id=? AND token=?`,[watch.contentId,watch.token]);this.retired.delete(key);released++;}
      catch(error){if(throwOnFailure)throw error;return;} // Publication keeps its result; maintenance retries with its existing backoff.
    }
  }
}
