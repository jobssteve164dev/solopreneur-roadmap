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
const agentModelCatalogLoads = new Map<string, Promise<AgentModelCatalog>>();
const MODEL_QUERY_TIMEOUT_MS = 20000;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const EMPTY_MODEL_CATALOG_TTL_MS = 30 * 1000;

export interface AgentModelDiscoveryStrategy {
  kind: 'command' | 'json-rpc';
  args: string[];
  parse: (output: string) => AgentModelOption[];
}

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

export function parseCopilotModelCatalog(output: string): AgentModelOption[] {
  try {
    const payload = JSON.parse(output || '{}') as { models?: Array<{ id?: string; name?: string }> };
    return normalizeModelOptions((payload.models || []).map((model) => ({
      value: String(model.id || '').trim(),
      label: String(model.name || model.id || '').trim(),
      title: model.id && model.name && model.id !== model.name ? model.id : undefined
    })).filter((model) => model.value.toLowerCase() !== 'auto'));
  } catch {
    return [];
  }
}

export function parseModelChoicesFromHelp(output: string): AgentModelOption[] {
  const cleaned = stripTerminalControlSequences(output);
  const lines = cleaned.split(/\r?\n/);
  const modelLineIndex = lines.findIndex((line) => /(?:^|\s)--model(?:[=\s]|$)/i.test(line));
  if (modelLineIndex < 0) {
    return [];
  }
  const modelOptionLines = [lines[modelLineIndex]];
  for (let index = modelLineIndex + 1; index < lines.length && index <= modelLineIndex + 8; index += 1) {
    if (/^\s*(?:-\w|--\S)/.test(lines[index])) break;
    if (!lines[index].trim()) break;
    modelOptionLines.push(lines[index]);
  }
  const modelOption = modelOptionLines.join(' ').match(/(?:choices|possible values):\s*([^)\]]+)/i);
  if (!modelOption) {
    return [];
  }
  const choices = modelOption[1]
    .replace(/[\[\]]/g, '')
    .split(/,\s*/)
    .map((value) => value.replace(/^["']|["']$/g, '').trim())
    .filter((value) => value && value.toLowerCase() !== 'auto');
  return normalizeModelOptions(choices.map((value) => ({ value, label: value })));
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

export function parseGrokModelCatalog(output: string): AgentModelOption[] {
  const lines = stripTerminalControlSequences(output).split(/\r?\n/);
  const catalogStart = lines.findIndex((line) => /^\s*Available models:\s*$/i.test(line));
  if (catalogStart < 0) {
    return [];
  }
  const modelLines: string[] = [];
  for (const line of lines.slice(catalogStart + 1)) {
    if (!line.trim()) continue;
    if (!/^\s*[*-]\s+/.test(line)) break;
    modelLines.push(line);
  }
  return normalizeModelOptions(modelLines.flatMap((line) => {
    const match = line.match(/^\s*[*-]\s+(.+?)(?:\s+\(default\))?\s*$/i);
    if (!match) return [];
    const value = match[1].trim();
    return value ? [{ value, label: value }] : [];
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

function getModelCommandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return env;
}

function runModelCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getModelCommandEnvironment()
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString('utf8');
      return next.length > 8 * 1024 * 1024 ? next.slice(0, 8 * 1024 * 1024) : next;
    };
    const finish = (output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(output);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, MODEL_QUERY_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', () => finish());
    child.on('exit', (code) => {
      setTimeout(() => {
        finish(code === 0 ? [stdout, stderr].filter(Boolean).join('\n') : '');
      }, 0);
    });
  });
}

function runCopilotModelRpc(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, ['--headless', '--no-auto-update', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getModelCommandEnvironment()
    });
    let settled = false;
    let stdoutBuffer = Buffer.alloc(0);
    const finish = (output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(output);
    };
    const send = (id: number, method: string) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }));
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    };
    const timeout = setTimeout(() => finish(), MODEL_QUERY_TIMEOUT_MS);
    child.on('error', () => finish());
    child.on('exit', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      while (stdoutBuffer.length) {
        const headerEnd = stdoutBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = stdoutBuffer.subarray(0, headerEnd).toString('utf8');
        const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!lengthMatch) {
          finish();
          return;
        }
        const contentLength = Number(lengthMatch[1]);
        const messageEnd = headerEnd + 4 + contentLength;
        if (stdoutBuffer.length < messageEnd) return;
        const body = stdoutBuffer.subarray(headerEnd + 4, messageEnd).toString('utf8');
        stdoutBuffer = stdoutBuffer.subarray(messageEnd);
        try {
          const message = JSON.parse(body) as { id?: number; result?: any; error?: any };
          if (message.id === 1 && !message.error) {
            send(2, 'models.list');
          } else if (message.id === 2 && message.result) {
            finish(JSON.stringify(message.result));
          } else if (message.id === 1 || message.id === 2) {
            finish();
          }
        } catch {
          finish();
        }
      }
    });
    send(1, 'connect');
  });
}

