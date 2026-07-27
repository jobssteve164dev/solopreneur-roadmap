import * as fs from 'fs';
import * as path from 'path';
import { SqliteStore } from './db/sqliteStore';
import { RunIndexFile, RunIndexRecord, RunIndexSignal } from './db/types';
import { AgentTokenUsage, normalizeTokenUsage } from './tokenUsage';

export interface RunIndexHealth {
  digestCount: number;
  indexedCount: number;
  missingDigestCount: number;
  backfilledCount: number;
  ok: boolean;
  error: string;
}

interface DigestRun {
  executionLogId: number;
  nodeId: string;
  runKind: string;
  agentCli: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tokenUsage: AgentTokenUsage;
  changedFiles: string[];
  touchedFiles: string[];
  verification: string[];
  failures: string[];
  reusableSignals: string[];
}

function readDigestObjects(projectPath: string): DigestRun[] {
  const digestRoot = path.join(projectPath, '.solopreneur', 'run-digests');
  if (!fs.existsSync(digestRoot)) {
    return [];
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(digestRoot).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    try {
      const digest = JSON.parse(fs.readFileSync(path.join(digestRoot, file), 'utf8'));
      const executionLogId = Number(digest?.executionLogId || digest?.rawRefs?.executionLogId || 0);
      if (!digest || typeof digest !== 'object' || !executionLogId) {
        return null;
      }
      return {
        executionLogId,
        nodeId: String(digest.nodeId || ''),
        runKind: String(digest.runKind || 'step'),
        agentCli: String(digest.agentCli || ''),
        status: String(digest.status || ''),
        startedAt: String(digest.startedAt || ''),
        finishedAt: String(digest.finishedAt || digest.startedAt || ''),
        durationMs: Math.max(0, Number(digest.durationMs || 0)),
        tokenUsage: normalizeTokenUsage(digest.tokenUsage),
        changedFiles: Array.isArray(digest.changedFiles) ? digest.changedFiles.map(String).filter(Boolean) : [],
        touchedFiles: Array.isArray(digest.touchedFiles) ? digest.touchedFiles.map(String).filter(Boolean) : [],
        verification: Array.isArray(digest.verification) ? digest.verification.map(String).filter(Boolean) : [],
        failures: Array.isArray(digest.failures) ? digest.failures.map(String).filter(Boolean) : [],
        reusableSignals: Array.isArray(digest.reusableSignals) ? digest.reusableSignals.map(String).filter(Boolean) : []
      };
    } catch {
      return null;
    }
  }).filter((digest): digest is DigestRun => Boolean(digest));
}

function digestToRunIndex(digest: DigestRun): { record: RunIndexRecord; files: RunIndexFile[]; signals: RunIndexSignal[] } {
  const files: RunIndexFile[] = [
    ...digest.changedFiles.map((filePath) => ({ filePath, role: 'changed' })),
    ...digest.touchedFiles.map((filePath) => ({ filePath, role: 'touched' }))
  ];
  const signals: RunIndexSignal[] = [
    ...digest.verification.map((value) => ({ type: 'verification', value })),
    ...digest.failures.map((value) => ({ type: 'failure', value })),
    ...digest.reusableSignals.map((value) => ({ type: 'reusable', value }))
  ];
  return {
    record: {
      executionLogId: digest.executionLogId,
      nodeId: digest.nodeId,
      runKind: digest.runKind,
      agentCli: digest.agentCli,
      status: digest.status,
      startedAt: digest.startedAt,
      finishedAt: digest.finishedAt,
      durationMs: digest.durationMs,
      inputTokens: digest.tokenUsage.inputTokens,
      cachedInputTokens: digest.tokenUsage.cachedInputTokens,
      outputTokens: digest.tokenUsage.outputTokens,
      reasoningOutputTokens: digest.tokenUsage.reasoningOutputTokens,
      totalTokens: digest.tokenUsage.totalTokens,
      outputPath: '',
      outputBytes: 0,
      outputTail: '',
      commandPath: '',
      promptPath: '',
      changesPath: '',
      touchedFilesPath: '',
      updatedAt: new Date().toISOString()
    },
    files,
    signals
  };
}

export async function getRunIndexHealth(projectPath: string, extensionPath: string): Promise<RunIndexHealth> {
  const digests = readDigestObjects(projectPath);
  const dbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(dbPath)) {
    return {
      digestCount: digests.length,
      indexedCount: 0,
      missingDigestCount: digests.length,
      backfilledCount: 0,
      ok: digests.length === 0,
      error: ''
    };
  }
  const store = new SqliteStore(dbPath, extensionPath);
  try {
    await store.init();
    const indexedIds = new Set(store.getRunIndexEntries().map((entry) => Number(entry.executionLogId || 0)).filter(Boolean));
    const missingDigestCount = digests.filter((digest) => !indexedIds.has(digest.executionLogId)).length;
    return {
      digestCount: digests.length,
      indexedCount: indexedIds.size,
      missingDigestCount,
      backfilledCount: 0,
      ok: missingDigestCount === 0,
      error: ''
    };
  } catch (error) {
    return {
      digestCount: digests.length,
      indexedCount: 0,
      missingDigestCount: digests.length,
      backfilledCount: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    store.close();
  }
}

export async function backfillRunIndexFromDigests(projectPath: string, extensionPath: string): Promise<RunIndexHealth> {
  const digests = readDigestObjects(projectPath);
  if (digests.length === 0) {
    return getRunIndexHealth(projectPath, extensionPath);
  }
  const dbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  const store = new SqliteStore(dbPath, extensionPath);
  let backfilledCount = 0;
  try {
    await store.init();
    const indexedIds = new Set(store.getRunIndexEntries().map((entry) => Number(entry.executionLogId || 0)).filter(Boolean));
    for (const digest of digests) {
      if (indexedIds.has(digest.executionLogId)) {
        continue;
      }
      const next = digestToRunIndex(digest);
      store.upsertRunIndex(next.record, next.files, next.signals);
      indexedIds.add(digest.executionLogId);
      backfilledCount += 1;
    }
    const missingDigestCount = digests.filter((digest) => !indexedIds.has(digest.executionLogId)).length;
    return {
      digestCount: digests.length,
      indexedCount: indexedIds.size,
      missingDigestCount,
      backfilledCount,
      ok: missingDigestCount === 0,
      error: ''
    };
  } catch (error) {
    return {
      digestCount: digests.length,
      indexedCount: 0,
      missingDigestCount: digests.length,
      backfilledCount,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    store.close();
  }
}
