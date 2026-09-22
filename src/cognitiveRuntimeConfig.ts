import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface CognitiveRuntimeConfig {
  schemaVersion: 1;
  revision: string;
  mode: 'local_only' | 'agent_cli';
  agentCli: string;
  model: string;
}

function configPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'cognitive-config.json');
}

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
  const filePath = configPath(globalDataPath);
  if (!fs.existsSync(filePath)) return normalizeConfig(null);
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeConfig(null);
  }
}

export function writeCognitiveRuntimeConfig(globalDataPath: string, value: Partial<CognitiveRuntimeConfig>): CognitiveRuntimeConfig {
  const filePath = configPath(globalDataPath);
  const requested = normalizeConfig(value);
  const current = readCognitiveRuntimeConfig(globalDataPath);
  const unchanged = current.revision
    && current.mode === requested.mode
    && current.agentCli === requested.agentCli
    && current.model === requested.model;
  if (unchanged) return current;
  const normalized = {
    ...requested,
    revision: `${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(8).toString('hex')}`
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return normalized;
}
