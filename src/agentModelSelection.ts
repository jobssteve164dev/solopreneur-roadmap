import { AgentModelCatalog, loadDiscoveredAgentModels } from './agentModels';
import { resolveAgentCli } from './agentCli';

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

export function resolveAgentModelCatalog(agentCli: string, configuredCliPath = 'agy'): { agentCli: string; catalog: AgentModelCatalog } {
  const resolvedAgentCli = resolveAgentCli(agentCli || '', configuredCliPath || 'agy');
  return {
    agentCli: resolvedAgentCli,
    catalog: loadDiscoveredAgentModels(resolvedAgentCli)
  };
}

export function buildAgentModelsLoadedMessage(input: {
  requestId?: unknown;
  targetId?: unknown;
  agentCli?: string;
  configuredCliPath?: string;
}): { command: 'agentModelsLoaded'; requestId: string; targetId: string; agentCli: string; catalog: AgentModelCatalog } {
  const resolved = resolveAgentModelCatalog(input.agentCli || '', input.configuredCliPath || 'agy');
  return {
    command: 'agentModelsLoaded',
    requestId: String(input.requestId || ''),
    targetId: String(input.targetId || ''),
    agentCli: resolved.agentCli,
    catalog: resolved.catalog
  };
}

