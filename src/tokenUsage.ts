import * as fs from 'fs';
import * as path from 'path';
import { findCodexTranscriptFile } from './continuation';

export interface AgentTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface RunTokenUsageInput {
  agentCli: string;
  outputText: string;
  workspaceRoot: string;
  startedAt: string;
  sessionId?: string;
  codexHome?: string;
}

const EMPTY_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
};

function nonNegativeInteger(value: unknown): number {
  const numeric = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function usageFromObject(value: any): AgentTokenUsage {
  if (!value || typeof value !== 'object') {
    return { ...EMPTY_USAGE };
  }
  const inputTokens = nonNegativeInteger(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens ?? value.promptTokens ?? value.input);
  const cachedInputTokens = nonNegativeInteger(
    value.cached_input_tokens
    ?? value.cachedInputTokens
    ?? value.cache_read_input_tokens
    ?? value.cacheReadInputTokens
    ?? value.cache?.read
  );
  const cacheCreationTokens = nonNegativeInteger(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens ?? value.cache?.write);
  const outputTokens = nonNegativeInteger(value.output_tokens ?? value.outputTokens ?? value.completion_tokens ?? value.completionTokens ?? value.output);
  const reasoningOutputTokens = nonNegativeInteger(
    value.reasoning_output_tokens
    ?? value.reasoningOutputTokens
    ?? value.reasoning_tokens
    ?? value.reasoningTokens
    ?? value.reasoning
  );
  const explicitTotal = nonNegativeInteger(value.total_tokens ?? value.totalTokens);
  const cacheIsSeparate = value.cache_creation_input_tokens !== undefined
    || value.cacheCreationInputTokens !== undefined
    || (value.cache && typeof value.cache === 'object');
  const normalizedInput = inputTokens + (cacheIsSeparate ? cachedInputTokens + cacheCreationTokens : 0);
  return {
    inputTokens: normalizedInput,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: explicitTotal || normalizedInput + outputTokens
  };
}

function hasUsage(usage: AgentTokenUsage): boolean {
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

function addUsage(left: AgentTokenUsage, right: AgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function subtractUsage(after: AgentTokenUsage, before: AgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    cachedInputTokens: Math.max(0, after.cachedInputTokens - before.cachedInputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    reasoningOutputTokens: Math.max(0, after.reasoningOutputTokens - before.reasoningOutputTokens),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens)
  };
}

function parseJsonLines(outputText: string): any[] {
  const normalized = String(outputText || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    try {
      return [JSON.parse(normalized)];
    } catch {}
  }
  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function extractTokenUsageFromOutput(outputText: string, _agentCli = ''): AgentTokenUsage {
  const events = parseJsonLines(outputText);
  const cumulativeCandidates: AgentTokenUsage[] = [];
  let additiveUsage = { ...EMPTY_USAGE };

  for (const event of events) {
    const eventType = String(event?.type || event?.event || '').toLowerCase();
    if (eventType === 'step_finish' || eventType === 'step-finish') {
      const stepUsage = usageFromObject(event?.part?.tokens ?? event?.data?.part?.tokens ?? event?.tokens);
      if (hasUsage(stepUsage)) {
        additiveUsage = addUsage(additiveUsage, stepUsage);
      }
      continue;
    }
    const candidate = usageFromObject(
      event?.usage
      ?? event?.data?.usage
      ?? event?.result?.usage
      ?? event?.payload?.usage
      ?? event?.payload?.info?.last_token_usage
    );
    if (hasUsage(candidate)) {
      cumulativeCandidates.push(candidate);
    }
  }

  if (hasUsage(additiveUsage)) {
    return additiveUsage;
  }
  if (cumulativeCandidates.length > 0) {
    return cumulativeCandidates[cumulativeCandidates.length - 1];
  }

  const plain = String(outputText || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const totalMatch = plain.match(/(?:tokens?\s+used|total\s+tokens?)(?:\s*[:=])?\s*([\d,]+)/i);
  const inputMatch = plain.match(/(?:input|prompt)\s+tokens?(?:\s*[:=])\s*([\d,]+)/i);
  const outputMatch = plain.match(/(?:output|completion)\s+tokens?(?:\s*[:=])\s*([\d,]+)/i);
  const cachedMatch = plain.match(/cached(?:\s+input)?\s+tokens?(?:\s*[:=])\s*([\d,]+)/i);
  const usage = {
    inputTokens: nonNegativeInteger(inputMatch?.[1]),
    cachedInputTokens: nonNegativeInteger(cachedMatch?.[1]),
    outputTokens: nonNegativeInteger(outputMatch?.[1]),
    reasoningOutputTokens: 0,
    totalTokens: nonNegativeInteger(totalMatch?.[1])
  };
  usage.totalTokens ||= usage.inputTokens + usage.outputTokens;
  return usage;
}

function readCodexCumulativeUsage(transcriptPath: string, startedAt: string): AgentTokenUsage {
  const startedAtMs = Date.parse(String(startedAt || ''));
  let before = { ...EMPTY_USAGE };
  let after = { ...EMPTY_USAGE };
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.payload?.type !== 'token_count') {
        continue;
      }
      const usage = usageFromObject(event?.payload?.info?.total_token_usage);
      if (!hasUsage(usage)) {
        continue;
      }
      const timestampMs = Date.parse(String(event.timestamp || ''));
      if (Number.isFinite(startedAtMs) && Number.isFinite(timestampMs) && timestampMs < startedAtMs) {
        before = usage;
      } else {
        after = usage;
      }
    }
  } catch {
    return { ...EMPTY_USAGE };
  }
  return subtractUsage(after, before);
}

function findClaudeTranscript(workspaceRoot: string, startedAt: string, sessionId = '', claudeHome = path.join(process.env.HOME || '', '.claude')): string {
  const projectsRoot = path.join(claudeHome, 'projects');
  if (!workspaceRoot || !fs.existsSync(projectsRoot)) {
    return '';
  }
  const startedAtMs = Date.parse(String(startedAt || ''));
  const stack = [projectsRoot];
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  while (stack.length > 0) {
    const current = stack.pop() || '';
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (sessionId && entry.name === `${sessionId}.jsonl`) {
          return fullPath;
        }
        if (sessionId) {
          continue;
        }
        try {
          const mtimeMs = fs.statSync(fullPath).mtimeMs;
          if (!Number.isFinite(startedAtMs) || mtimeMs >= startedAtMs) {
            candidates.push({ file: fullPath, mtimeMs });
          }
        } catch {}
      }
    }
  }
  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20)) {
    try {
      const matchesWorkspace = fs.readFileSync(candidate.file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 12)
        .some((line) => {
          try {
            return path.resolve(String(JSON.parse(line)?.cwd || '')) === path.resolve(workspaceRoot);
          } catch {
            return false;
          }
        });
      if (matchesWorkspace) {
        return candidate.file;
      }
    } catch {}
  }
  return '';
}

