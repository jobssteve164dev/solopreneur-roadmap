import * as crypto from 'crypto';
import { types } from 'util';

export interface ContentReferenceSummary {
  ruleVersion: 1;
  sha256: string;
  byteLength: number;
  targets: readonly string[];
}

function referenceShape(key: string): 'single' | 'multiple' | 'source' | undefined {
  if (key === 'contentId' || key.endsWith('ContentId') || key === 'content_id' || key.endsWith('_content_id')) return 'single';
  if (key.endsWith('ContentIds') || key.endsWith('_content_ids')) return 'multiple';
  if (key === 'sourceContents') return 'source';
  return undefined;
}

export function collectContentReferences(value: unknown): string[] {
  const references: string[] = [];
  const pending: Array<{ value: unknown; reference?: boolean }> = [{ value }];
  while (pending.length) {
    const next = pending.pop()!, item = next.value;
    if (next.reference) { references.push(item as string); continue; }
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push({ value: item[index] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item).reverse()) {
      const shape = referenceShape(key);
      if (shape === 'single' && typeof child === 'string') pending.push({ value: child, reference: true });
      else if (shape === 'multiple' && Array.isArray(child)) {
        for (let index = child.length - 1; index >= 0; index--) if (typeof child[index] === 'string') pending.push({ value: child[index], reference: true });
      } else if (shape === 'source' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const value of Object.values(child).reverse()) if (typeof value === 'string') pending.push({ value, reference: true });
      } else pending.push({ value: child });
    }
  }
  return references;
}

type ReferenceMode = 'normal' | 'off' | 'single' | 'multiple' | 'source';
function encode(value: unknown, mode: ReferenceMode, targets?: Set<string>): string {
  if (typeof value === 'string' && mode === 'single') targets!.add(value);
  if (Array.isArray(value)) return '[' + value.map(item => encode(item,
    mode === 'normal' ? 'normal' : mode === 'multiple' && typeof item === 'string' ? 'single' : 'off', targets)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => {
      let childMode: ReferenceMode = 'off';
      if (mode === 'source' && typeof item === 'string') childMode = 'single';
      else if (mode === 'normal') {
        const shape = referenceShape(key);
        childMode = shape === 'single' && typeof item === 'string' ? 'single'
          : shape === 'multiple' && Array.isArray(item) ? 'multiple'
          : shape === 'source' && item && typeof item === 'object' && !Array.isArray(item) ? 'source' : 'normal';
      }
      return JSON.stringify(key) + ':' + encode(item, childMode, targets);
    }).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return encoded;
}

export function canonicalJson(value: unknown): string { return encode(value, 'off'); }

export function serializeContentWithReferences(value: unknown): { text: string; targets: string[] } {
  const targets = new Set<string>();
  const text = encode(value, 'normal', targets);
  return { text, targets: [...targets].sort() };
}

export function stringifyContentWithReferences(value: unknown): { text: string; targets: string[] } {
  const targets = new Set<string>(), modes = new WeakMap<object, ReferenceMode>();
  let root = true;
  const text = JSON.stringify(value, function(key: string, item: unknown): unknown {
    // JSON.stringify unboxes String objects after invoking its replacer. Do it
    // here once so the summary observes the same primitive as the final bytes.
    if (types.isStringObject(item)) item = String(item);
    const nativeJson = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean };
    const logical = nativeJson.isRawJSON?.(item) ? JSON.parse((item as { rawJSON: string }).rawJSON) as unknown : item;
    let mode: ReferenceMode = 'normal';
    if (root) root = false;
    else {
      const parentMode = modes.get(this) || 'normal';
      mode = 'off';
      if (Array.isArray(this)) {
        if (parentMode === 'normal') mode = 'normal';
        else if (parentMode === 'multiple' && typeof logical === 'string') mode = 'single';
      } else if (parentMode === 'source' && typeof logical === 'string') mode = 'single';
      else if (parentMode === 'normal') {
        const shape = referenceShape(key);
        mode = shape === 'single' && typeof logical === 'string' ? 'single'
          : shape === 'multiple' && Array.isArray(logical) ? 'multiple'
          : shape === 'source' && logical && typeof logical === 'object' && !Array.isArray(logical) ? 'source' : 'normal';
      }
    }
    if (mode === 'single') targets.add(logical as string);
    if (item !== null && typeof item === 'object') modes.set(item, mode);
    return item;
  });
  if (text === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return { text, targets: [...targets].sort() };
}

export function summarizeContentBytes(bytes: Uint8Array): ContentReferenceSummary {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let targets: string[] = [];
  let value: unknown;
  let start = 0;
  while (start < data.length && (data[start] === 0x20 || data[start] === 0x09 || data[start] === 0x0a || data[start] === 0x0d)) start++;
  // Only a JSON container can carry the interpreted reference keys.
  if (data[start] === 0x7b || data[start] === 0x5b) {
    try { value = JSON.parse(data.toString('utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  if (value !== undefined) targets = [...new Set(collectContentReferences(value))].sort();
  return { ruleVersion: 1, sha256: crypto.createHash('sha256').update(data).digest('hex'), byteLength: data.length, targets };
}
