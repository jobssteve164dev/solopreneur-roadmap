const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

function bytes(file) { try { return fs.statSync(file).size; } catch { return 0; } }

test('Pi native execution stays within the v1 140-turn automatic-retention capacity envelope', { timeout: 90_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-capacity-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('capacity-runtime');
  const conversationId = crypto.randomUUID();
  let modelCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => (++modelCalls % 2
    ? JSON.stringify({ toolCall: { name: 'list_projects', arguments: {} } })
    : 'capacity answer') });
  const tools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { return { content: [{ type: 'text', text: '[]' }] }; }
  };
  const initialBytes = bytes(database.filePath);
  let peakWalBytes = 0;
  const startedAt = Date.now();
  const turns = 140;
  for (let turn = 0; turn < turns; turn += 1) {
    const current = database.readIntelligenceConversation(conversationId);
    const operationId = `capacity-operation-${turn}`;
    const accepted = database.admitPiConversationOperation({
      schemaVersion: 1, conversationId, operationId, requestKey: `capacity-request-${turn}`,
      prompt: `capacity prompt ${turn}`, attachments: [], baselineRevision: current?.revision || 0,
      source: 'capacity-test', sourceGeneration: 1, projectScope: '', systemPrompt: 'capacity-system-v1',
      projectContext: { selectedProject: '', projects: [] }, model: { provider: 'agent-cli', modelId: 'auto' }, tools: [],
      executionProfile: 'pi-core-0.87.1-v1', options: { retry: 'native', compaction: 'native', toolExecution: 'sequential' }
    }, owner);
    const terminal = await engine.chatNative({
      sessionId: accepted.sessionId, lane: accepted.lane, operationId,
      messages: [...(current?.conversation.messages || []), { role: 'user', content: `capacity prompt ${turn}` }],
      projectContext: { selectedProject: '', projects: [] },
      authorizeTool: input => database.admitPiToolInvocation(operationId, owner, input)
    }, database.createPiSessionStorage(accepted.sessionId, owner), tools);
    database.settlePiConversationOperation(operationId, owner, terminal);
    database.maintainPiExecutionRetention(conversationId, owner);
    peakWalBytes = Math.max(peakWalBytes, bytes(`${database.filePath}-wal`));
  }
  const elapsedMs = Date.now() - startedAt;
  const growthBytes = bytes(database.filePath) - initialBytes;
  const recoverStartedAt = Date.now();
  assert.equal(database.listRecoverablePiConversationOperations().length, 0);
  const recoveryScanMs = Date.now() - recoverStartedAt;
  const backup = await database.backup({ destination: path.join(root, 'capacity-backup.db'), idempotencyKey: 'capacity-backup-v1' });
  const piEntries = Number(database.rows('SELECT COUNT(*) AS count FROM pi_entries')[0].count);
  const toolInvocations = Number(database.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count);
  const temporarySpaceBytes = database.databaseStorageFileSizes().databaseBytes + backup.bytes;
  assert.ok(growthBytes <= 16 * 1024 * 1024, `database growth ${growthBytes} exceeded 16 MiB`);
  assert.ok(peakWalBytes <= 32 * 1024 * 1024, `WAL peak ${peakWalBytes} exceeded 32 MiB`);
  assert.ok(backup.bytes <= 32 * 1024 * 1024, `backup ${backup.bytes} exceeded 32 MiB`);
  assert.ok(temporarySpaceBytes <= 64 * 1024 * 1024, `maintenance temporary space ${temporarySpaceBytes} exceeded 64 MiB`);
  assert.ok(elapsedMs <= 65_000, `${turns} turns took ${elapsedMs} ms`);
  assert.ok(recoveryScanMs <= 1_000, `recovery scan took ${recoveryScanMs} ms`);
  assert.equal(toolInvocations, 128, 'automatic per-turn retention must enforce the production tool-detail budget');
  assert.equal(Number(database.rows('SELECT COUNT(*) AS count FROM pi_retention_runs WHERE session_id=(SELECT session_id FROM pi_conversation_bindings WHERE conversation_id=?)', [conversationId])[0].count), 1);
  t.diagnostic(JSON.stringify({ turns, initialBytes, growthBytes, bytesPerToolTurn: Math.ceil(growthBytes / turns), peakWalBytes,
    backupBytes: backup.bytes, temporarySpaceBytes, piEntries, toolInvocations, retentionPruned: turns - toolInvocations, elapsedMs, recoveryScanMs }));
  database.close();
});
