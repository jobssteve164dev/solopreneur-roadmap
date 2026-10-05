import { entityDefinitions } from './unifiedSchema';

export interface DataField { type: 'text' | 'number' | 'json' | 'content'; required: boolean; nullable: boolean; reference?: string }

export function dataSchema(): { schemaVersion: number; kinds: Record<string, { project: boolean; fields: Record<string, DataField> }> } {
  const kinds: Record<string, { project: boolean; fields: Record<string, DataField> }> = {};
  for (const [kind, definition] of Object.entries(entityDefinitions)) {
    const fields: Record<string, DataField> = {};
    const column = /(?:^|,)\s*([a-z_]+)\s+(TEXT|REAL|INTEGER)([^,]*)/g;
    for (const match of definition.columns.matchAll(column)) {
      const name = match[1];
      if (name === 'secret_ref') continue;
      const content = name === 'content_id' || name.endsWith('_content_id');
      const key = content ? name.slice(0, -3) : name;
      const nullable = !match[3].includes('NOT NULL');
      const reference = /REFERENCES ([a-z_]+)\(id\)/.exec(match[3])?.[1];
      fields[key] = { type: content ? 'content' : name.endsWith('_json') ? 'json' : match[2] === 'TEXT' ? 'text' : 'number', required: !nullable && !match[3].includes('DEFAULT'), nullable, ...(reference ? { reference } : {}) };
    }
    kinds[kind] = { project: definition.project, fields };
  }
  return { schemaVersion: 1, kinds };
}
