import * as crypto from 'crypto';

export interface ExternalMemoryEntry {
  entryId: string;
  scope: 'project' | 'global';
  scopeId: string;
  layer: string | null;
  category: string;
  status: string;
  title: string;
  content: string;
  revision: number;
  canonicalHash: string;
  validFrom: number | null;
  validUntil: number | null;
  tags: unknown[];
  provenance: Record<string, unknown>;
  validity: Record<string, unknown>;
  supersedes: unknown[];
  metadata: Record<string, unknown>;
}

export function canonicalExternalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalExternalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonicalExternalJson(item)).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_external_memory');
  return encoded;
}

function optionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_external_memory');
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('invalid_external_memory');
  return value;
}

function timestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('external_memory_validity_invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('external_memory_validity_invalid');
  return parsed;
}

export function parseExternalMemoryEntry(value: unknown): ExternalMemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_external_memory');
  const entry = value as Record<string, unknown>;
  const compact = entry.objectType === undefined;
  const entryId = String(entry.entryId || entry.memoryId || entry.id || '');
  const revision = entry.revision === undefined && compact ? 1 : Number(entry.revision);
  if (entry.schemaVersion !== 1 || (!compact && entry.objectType !== 'memory_entry') || !entryId ||
      typeof entry.scopeId !== 'string' || typeof entry.kind !== 'string' || !entry.kind ||
      typeof entry.status !== 'string' || !entry.status || typeof entry.title !== 'string' ||
      typeof entry.content !== 'string' || !Number.isInteger(revision) || revision < 1 ||
      typeof entry.canonicalHash !== 'string') throw new Error('invalid_external_memory');
  const scope = entry.scopeId === 'memory_scope:global' ? 'global'
    : entry.scopeId.startsWith('memory_scope:project:') && entry.scopeId.length > 'memory_scope:project:'.length ? 'project'
      : null;
  if (!scope) throw new Error('external_memory_scope_invalid');
  const { canonicalHash, ...withoutHash } = entry;
  const expectedHash = `sha256:${crypto.createHash('sha256').update(canonicalExternalJson(withoutHash)).digest('hex')}`;
  if (canonicalHash !== expectedHash) throw new Error('external_memory_hash_mismatch');
  const validity = optionalObject(entry.validity);
  const validFrom = timestamp(validity.validFrom);
  const validUntil = timestamp(validity.validUntil);
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw new Error('external_memory_validity_invalid');
  const category = ({ project_fact: 'project', operating_rule: 'rules' } as Record<string, string>)[entry.kind] || String(entry.kind);
  return {
    entryId, scope, scopeId: entry.scopeId, layer: typeof entry.layer === 'string' ? entry.layer : null,
    category, status: entry.status, title: entry.title, content: entry.content, revision,
    canonicalHash, validFrom, validUntil, tags: optionalArray(entry.tags),
    provenance: optionalObject(entry.provenance), validity,
    supersedes: optionalArray(entry.supersedes), metadata: optionalObject(entry.metadata)
  };
}
