import { AgentModelCatalog, loadDiscoveredAgentModels } from './agentModels';
import { resolveAgentCliWithinFamily } from './agentCli';

export function normalizeAgentModelPreferences(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, model]) => {
    const family = String(key || '').trim();
    const normalizedModel = String(model || '').trim();
    if (family && normalizedModel) {
      acc[family] = normalizedModel;
    }
    return acc;
  }, {});
}

export function mergeAgentModelPreferences(...values: unknown[]): Record<string, string> {
  return values.reduce<Record<string, string>>((acc, value) => ({
    ...acc,
    ...normalizeAgentModelPreferences(value)
  }), {});
}

export async function resolveAgentModelCatalog(agentCli: string, configuredCliPath = 'agy'): Promise<{ agentCli: string; catalog: AgentModelCatalog }> {
  const resolvedAgentCli = resolveAgentCliWithinFamily(agentCli || configuredCliPath || 'agy', configuredCliPath || 'agy');
  return {
    agentCli: resolvedAgentCli,
    catalog: await loadDiscoveredAgentModels(resolvedAgentCli)
  };
}

export async function buildAgentModelsLoadedMessage(input: {
  requestId?: unknown;
  targetId?: unknown;
  agentCli?: string;
  configuredCliPath?: string;
}): Promise<{ command: 'agentModelsLoaded'; requestId: string; targetId: string; agentCli: string; catalog: AgentModelCatalog }> {
  const resolved = await resolveAgentModelCatalog(input.agentCli || '', input.configuredCliPath || 'agy');
  return {
    command: 'agentModelsLoaded',
    requestId: String(input.requestId || ''),
    targetId: String(input.targetId || ''),
    agentCli: resolved.agentCli,
    catalog: resolved.catalog
  };
}
