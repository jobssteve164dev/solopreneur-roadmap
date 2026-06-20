import * as childProcess from 'child_process';

import { getAgentCliFamily, resolveExecutablePath } from './agentCli';

export interface AgentModelOption {
  value: string;
  label: string;
  title?: string;
}

export interface AgentModelCatalog {
  family: string;
  command: string;
  models: AgentModelOption[];
  selectedValue: string;
  supportsDiscovery: boolean;
}

const agentModelCatalogCache = new Map<string, { expiresAt: number; catalog: AgentModelCatalog }>();

export function stripTerminalControlSequences(value: string): string {
  return String(value || '')
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\x07/g, '');
}

export function createAutoOnlyModelCatalog(agentCli: string): AgentModelCatalog {
  return {
    family: getAgentCliFamily(agentCli),
    command: resolveExecutablePath(agentCli),
    models: [{ value: 'auto', label: 'Auto' }],
    selectedValue: 'auto',
    supportsDiscovery: false
  };
}

export function parseCodexModelCatalog(output: string): AgentModelOption[] {
  try {
    const payload = JSON.parse(output || '{}') as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    const options: AgentModelOption[] = [];
    for (const model of payload.models || []) {
      if (String(model.visibility || '').trim() === 'hidden') {
        continue;
      }
      const value = String(model.slug || '').trim();
      const label = String(model.display_name || value).trim();
      if (value) {
        options.push({ value, label, title: value === label ? undefined : value });
      }
    }
    return normalizeModelOptions(options);
  } catch {
    return [];
  }
}

export function parseTextModelList(output: string): AgentModelOption[] {
  const cleaned = stripTerminalControlSequences(output);
  return normalizeModelOptions(cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(available models|models|tip:|usage:|flags:|options:|commands:)/i.test(line))
    .filter((line) => !/^[-=]{2,}$/.test(line))
    .map((line) => line
      .replace(/\s*\((current|default)\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim())
    .map((line) => {
      const match = line.match(/^([^\s]+)\s+-\s+(.+)$/);
      if (match) {
        return { value: match[1].trim(), label: match[2].trim(), title: line };
      }
      return { value: line, label: line };
    }));
}

export function normalizeModelOptions(options: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  return options
    .map((option) => ({
      value: String(option.value || '').trim(),
      label: String(option.label || option.value || '').trim(),
      title: option.title ? String(option.title) : undefined
    }))
    .filter((option) => option.value)
    .filter((option) => {
      const key = option.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function runModelCommand(command: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
  if (result.status !== 0) {
    return '';
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function discoverModels(command: string, family: string): { models: AgentModelOption[]; attempted: boolean } {
  const attempts: Array<{ args: string[]; parse: (output: string) => AgentModelOption[] }> = [];
  if (family === 'codex') {
    attempts.push(
      { args: ['debug', 'models'], parse: parseCodexModelCatalog },
      { args: ['debug', 'models', '--bundled'], parse: parseCodexModelCatalog }
    );
  } else if (family === 'cursor') {
    attempts.push(
      { args: ['--list-models'], parse: parseTextModelList },
      { args: ['models'], parse: parseTextModelList }
    );
  } else if (family === 'antigravity') {
    attempts.push({ args: ['models'], parse: parseTextModelList });
  } else if (family === 'opencode') {
    attempts.push({ args: ['models'], parse: parseTextModelList });
  }

  for (const attempt of attempts) {
    const output = runModelCommand(command, attempt.args);
    if (!output) continue;
    const models = attempt.parse(output);
    if (models.length > 0) {
      return { models, attempted: true };
    }
  }
  return { models: [], attempted: attempts.length > 0 };
}

export function loadDiscoveredAgentModels(agentCli: string): AgentModelCatalog {
  const resolvedCli = resolveExecutablePath(agentCli);
  const family = getAgentCliFamily(resolvedCli || agentCli);
  const command = resolvedCli || agentCli;
  const cacheKey = `${family}::${command}`;
  const cached = agentModelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.catalog;
  }

  let discovered: AgentModelOption[] = [];
  let attemptedDiscovery = false;
  if (command) {
    try {
      const result = discoverModels(command, family);
      discovered = result.models;
      attemptedDiscovery = result.attempted;
    } catch (error) {
      console.error(`SoloMap failed to discover models for ${command}:`, error);
    }
  }

  const models = normalizeModelOptions([{ value: 'auto', label: 'Auto' }, ...discovered]);
  const catalog: AgentModelCatalog = {
    family,
    command,
    models: models.length ? models : [{ value: 'auto', label: 'Auto' }],
    selectedValue: 'auto',
    supportsDiscovery: attemptedDiscovery && discovered.length > 0
  };
  agentModelCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + 5 * 60 * 1000,
    catalog
  });
  return catalog;
}
