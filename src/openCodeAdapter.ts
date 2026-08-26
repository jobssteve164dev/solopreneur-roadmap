import { getAgentCliFamily } from './agentCli';

const openCodeApiKeySecretPrefix = 'solomap.opencode.apiKey.';

export interface OpenCodeSecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export function normalizeOpenCodeProvider(value: unknown): string {
  const provider = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(provider) ? provider : '';
}

export function getOpenCodeProviderFromModel(model: unknown): string {
  const value = String(model || '').trim();
  if (!value || value === 'auto' || !value.includes('/')) {
    return '';
  }
  return normalizeOpenCodeProvider(value.split('/', 1)[0]);
}

export function getOpenCodeApiKeySecretKey(provider: unknown): string {
  const normalized = normalizeOpenCodeProvider(provider);
  return normalized ? `${openCodeApiKeySecretPrefix}${normalized}` : '';
}

export async function readOpenCodeApiKey(secretStore: OpenCodeSecretStore, provider: unknown): Promise<string> {
  const secretKey = getOpenCodeApiKeySecretKey(provider);
  return secretKey ? String(await secretStore.get(secretKey) || '') : '';
}

export async function updateOpenCodeApiKey(
  secretStore: OpenCodeSecretStore,
  provider: unknown,
  apiKey: unknown,
  remove = false
): Promise<void> {
  const secretKey = getOpenCodeApiKeySecretKey(provider);
  if (!secretKey) return;
  if (remove) {
    await secretStore.delete(secretKey);
    return;
  }
  const value = String(apiKey || '').trim();
  if (value) await secretStore.store(secretKey, value);
}

export function buildOpenCodeTerminalEnvironment(
  agentCli: unknown,
  model: unknown,
  configuredProvider: unknown,
  apiKey: unknown
): Record<string, string> | undefined {
  if (getAgentCliFamily(String(agentCli || '')) !== 'opencode') {
    return undefined;
  }
  const provider = getOpenCodeProviderFromModel(model) || normalizeOpenCodeProvider(configuredProvider);
  const key = String(apiKey || '').trim();
  if (!provider || !key) {
    return undefined;
  }
  return {
    OPENCODE_AUTH_CONTENT: JSON.stringify({
      [provider]: { type: 'api', key }
    })
  };
}
