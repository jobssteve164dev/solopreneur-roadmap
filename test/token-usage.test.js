const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const projectRoot = path.resolve(__dirname, '..');
const {
  extractTokenUsageFromOutput,
  normalizeTokenUsage
} = require(path.join(projectRoot, 'out/tokenUsage.js'));

test('extracts Codex turn usage from official JSONL output', () => {
  const usage = extractTokenUsageFromOutput([
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":9}}'
  ].join('\n'), 'codex');

  assert.deepEqual(usage, {
    inputTokens: 24763,
    cachedInputTokens: 24448,
    outputTokens: 122,
    reasoningOutputTokens: 9,
    totalTokens: 24885
  });
});

test('extracts Claude result usage and normalizes cache fields', () => {
  const usage = extractTokenUsageFromOutput(JSON.stringify({
    type: 'result',
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      output_tokens: 25
    }
  }), 'claude');

  assert.equal(usage.inputTokens, 190);
  assert.equal(usage.cachedInputTokens, 80);
  assert.equal(usage.outputTokens, 25);
  assert.equal(usage.totalTokens, 215);
});

test('sums OpenCode step token events without double counting cache tokens', () => {
  const usage = extractTokenUsageFromOutput([
    JSON.stringify({ type: 'step_finish', part: { tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 30, write: 5 } } } }),
    JSON.stringify({ type: 'step_finish', part: { tokens: { input: 70, output: 20, reasoning: 3, cache: { read: 40, write: 0 } } } })
  ].join('\n'), 'opencode');

  assert.deepEqual(usage, {
    inputTokens: 195,
    cachedInputTokens: 70,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 225
  });
});

test('extracts human-readable total token lines and preserves explicit totals', () => {
  assert.equal(extractTokenUsageFromOutput('tokens used\n12,345', 'codex').totalTokens, 12345);
  assert.equal(normalizeTokenUsage({ inputTokens: 20, outputTokens: 5, totalTokens: 30 }).totalTokens, 30);
});

test('migrates an existing run index and persists token usage', async () => {
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE run_records (
      executionLogId INTEGER PRIMARY KEY,
      nodeId TEXT,
      runKind TEXT,
      agentCli TEXT,
      status TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      durationMs INTEGER,
      outputPath TEXT,
      outputBytes INTEGER,
      outputTail TEXT,
      commandPath TEXT,
      promptPath TEXT,
      changesPath TEXT,
      touchedFilesPath TEXT,
      updatedAt TEXT
    )
  `);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-token-migration-'));
  const dbPath = path.join(tempRoot, 'project_journal.db');
  fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  const { SqliteStore } = require(path.join(projectRoot, 'out/db/sqliteStore.js'));
  const store = new SqliteStore(dbPath, projectRoot);
  await store.init();
  store.upsertRunIndex({
    executionLogId: 1,
    nodeId: '__solo__',
    runKind: 'solo',
    agentCli: 'codex',
    status: 'Completed',
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: '2026-07-27T10:01:00.000Z',
    durationMs: 60000,
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    outputPath: '',
    outputBytes: 0,
    outputTail: '',
    commandPath: '',
    promptPath: '',
    changesPath: '',
    touchedFilesPath: '',
    updatedAt: '2026-07-27T10:01:00.000Z'
  });
  const entry = store.getRunIndexEntries()[0];
  assert.equal(entry.totalTokens, 120);
  assert.equal(entry.cachedInputTokens, 80);
  store.close();
});
