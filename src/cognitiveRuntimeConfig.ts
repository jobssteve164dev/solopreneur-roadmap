import * as crypto from 'crypto';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import type { RuntimeDataRequest } from './autonomousRuntimeControl';

export interface CognitiveRuntimeConfig {
  schemaVersion: 1;
  revision: string;
  mode: 'local_only' | 'agent_cli';
  agentCli: string;
  model: string;
}

type SettingItem = { key: string; revision: number; value?: unknown };
type CognitiveOperation = (request: RuntimeDataRequest) => Promise<unknown>;
const configs = new Map<string, CognitiveRuntimeConfig>();
const revisions = new Map<string, Map<string, number>>();

function normalizeConfig(value: Partial<CognitiveRuntimeConfig> | null | undefined): CognitiveRuntimeConfig {
  const agentCli = String(value?.agentCli || '').trim();
  const mode = value?.mode === 'agent_cli' && agentCli ? 'agent_cli' : 'local_only';
  return {
    schemaVersion: 1,
    revision: String(value?.revision || '').trim(),
    mode,
    agentCli: mode === 'agent_cli' ? agentCli : '',
    model: mode === 'agent_cli' ? (String(value?.model || '').trim() || 'auto') : 'auto'
  };
}

export function cognitiveRuntimeConfigRevision(value: CognitiveRuntimeConfig): string {
  return normalizeConfig(value).revision;
}

export function readCognitiveRuntimeConfig(globalDataPath: string): CognitiveRuntimeConfig {
  return configs.get(normalizeGlobalDataPathForExtension(globalDataPath)) || normalizeConfig(null);
}

export function writeCognitiveRuntimeConfig(globalDataPath: string, value: Partial<CognitiveRuntimeConfig>): CognitiveRuntimeConfig {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const requested = normalizeConfig(value);
  const current = readCognitiveRuntimeConfig(root);
  const unchanged = current.revision
    && current.mode === requested.mode
    && current.agentCli === requested.agentCli
    && current.model === requested.model;
  if (unchanged) return current;
  const normalized = {
    ...requested,
    revision: `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(8).toString('hex')}`
  };
  configs.set(root, normalized);
  return normalized;
}

function cognitiveOperation(globalDataPath: string, operation?: CognitiveOperation) {
  return (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
}

export async function refreshCognitiveRuntimeConfig(globalDataPath: string, operation?: CognitiveOperation): Promise<CognitiveRuntimeConfig> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const result = await cognitiveOperation(root, operation)('read_host_settings', { namespace: 'cognitive', ownerScope: 'global' }) as { items: SettingItem[] };
  const fields = new Map(result.items.map(item => [item.key, item]));
  revisions.set(root, new Map(result.items.map(item => [item.key, item.revision])));
  const value = normalizeConfig({ mode: fields.get('mode')?.value as CognitiveRuntimeConfig['mode'], agentCli: String(fields.get('agentCli')?.value || ''), model: String(fields.get('model')?.value || '') });
  value.revision = crypto.createHash('sha256').update(JSON.stringify(result.items.map(item => [item.key, item.revision, item.value]))).digest('hex');
  configs.set(root, value);
  return value;
}

export async function persistCognitiveRuntimeConfig(globalDataPath: string, value: Partial<CognitiveRuntimeConfig>, operation?: CognitiveOperation, idempotencyKey = `cognitive:${crypto.randomUUID()}`): Promise<CognitiveRuntimeConfig> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  let current: CognitiveRuntimeConfig;
  try { current = await refreshCognitiveRuntimeConfig(root, operation); }
  catch { current = readCognitiveRuntimeConfig(root); }
  const next = normalizeConfig({ ...current, ...value });
  const known = revisions.get(root) || new Map<string, number>();
  const patches = ([['mode', next.mode], ['agentCli', next.agentCli], ['model', next.model]] as const)
    .filter(([key, field]) => (current as unknown as Record<string, unknown>)[key] !== field || !known.has(key))
    .map(([key, field]) => ({ key, expectedRevision: known.get(key) || 0, value: field }));
  if (patches.length) {
    try { await cognitiveOperation(root, operation)('patch_host_settings', { namespace: 'cognitive', ownerScope: 'global', patches, idempotencyKey }); }
    catch (error) {
      if ((error as Error).message !== 'revision_conflict') throw error;
      await refreshCognitiveRuntimeConfig(root, operation);
      return persistCognitiveRuntimeConfig(root, value, operation, idempotencyKey);
    }
  }
  return refreshCognitiveRuntimeConfig(root, operation);
}
