import { randomUUID } from 'crypto';
import type { DiskDatabase } from './diskDatabase.js';
import type { ExternalMemorySelection } from './externalMemoryPublication.js';

/** Source-local observation of the exact external identity or target collection. */
export class ExternalMemoryVerification {
  private initialized=false;
  private readonly retired=new Set<string>();
  private readonly reported=new Set<string>();
  private releaseFailure:unknown;
  constructor(private readonly database:DiskDatabase) {}
  public bootstrap():void {
    if(this.initialized)return;
    if(this.database.inTransaction)throw new Error('content_verification_transaction_active');
    this.database.run('SAVEPOINT solomap_external_memory_bootstrap');
    const matches=(source:string)=>`(source IS NOT NULL AND source=${source}) OR (project_prefix IS NOT NULL AND (substr(${source},1,length(project_prefix))=project_prefix OR substr(${source},1,length(global_prefix))=global_prefix))`;
    try{
      this.database.run('CREATE TEMP TABLE solomap_external_memory_watches(token TEXT PRIMARY KEY,source TEXT,project_prefix TEXT,global_prefix TEXT,dirty INTEGER NOT NULL CHECK(dirty IN (0,1))) WITHOUT ROWID');
      for(const action of ['INSERT','UPDATE','DELETE']){
        const sides=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
        this.database.run(`CREATE TEMP TRIGGER solomap_external_memory_${action.toLowerCase()} AFTER ${action} ON main.memories BEGIN ${sides.map(side=>`UPDATE solomap_external_memory_watches SET dirty=1 WHERE dirty=0 AND (${matches(`${side}.external_source`)});`).join(' ')} END`);
      }
      this.database.run(`CREATE TEMP TRIGGER solomap_external_memory_object_update AFTER UPDATE ON main.objects WHEN OLD.kind='memory' OR NEW.kind='memory' BEGIN UPDATE solomap_external_memory_watches SET dirty=1 WHERE dirty=0 AND EXISTS(SELECT 1 FROM main.memories m WHERE m.id IN (OLD.id,NEW.id) AND (${matches('m.external_source')})); END`);
      this.database.run('RELEASE solomap_external_memory_bootstrap');this.initialized=true;
    }catch(error){this.database.run('ROLLBACK TO solomap_external_memory_bootstrap');this.database.run('RELEASE solomap_external_memory_bootstrap');throw error;}
  }
  public begin(selection:ExternalMemorySelection):string {
    this.bootstrap();this.flushRetired();const token=randomUUID();
    this.database.run('INSERT INTO temp.solomap_external_memory_watches VALUES(?,?,?,?,0)',[token,'source' in selection?selection.source:null,'projectPrefix' in selection?selection.projectPrefix:null,'globalPrefix' in selection?selection.globalPrefix:null]);return token;
  }
  public current(token:string):boolean {
    if(!this.database.isOpen)return false;
    const statement=this.database.prepare('SELECT dirty FROM temp.solomap_external_memory_watches WHERE token=?');
    try{statement.bind([token]);return statement.step() && statement.getAsObject().dirty===0;}finally{statement.free();}
  }
  public release(token:string):void {
    this.releaseFailure=undefined;
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return;}
    this.retired.add(token);
    try{this.database.run('DELETE FROM temp.solomap_external_memory_watches WHERE token=?',[token]);this.retired.delete(token);this.reported.delete(token);}
    catch(error){this.releaseFailure=error;if(!this.reported.has(token))process.stderr.write(`SoloMap external memory proof release pending: ${String(error)}\n`);this.reported.add(token);}
  }
  public flushRetired(throwOnFailure=false):boolean {
    if(!this.database.isOpen){this.retired.clear();this.reported.clear();return false;}
    if(this.database.inTransaction)return this.retired.size>0;
    const token=this.retired.values().next().value;if(token!==undefined)this.release(token);
    if(throwOnFailure && token!==undefined && this.releaseFailure!==undefined)throw this.releaseFailure;
    return this.retired.size>0;
  }
}
