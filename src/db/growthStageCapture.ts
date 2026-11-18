import { DiskDatabase, type SqlValue } from './diskDatabase.js';
import type { GrowthSnapshotStageManifest, GrowthSnapshotStageSection } from './types.js';

/** A copy of actual Source TEMP rows for validation only; never a business transaction planner. */
export class GrowthStageCapture {
  private readonly database:DiskDatabase;
  private readonly manifest:GrowthSnapshotStageManifest;
  private validated=false;
  constructor(private readonly stageId:string,staged:Record<string,SqlValue>) {
    const manifest = JSON.parse(String(staged.manifest_json)) as GrowthSnapshotStageManifest;
    if (manifest.stageId !== stageId || !/^[a-f0-9]{64}$/.test(manifest.payloadHash) || !/^[a-f0-9]{64}$/.test(manifest.semanticHash)
      || !/^[a-f0-9]{64}$/.test(manifest.sourceVersion.contentHash)) throw new Error('growth_refresh_stage_invalid');
    this.manifest=manifest;
    this.database=new DiskDatabase(':memory:');
    try{
      this.database.run('CREATE TABLE runtime_growth_refresh_stage_items(stage_id TEXT NOT NULL,section TEXT NOT NULL,ordinal INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(stage_id,section,ordinal))');
      this.database.run("CREATE INDEX runtime_growth_refresh_stage_node_identity ON runtime_growth_refresh_stage_items(stage_id,section,json_extract(payload_json,'$.nodeId'))");
    }catch(error){this.database.close();throw error;}
  }
  private rows(sql:string,values:SqlValue[]=[]):Array<Record<string,SqlValue>> {
    const statement=this.database.prepare(sql),rows:Array<Record<string,SqlValue>>=[];
    try{statement.bind(values);while(statement.step())rows.push(statement.getAsObject());return rows;}finally{statement.free();}
  }
  public append(section:GrowthSnapshotStageSection,rows:ReadonlyArray<{ordinal:SqlValue;payload_json:SqlValue}>):void {
    if(this.validated || !['nodes','edges','signals','labels'].includes(section) || rows.length>128)throw new Error('growth_refresh_stage_capture_invalid');
    for(const row of rows)this.database.run('INSERT INTO runtime_growth_refresh_stage_items VALUES(?,?,?,?)',[this.stageId,section,row.ordinal,row.payload_json]);
  }
  public validate():GrowthSnapshotStageManifest {
    if(this.validated)return this.manifest;
    const stageId=this.stageId,manifest=this.manifest;
    for (const section of ['nodes', 'edges', 'signals', 'labels'] as GrowthSnapshotStageSection[]) {
      const count = Number(this.rows('SELECT COUNT(*) AS count FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section=?', [stageId, section])[0].count);
      if (count !== manifest.counts[section]) throw new Error(`growth_refresh_stage_incomplete:${section}`);
      if (count) {
        const range = this.rows('SELECT MIN(ordinal) AS minimum,MAX(ordinal) AS maximum FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section=?', [stageId, section])[0];
        if (Number(range.minimum) !== 0 || Number(range.maximum) !== count - 1) throw new Error(`growth_refresh_stage_order_invalid:${section}`);
      }
    }
    const parentByNode = new Map<string, string>();
    for (const row of this.rows(`SELECT json_extract(payload_json,'$.nodeId') AS node_id,
      COALESCE(json_extract(payload_json,'$.parentId'),'') AS parent_id
      FROM runtime_growth_refresh_stage_items WHERE stage_id=? AND section='nodes' ORDER BY ordinal`, [stageId])) {
      const nodeId = String(row.node_id ?? ''), parentId = String(row.parent_id ?? '');
      if (parentByNode.has(nodeId)) throw new Error('growth_node_duplicate');
      parentByNode.set(nodeId, parentId);
    }
    for (const parentId of parentByNode.values()) {
      if (parentId && !parentByNode.has(parentId)) throw new Error('growth_parent_missing');
    }
    const visitState = new Map<string, 1 | 2>();
    for (const nodeId of parentByNode.keys()) {
      if (visitState.get(nodeId) === 2) continue;
      const chain: string[] = [];
      let current = nodeId;
      while (current && visitState.get(current) !== 2) {
        if (visitState.get(current) === 1) throw new Error('growth_parent_cycle');
        visitState.set(current, 1);
        chain.push(current);
        current = parentByNode.get(current) || '';
      }
      for (const visited of chain) visitState.set(visited, 2);
    }
    for (const section of ['edges', 'signals', 'labels'] as const) {
      const sourceFields = section === 'edges' ? ['sourceId', 'targetId'] : [section === 'signals' ? 'nodeId' : 'nodeId'];
      for (const field of sourceFields) {
        if (this.rows(`SELECT 1 FROM runtime_growth_refresh_stage_items item LEFT JOIN runtime_growth_refresh_stage_items node
          ON node.stage_id=item.stage_id AND node.section='nodes' AND json_extract(node.payload_json,'$.nodeId')=json_extract(item.payload_json,?)
          WHERE item.stage_id=? AND item.section=? AND node.ordinal IS NULL LIMIT 1`, [`$.${field}`, stageId, section])[0]) throw new Error(`growth_${section}_node_missing`);
      }
    }
    this.validated=true;return manifest;
  }
  public close():void {if(this.database.isOpen)this.database.close();}
}