function readClaudeUsage(transcriptPath: string, startedAt: string): AgentTokenUsage {
  const startedAtMs = Date.parse(String(startedAt || ''));
  const usageByMessage = new Map<string, AgentTokenUsage>();
  let anonymousUsage = { ...EMPTY_USAGE };
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const timestampMs = Date.parse(String(event?.timestamp || ''));
      if (Number.isFinite(startedAtMs) && Number.isFinite(timestampMs) && timestampMs < startedAtMs) {
        continue;
      }
      const messageUsage = usageFromObject(event?.message?.usage);
      if (hasUsage(messageUsage)) {
        const messageId = String(event?.message?.id || '').trim();
        if (!messageId) {
          anonymousUsage = addUsage(anonymousUsage, messageUsage);
          continue;
        }
        const previous = usageByMessage.get(messageId);
        if (!previous || messageUsage.totalTokens > previous.totalTokens) {
          usageByMessage.set(messageId, messageUsage);
        }
      }
    }
  } catch {
    return { ...EMPTY_USAGE };
  }
  return [...usageByMessage.values()].reduce(addUsage, anonymousUsage);
}

export function extractRunTokenUsage(input: RunTokenUsageInput): AgentTokenUsage {
  const outputUsage = extractTokenUsageFromOutput(input.outputText, input.agentCli);
  if (hasUsage(outputUsage)) {
    return outputUsage;
  }
  const family = path.basename(String(input.agentCli || '')).toLowerCase();
  if ((family === 'codex' || family === 'codex-cli') && input.sessionId) {
    const codexHome = String(input.codexHome || '').trim() || path.join(process.env.HOME || '', '.codex');
    const transcriptPath = findCodexTranscriptFile(codexHome, input.sessionId);
    return transcriptPath ? readCodexCumulativeUsage(transcriptPath, input.startedAt) : { ...EMPTY_USAGE };
  }
  if (family === 'claude' || family === 'claude-code' || family === 'claude-code-cli') {
    const transcriptPath = findClaudeTranscript(input.workspaceRoot, input.startedAt, String(input.sessionId || '').trim());
    return transcriptPath ? readClaudeUsage(transcriptPath, input.startedAt) : { ...EMPTY_USAGE };
  }
  return { ...EMPTY_USAGE };
}

export function normalizeTokenUsage(value: Partial<AgentTokenUsage> | null | undefined): AgentTokenUsage {
  return usageFromObject(value || {});
}