export function getAgentModelDiscoveryStrategies(family: string): AgentModelDiscoveryStrategy[] {
  const attempts: AgentModelDiscoveryStrategy[] = [];
  if (family === 'codex') {
    attempts.push(
      { kind: 'command', args: ['debug', 'models'], parse: parseCodexModelCatalog },
      { kind: 'command', args: ['debug', 'models', '--bundled'], parse: parseCodexModelCatalog }
    );
  } else if (family === 'cursor') {
    attempts.push(
      { kind: 'command', args: ['models'], parse: parseTextModelList },
      { kind: 'command', args: ['--list-models'], parse: parseTextModelList }
    );
  } else if (family === 'antigravity') {
    attempts.push({ kind: 'command', args: ['models'], parse: parseTextModelList });
  } else if (family === 'opencode') {
    attempts.push({ kind: 'command', args: ['models'], parse: parseTextModelList });
  } else if (family === 'grok') {
    attempts.push({ kind: 'command', args: ['--no-auto-update', 'models'], parse: parseGrokModelCatalog });
  } else if (family === 'copilot') {
    attempts.push(
      { kind: 'json-rpc', args: ['--headless', '--no-auto-update', '--stdio'], parse: parseCopilotModelCatalog },
      { kind: 'command', args: ['help'], parse: parseModelChoicesFromHelp }
    );
  } else if (family === 'claude') {
    attempts.push({ kind: 'command', args: ['--help'], parse: parseModelChoicesFromHelp });
  }
  return attempts;
}

async function discoverModels(command: string, family: string): Promise<{ models: AgentModelOption[]; attempted: boolean }> {
  const attempts = getAgentModelDiscoveryStrategies(family);
  for (const attempt of attempts) {
    const output = attempt.kind === 'json-rpc'
      ? await runCopilotModelRpc(command)
      : await runModelCommand(command, attempt.args);
    if (!output) continue;
    const models = attempt.parse(output);
    if (models.length > 0) {
      return { models, attempted: true };
    }
  }
  return { models: [], attempted: attempts.length > 0 };
}

export async function loadDiscoveredAgentModels(agentCli: string): Promise<AgentModelCatalog> {
  const resolvedCli = resolveExecutablePath(agentCli);
  const family = getAgentCliFamily(resolvedCli || agentCli);
  const command = resolvedCli || agentCli;
  const cacheKey = `${family}::${command}`;
  const cached = agentModelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.catalog;
  }
  const activeLoad = agentModelCatalogLoads.get(cacheKey);
  if (activeLoad) {
    return activeLoad;
  }

  const load = (async () => {
    let discovered: AgentModelOption[] = [];
    let attemptedDiscovery = false;
    if (command) {
      try {
        const result = await discoverModels(command, family);
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
      supportsDiscovery: attemptedDiscovery && models.some((model) => model.value !== 'auto')
    };
    agentModelCatalogCache.set(cacheKey, {
      expiresAt: Date.now() + (catalog.supportsDiscovery ? MODEL_CATALOG_TTL_MS : EMPTY_MODEL_CATALOG_TTL_MS),
      catalog
    });
    return catalog;
  })();
  agentModelCatalogLoads.set(cacheKey, load);
  try {
    return await load;
  } finally {
    agentModelCatalogLoads.delete(cacheKey);
  }
}
