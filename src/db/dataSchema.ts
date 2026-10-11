import { additionalEntityColumns, unifiedSchemaMigrations, runtimeEntityDefinitions as entityDefinitions } from './unifiedSchemaMigrations';

export interface DataField {
  type: 'text' | 'number' | 'json' | 'content'; required: boolean; nullable: boolean; reference?: string;
  description?: string; integer?: boolean; minimum?: number; items?: Record<string, DataField>;
}

export function dataSchema(): { schemaVersion: number; kinds: Record<string, { project: boolean; fields: Record<string, DataField> }> } {
  const kinds: Record<string, { project: boolean; fields: Record<string, DataField> }> = {};
  for (const [kind, definition] of Object.entries(entityDefinitions)) {
    const fields: Record<string, DataField> = {};
    const column = /(?:^|,)\s*([a-z_]+)\s+(TEXT|REAL|INTEGER)([^,]*)/g;
    for (const match of (definition.columns + (additionalEntityColumns[kind] ? ', ' + additionalEntityColumns[kind] : '')).matchAll(column)) {
      const name = match[1];
      if (name === 'secret_ref') continue;
      const content = name === 'content_id' || name.endsWith('_content_id');
      const key = content ? name.slice(0, -3) : name;
      const nullable = !match[3].includes('NOT NULL');
      const reference = /REFERENCES ([a-z_]+)\(id\)/.exec(match[3])?.[1];
      fields[key] = { type: content ? 'content' : name.endsWith('_json') ? 'json' : match[2] === 'TEXT' ? 'text' : 'number', required: !nullable && !match[3].includes('DEFAULT'), nullable, ...(reference ? { reference } : {}) };
    }
    if (kind === 'lesson') fields.event_refs = {
      type: 'json', required: false, nullable: false, reference: 'learning_events',
      description: '按顺序提交完整固定事件来源列表。objectId 与 revision 同为 null 表示未知历史来源；已知事件须引用实际固定版本。保留的来源不因重排或增减其他来源而更新版本。source_event_ids_json 若同时提供，必须与列表的 sourceId 顺序一致。',
      items: {
        sourceId: { type: 'text', required: true, nullable: false, description: '原声明来源ID；新原生事件使用该事件的 objectId。' },
        objectId: { type: 'text', required: true, nullable: true, reference: 'learning_events' },
        revision: { type: 'number', required: true, nullable: true, integer: true, minimum: 1, description: '固定事件版本；仅未知历史来源与 objectId 同为 null。' }
      }
    };
    if (kind === 'lesson_decision') fields.candidate_refs = {
      type: 'json', required: false, nullable: false, reference: 'lessons',
      description: '宿主审核动作提交的完整固定候选列表。首项须与同时提供的 lesson_id/lesson_revision 一致；空列表清空引用。历史读取可能返回 revision=null，不能在新输入中伪造未知版本；普通 Agent 无审核决定写入权限。',
      items: {
        objectId: { type: 'text', required: true, nullable: false, reference: 'lessons' },
        revision: { type: 'number', required: true, nullable: false, integer: true, minimum: 1, description: '固定经验版本；读取时可能为 null 的历史关系只能原样继承。' }
      }
    };
    kinds[kind] = { project: definition.project, fields };
  }
  return { schemaVersion: unifiedSchemaMigrations.at(-1)?.version || 1, kinds };
}
