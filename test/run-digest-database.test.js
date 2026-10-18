const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
const { buildExecutionExperiencePrompt, readExecutionGraph } = require('../out/runDigest.js');
const { runtimeMcpSource } = require('../out/runtimeDataOperations.js');
const { registerUnifiedMcpTools } = require('../out/unifiedMcp.js');
const { anonymousToolEnv } = require('./analysis-fixture.js');

async function fixture(customRoot = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-digest-database-'));
  const root = path.join(base, ...(customRoot ? ["shared store 'quoted'", '.solomap-global'] : ['.solomap-global'])); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  let server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'digest-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  const call = (operation, input) => sendRuntimeDataRequest(root, { operation, input });
  const identity = await call('register_project', { root: project });
  const env = anonymousToolEnv();
  return { base, root, project, identity, call, env, store: () => store,
    async wait() { await ops.waitForMigrations(); },
    async import(key = 'digest-import') {
      const job = await call('import_project_data', { collection: 'run-digests', projectRoot: project, sourceRoot: path.join(project, '.solopreneur', 'run-digests'), idempotencyKey: key });
      await ops.waitForMigrations(); return call('migration_status', { jobId: job.jobId });
    },
    async reopen() { await server.close(); await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'digest-reopened', onCommand: () => ({ status: 'running' }), onData: ops }); },
    async close() { await server.close(); await ops.close(); store.close(); }
  };
}

async function runExperienceCli(f, command, options = []) {
  return JSON.parse((await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../resources/tools/solomap-experience.cjs'), command, '--project', f.project, '--global', f.root, '--json', ...options], { env: f.env })).stdout);
}

test('the generated first-use handoff uses the formal MCP tool without deploying global tool copies', async () => {
  const { buildCrossAgentHandoffInstructions } = require('../out/runDigest.js');
  const f = await fixture(true);
  try {
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '首次接续', command: 'formal command', userMessage: '首次接续', metadata: { interactiveSession: true }, idempotencyKey: 'first-handoff-prepare' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '可接续结果', idempotencyKey: 'first-handoff-complete' });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    const expected = digest(0, { nodeId: 'step', userIntent: '首次接续必须读取当前数据库', outcome: '已保存的接续结论🌿', handoff: { nextAgentBrief: '完整接续信息🌿'.repeat(2000) } });
    await f.call('commit_run_settlement', { ...scope, token: lease.token, journal: { agentCli: 'codex', command: 'formal command', output: '完整接续日志🌿'.repeat(2000), status: 'In Progress' }, digest: expected, idempotencyKey: 'first-handoff-settle' });
    const instructions = buildCrossAgentHandoffInstructions(f.project, 'step', 'step', f.root);
    assert.match(instructions, /solomap_experience/);
    assert.match(instructions, /"action":"handoff"/);
    assert.doesNotMatch(instructions, /\.cjs|\bnode\s/);
    const readHandoff = async () => {
      const source = runtimeMcpSource(f.root, run.projectId);
      try {
        const handlers = new Map(); registerUnifiedMcpTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler), registerResource() {} }, source);
        const response = await handlers.get('solomap_experience')({ action: 'handoff', node: 'step', limit: 3 });
        assert.equal(response.isError, undefined, JSON.stringify(response.content));
        return JSON.parse(response.content[0].text);
      } finally { await source.close(); }
    };
    const result = await readHandoff();
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].brief, expected.handoff.nextAgentBrief);
    const sourceRef = result.records[0].sourceRef;
    assert.deepEqual((await f.call('read_run_digests', { root: f.project })).items[0].digest, expected);
    await f.reopen();
    const reopenedResult = await readHandoff();
    assert.deepEqual(reopenedResult.records, result.records, 'the same formal MCP query remains usable after owner restart');
    assert.ok(sourceRef.objectId && Number.isInteger(sourceRef.revision));
    assert.equal(fs.existsSync(path.join(f.root, 'tools')), false);
    const skill = instructions.match(/先读取 (.+)，再调用正式 MCP 工具：/)[1];
    assert.equal(fs.statSync(skill).isFile(), true, 'the advertised skill must exist independently of the user project');
    if (process.env.SOLOMAP_462_HANDOFF_EVIDENCE) fs.writeFileSync(process.env.SOLOMAP_462_HANDOFF_EVIDENCE, JSON.stringify({ instructions, expected, result, reopenedResult, source: await f.call('read', { ref: sourceRef.objectId, revision: sourceRef.revision }), root: f.root, project: f.project, noGlobalToolCopies: !fs.existsSync(path.join(f.root, 'tools')) }, null, 2));
  } finally { await f.close(); }
});

function digest(index, patch = {}) {
  return { schemaVersion: 2, runId: `history:${index}`, nodeId: `unrelated-${index}`, runKind: 'step', executionLogId: index + 1, agentCli: 'codex', status: 'Completed', startedAt: '2026-09-01T00:00:00Z', finishedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(), durationMs: 1, tokenUsage: {}, userIntent: `完整历史目标-${index}`, outcome: `实际结果-${index}`, changedFiles: [], touchedFiles: [], commandSignals: [], verification: ['node --test'], failures: [], reusableSignals: [], tags: [], ...patch };
}

test('the actual experience prompt immediately recalls a committed native settlement without legacy files', async () => {
  const f = await fixture();
  try {
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '目标', command: 'actual command', userMessage: '目标', metadata: { interactiveSession: true }, idempotencyKey: 'digest-native-prepare' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '原生结论', idempotencyKey: 'digest-native-complete' });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    const input = { ...scope, token: lease.token, journal: { agentCli: 'codex', command: 'actual command', output: '全部结论', status: 'In Progress' }, digest: digest(0, { nodeId: 'step', userIntent: '原生运行必须即时召回', unknownSourceField: '不能丢失'.repeat(1000) }), idempotencyKey: 'digest-native-settle' };
    await f.call('commit_run_settlement', input);
    const prompt = await buildExecutionExperiencePrompt(f.project, { nodeId: 'step', runKind: 'step' }, f.root);
    assert.ok(prompt.includes(input.digest.userIntent), 'formal settlement must feed the actual prompt without a second file producer');
    const page = await f.call('read_run_digests', { root: f.project, limit: 10 });
    assert.equal(page.items.length, 1); assert.deepEqual(page.items[0].digest, input.digest);
    assert.ok(prompt.includes(page.items[0].ref.objectId), 'prompt must pin its complete evidence source');
    await f.call('commit_run_settlement', input); await f.reopen();
    assert.equal((await f.call('read_run_digests', { root: f.project })).items.length, 1);
    assert.ok((await buildExecutionExperiencePrompt(f.project, { nodeId: 'step' }, f.root)).includes(input.digest.userIntent));
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'run-digests')), false);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'execution-graph.json')), false);
  } finally { await f.close(); }
});

test('native digest generation retains file signals beyond the old projection cap', () => {
  const { buildRunDigest } = require('../out/runDigest.js');
  const files = Array.from({ length: 91 }, (_, index) => `src/file-${index}.js`);
  const value = buildRunDigest({ workspaceRoot: '/project', nodeId: 'step', runKind: 'step', agentCli: 'codex', executionLogId: 1, userMessage: '完成全部文件变更', resolvedCommand: 'node --test', status: 'Completed', startedAt: '2026-10-09T00:00:00Z', finishedAt: '2026-10-09T01:00:00Z', durationMs: 3600000, changedFilesSummary: files.map(file => `M ${file}`).join('\n'), touchedFilesSummary: files.map(file => `M ${file}`).join('\n'), outputTail: 'node --test passed', completionReason: '完成', failureCode: '', failureReason: '' });
  assert.deepEqual(value.changedFiles, files); assert.deepEqual(value.touchedFiles, files);
});

test('native handoff generation retains the complete file list and signals before formal settlement', () => {
  const { buildRunHandoffEntry, buildStepHandoffSummary } = require('../out/runDigest.js');
  const files = Array.from({ length: 91 }, (_, index) => `M src/file-${index}.js`); const signals = '完整原生交接内容🌿\n'.repeat(1000);
  const entry = buildRunHandoffEntry('In Progress', files.join('\n'), signals, '继续完成');
  assert.deepEqual(entry.changedFiles, files); assert.equal(entry.usefulSignals, signals);
  const original = Array.from({ length: 77 }, (_, index) => ({ ...entry, timestamp: `original-${index}`, unknown: { source: index } }));
  assert.deepEqual(JSON.parse(buildStepHandoffSummary(original)).entries, original);
});

test('the formal execution graph pins each occurrence and experience edge to its complete evidence source', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'one.json'), JSON.stringify(digest(0)));
  try {
    await f.import(); const source = (await f.call('read_run_digests', { root: f.project })).items[0].ref;
    const graph = await readExecutionGraph(f.project, f.root);
    assert.deepEqual(graph.runs[0].sourceRef, source);
    assert.ok(graph.usageEdges.length > 0); assert.ok(graph.usageEdges.every(edge => edge.evidenceRefs.includes(`solomap://${source.objectId}?revision=${source.revision}`)));
    assert.ok(Object.values(graph.experienceNodes).every(node => node.sourceRefs.includes(`solomap://${source.objectId}?revision=${source.revision}`)));
  } finally { await f.close(); }
});

test('the actual graph distinguishes completion and session-close evidence of one native turn', async () => {
  const f = await fixture();
  try {
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '原任务', command: 'actual command', userMessage: '原任务', metadata: { interactiveSession: true }, idempotencyKey: 'graph-native-prepare' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '完整结果', idempotencyKey: 'graph-native-complete' });
    let scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    let lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    const body = { journal: { agentCli: 'codex', command: 'actual command', output: '完整结果', status: 'In Progress' }, digest: digest(0, { runId: 'step:1', nodeId: 'step' }) };
    await f.call('commit_run_settlement', { ...scope, token: lease.token, ...body, idempotencyKey: 'graph-native-settle' });
    const state = await f.call('read_run_checkpoint_state', { projectId: run.projectId, executionLogId: 1 });
    const closed = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'graph-native-close' });
    scope = { ...scope, expectedRevision: closed.revision }; lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    await f.call('commit_run_settlement', { ...scope, token: lease.token, ...body, idempotencyKey: 'graph-native-close-settle' });
    const graph = await readExecutionGraph(f.project, f.root);
    assert.equal(graph.runCount, 2); assert.equal(new Set(graph.runs.map(run => run.runId)).size, 2);
    assert.equal(graph.indexes.byNode.step.length, 2);
    assert.ok(graph.runs.every(run => run.sourceRunId === 'step:1' && run.runId === run.sourceRef.objectId));
    assert.ok(graph.runs.every(run => graph.usageEdges.some(edge => edge.runId === run.runId && edge.evidenceRefs.includes(`solomap://${run.sourceRef.objectId}?revision=${run.sourceRef.revision}`))));
  } finally { await f.close(); }
});

test('the actual full graph refreshes when a legacy source changes between owner pages', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  for (let i = 0; i < 101; i++) fs.writeFileSync(path.join(sourceRoot, `${String(i).padStart(3, '0')}.json`), JSON.stringify(digest(i)));
  try {
    await f.import(); const store = f.store(); const original = store.readRunDigests.bind(store); let updated = false;
    store.readRunDigests = async (projectId, input) => {
      const page = original(projectId, input);
      if (!updated && page.nextCursor !== null) {
        updated = true; fs.writeFileSync(path.join(sourceRoot, '000.json'), JSON.stringify(digest(0, { outcome: '分页时更新后的版本' })));
        await f.import('graph-mid-page-background-update');
      }
      return page;
    };
    let graph; try { graph = await readExecutionGraph(f.project, f.root); } finally { store.readRunDigests = original; }
    assert.equal(updated, true); assert.equal(graph.runCount, 101);
    const first = graph.runs.filter(run => (run.sourceRunId || run.runId) === 'history:0');
    assert.equal(first.length, 1); assert.equal(first[0].handoffSummary, '分页时更新后的版本');
  } finally { await f.close(); }
});

test('the distributed ordinary search client refreshes its list when an owner page reports a changed source', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(sourceRoot, `${i}.json`), JSON.stringify(digest(i)));
  try {
    await f.import(); const store = f.store(); const original = store.search.bind(store); let changed = false; let refreshed = false;
    store.search = async (input, canRead) => {
      if (input.cursor && !changed) {
        changed = true; fs.writeFileSync(path.join(sourceRoot, 'new.json'), JSON.stringify(digest(60, { finishedAt: '2026-10-09T00:00:00Z' })));
        await f.import('cli-mid-page-background-update');
      } else if (changed && !input.cursor) refreshed = true;
      return original(input, canRead);
    };
    let summary; try { summary = await runExperienceCli(f, 'summary'); } finally { store.search = original; }
    assert.equal(changed, true); assert.equal(refreshed, true, 'a sourceChanged response must discard the mixed list and reread it');
    assert.equal(summary.payload.totalRecords, 61); assert.equal(summary.payload.latest[0].executionLogId, 61);
  } finally { await f.close(); }
});

test('distributed history finishes while another project and unrelated run logs keep changing', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(sourceRoot, `${i}.json`), JSON.stringify(digest(i)));
  try {
    await f.import(); const foreignRoot = path.join(f.base, 'another-project'); fs.mkdirSync(foreignRoot);
    for (const root of [foreignRoot, f.project]) {
      const run = await f.call('prepare_run', { root, executionLogId: 1000, nodeId: 'unrelated-run', runKind: 'solo', prompt: '并发日志', command: 'actual command', userMessage: '并发日志', metadata: {}, idempotencyKey: `concurrent-prepare:${root}` });
      const store = f.store(); const original = store.search.bind(store); let appended = 0; let searches = 0;
      store.search = async (input, canRead) => {
        if (++searches > 8) throw new Error('acceptance harness: unrelated log writes prevented the full list from completing');
        if (input.cursor) {
          await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1000, generation: run.generation, stream: 'stdout', sequence: appended, offset: appended, bytes: Buffer.from('x').toString('base64'), idempotencyKey: `concurrent-log:${root}:${appended}` });
          appended++;
        }
        return original(input, canRead);
      };
      let result; try { result = await runExperienceCli(f, 'summary'); } finally { store.search = original; }
      assert.ok(appended > 0, 'actual owner log writes must overlap the distributed search pages');
      assert.equal(result.payload.graphRunCount, 60);
      assert.equal(result.payload.totalRecords, root === f.project ? 61 : 60);
    }
  } finally { await f.close(); }
});

test('distributed full history pins each native checkpoint to its own journal body and status', async () => {
  const f = await fixture();
  try {
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '原任务', command: 'actual command', userMessage: '原任务', metadata: { interactiveSession: true }, idempotencyKey: 'pinned-journal-prepare' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '已完成结果', idempotencyKey: 'pinned-journal-complete' });
    let scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    let lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    await f.call('commit_run_settlement', { ...scope, token: lease.token, journal: { agentCli: 'codex', command: 'actual command', output: '第一轮完整正文🌿', status: 'Completed' }, digest: digest(0, { runId: 'step:1', nodeId: 'step', outcome: '第一轮已完成' }), idempotencyKey: 'pinned-journal-settle' });
    const state = await f.call('read_run_checkpoint_state', { projectId: run.projectId, executionLogId: 1 });
    const closed = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 1, idempotencyKey: 'pinned-journal-close' });
    scope = { ...scope, expectedRevision: closed.revision }; lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
    await f.call('commit_run_settlement', { ...scope, token: lease.token, journal: { agentCli: 'codex', command: 'actual command', output: '关闭失败的完整正文🌳', status: 'Failed' }, digest: digest(0, { runId: 'step:1', nodeId: 'step', status: 'Failed', outcome: '关闭失败', finishedAt: '2026-10-09T00:00:00Z' }), idempotencyKey: 'pinned-journal-close-settle' });
    for (let i = 0; i < 2; i++) {
      const history = (await runExperienceCli(f, 'history', ['--full'])).payload;
      assert.equal(history.length, 2);
      const first = history.find(record => record.outcome === '第一轮已完成'); const last = history.find(record => record.outcome === '关闭失败');
      assert.equal(first.log.output, '第一轮完整正文🌿'); assert.equal(first.log.status, 'Completed');
      assert.equal(last.log.output, '关闭失败的完整正文🌳'); assert.equal(last.log.status, 'Failed');
      assert.equal(first.log.sourceRef.revision, 1); assert.notEqual(first.log.sourceRef.objectId, last.log.sourceRef.objectId);
      const content = (await f.call('read', { ref: first.log.sourceRef.objectId, revision: first.log.sourceRef.revision })).data.content;
      const payload = JSON.parse(Buffer.from(content.data, 'base64').toString('utf8'));
      assert.equal(payload.journal.output, '第一轮完整正文🌿');
      if (i === 0) await f.reopen();
    }
  } finally { await f.close(); }
});

test('a valid task query retains relevant semantic signals after the old 300-token boundary', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const value = digest(0, { tags: ['tailone', 'tailtwo', 'tailthree'] }); fs.writeFileSync(path.join(sourceRoot, 'one.json'), JSON.stringify(value));
  try {
    await f.import(); const contextText = Array.from({ length: 350 }, (_, i) => `prefix${i}`).join(' ') + ' tailone tailtwo tailthree';
    assert.ok((await buildExecutionExperiencePrompt(f.project, { nodeId: 'different', runKind: 'different', contextText }, f.root)).includes(value.userIntent));
  } finally { await f.close(); }
});

test('the actual generated handoff instruction stays on the bound formal MCP scope', async () => {
  const f = await fixture(true); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'one.json'), JSON.stringify(digest(0, { nodeId: 'step' })));
  try {
    await f.import(); await runExperienceCli(f, 'history');
    const { buildCrossAgentHandoffInstructions } = require('../out/runDigest.js');
    const instructions = buildCrossAgentHandoffInstructions(f.project, 'step', 'step', f.root);
    assert.match(instructions, /solomap_experience/); assert.match(instructions, /"node":"step"/);
    assert.equal(instructions.includes(f.root), false);
    assert.doesNotMatch(instructions, /\.cjs|\bnode\s/);
  } finally { await f.close(); }
});

test('distributed history projects only the current digest source while older fixed evidence remains readable', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, 'one.json'); fs.writeFileSync(file, JSON.stringify(digest(0, { status: 'Failed', failures: ['旧错误'] })));
  try {
    await f.import(); const old = (await f.call('read_run_digests', { root: f.project })).items[0];
    fs.writeFileSync(file, JSON.stringify(digest(0, { status: 'Completed', outcome: '现行版本' }))); await f.import('current-version');
    const history = await runExperienceCli(f, 'history'); assert.equal(history.payload.length, 1); assert.equal(history.payload[0].outcome, '现行版本');
    assert.equal((await runExperienceCli(f, 'failures')).payload.length, 0);
    assert.equal((await runExperienceCli(f, 'summary')).payload.totalRecords, 1);
    assert.equal(JSON.parse((await f.call('read', { ref: old.ref.objectId, revision: old.ref.revision })).data.content).status, 'Failed');
  } finally { await f.close(); }
});

test('malformed known handoff fields remain captured conflicts and cannot poison actual prompt preparation', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'good.json'), JSON.stringify(digest(0, { nodeId: 'step', userIntent: '仍可启动' })));
  fs.writeFileSync(path.join(sourceRoot, 'bad.json'), JSON.stringify(digest(1, { nodeId: 'step', handoff: { filesToInspectFirst: 'src/a.ts', unknown: { complete: '未知字段必须原样保留' } } })));
  try {
    const job = await f.import(); assert.equal(job.status, 'completed_with_conflicts'); assert.equal(job.progress.imported, 1); assert.equal(job.progress.conflicts.length, 1);
    assert.ok((await buildExecutionExperiencePrompt(f.project, { nodeId: 'step', runKind: 'step' }, f.root)).includes('仍可启动'));
    assert.equal(f.store().capturedMigrationSources().length, 2);
  } finally { await f.close(); }
});

test('background migration converges a derived index to a changed source while a formal index retains its own authority', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, 'one.json'); fs.writeFileSync(file, JSON.stringify(digest(0, { changedFiles: ['old.js'], tokenUsage: { totalTokens: 10 } })));
  const { getRunIndexHealth, backfillRunIndexFromDigests } = require('../out/runIndexMaintenance.js');
  try {
    await f.import(); await backfillRunIndexFromDigests(f.project, '', f.root);
    fs.writeFileSync(file, JSON.stringify(digest(0, { changedFiles: ['new.js'], tokenUsage: { totalTokens: 42 } }))); await f.import('changed-derived-index');
    assert.equal((await getRunIndexHealth(f.project, '', f.root)).ok, true, 'background migration must refresh its own derived index');
    assert.equal((await backfillRunIndexFromDigests(f.project, '', f.root)).backfilledCount, 0);
    let entry = (await f.call('read_project_run_indexes', { root: f.project }))[0]; assert.equal(entry.totalTokens, 42); assert.deepEqual(entry.files.map(file => file.filePath), ['new.js']);
    await f.call('upsert_project_run_index', { root: f.project, record: { ...entry, totalTokens: 99 }, files: [{ role: 'changed', filePath: 'formal.js' }], signals: [] });
    fs.writeFileSync(file, JSON.stringify(digest(0, { changedFiles: ['later-legacy.js'], tokenUsage: { totalTokens: 1 } }))); await f.import('keep-formal-index');
    assert.equal((await backfillRunIndexFromDigests(f.project, '', f.root)).backfilledCount, 0);
    entry = (await f.call('read_project_run_indexes', { root: f.project }))[0]; assert.equal(entry.totalTokens, 99); assert.deepEqual(entry.files.map(file => file.filePath), ['formal.js']);
  } finally { await f.close(); }
});

test('distributed full history reads a formal journal with no digest through ordinary evidence', async () => {
  const f = await fixture();
  try {
    const output = '完整 journal 原文🌿\n'.repeat(10000);
    const journal = await f.call('append_project_journal', { root: f.project, idempotencyKey: 'journal-without-digest', entry: { nodeId: 'step', timestamp: '2026-10-09T00:00:00Z', agentCli: 'codex', command: 'actual command', output, status: 'Completed' } });
    const history = await runExperienceCli(f, 'history', ['--full']); assert.equal(history.payload.length, 1); assert.equal(history.payload[0].executionLogId, journal.executionLogId); assert.equal(history.payload[0].log.output, output);
    assert.ok(history.payload[0].sourceRef.objectId);
    const old = history.payload[0].sourceRef;
    const markdown = (await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../resources/tools/solomap-experience.cjs'), 'history', '--project', f.project, '--global', f.root, '--full'], { env: f.env })).stdout;
    assert.match(markdown, new RegExp(`solomap://objects/${old.objectId}.*revision[=: ]+${old.revision}`));
    await f.call('update_project_journal', { root: f.project, executionLogId: journal.executionLogId, agentCli: 'codex', command: 'actual command', output: '更新后的完整正文', status: 'Completed' });
    assert.equal((await runExperienceCli(f, 'history', ['--full'])).payload[0].log.output, '更新后的完整正文');
    assert.equal(JSON.parse((await f.call('read', { ref: old.objectId, revision: old.revision })).data.content).output, output);
  } finally { await f.close(); }
});

test('digest source changes preserve fixed history, reject corrupt sources and restore an unchanged import receipt', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, 'original.json'); const firstBytes = JSON.stringify(digest(1, { nodeId: 'step', unknown: '原来源' })); fs.writeFileSync(file, firstBytes);
  try {
    assert.equal((await f.import()).status, 'completed');
    const first = (await f.call('read_run_digests', { root: f.project })).items[0];
    const secondBytes = JSON.stringify(digest(1, { nodeId: 'step', unknown: '修改后的来源', changedFiles: ['last-unique.js'] })); fs.writeFileSync(file, secondBytes);
    assert.equal((await f.import('changed')).progress.imported, 1);
    const second = (await f.call('read_run_digests', { root: f.project })).items[0]; assert.notEqual(first.ref.objectId, second.ref.objectId);
    assert.equal((await f.call('read', { ref: first.ref.objectId, revision: first.ref.revision })).data.content, firstBytes);
    assert.equal((await f.call('read', { ref: second.ref.objectId })).data.content, secondBytes);
    fs.writeFileSync(file, '{corrupt'); assert.equal((await f.import('corrupt')).status, 'completed_with_conflicts');
    assert.equal((await f.call('read_run_digests', { root: f.project })).items[0].ref.objectId, second.ref.objectId);
    fs.writeFileSync(file, secondBytes); const restored = await f.import('restored'); assert.equal(restored.progress.unchanged, 1);
    const migration = f.store().rows('SELECT * FROM migration_items WHERE source_identity=? AND source_key=?', [`run-digests:${f.identity.projectId}`, 'original.json'])[0];
    assert.equal(migration.stage, 'imported'); assert.equal(migration.object_id, second.ref.objectId);
    const count = f.store().rows('SELECT COUNT(*) AS count FROM run_digests')[0].count;
    await f.import('unchanged-again'); assert.equal(f.store().rows('SELECT COUNT(*) AS count FROM run_digests')[0].count, count);
    fs.writeFileSync(path.join(sourceRoot, 'unknown.data'), '保留但不能假装入库');
    const outside = path.join(f.base, 'outside.json'); fs.writeFileSync(outside, JSON.stringify(digest(2))); fs.symlinkSync(outside, path.join(sourceRoot, 'linked.json'));
    const invalid = await f.import('invalid-files'); assert.equal(invalid.status, 'completed_with_conflicts'); assert.equal(invalid.progress.conflicts.length, 2);
    const foreignProject = path.join(f.base, 'foreign'); fs.mkdirSync(foreignProject);
    const job = await f.call('import_project_data', { collection: 'run-digests', sourceRoot, projectRoot: foreignProject, idempotencyKey: 'foreign-source' });
    // Waiting on a second queued import lets the owner finish the scope audit before reading its receipt.
    await f.import('after-scope-audit'); assert.equal((await f.call('migration_status', { jobId: job.jobId })).status, 'failed');
  } finally { await f.close(); }
});

test('startup projects journal entries already in the unified database without a legacy journal file', async () => {
  const f = await fixture();
  try {
    const store = f.store(); const body = '此前已迁入库的完整日志🌿'.repeat(10000);
    store.db.run('INSERT INTO project_journal_entries VALUES(?,?,?,?,?,?,?,?,?)', [91, f.identity.projectId, 'v11-journal', 'step', '2026-10-09T00:00:00Z', 'codex', 'actual command', body, 'Completed']);
    const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
    const jobs = [];
    await enqueueAvailableDataMigrations(store, async request => { const receipt = await f.call(request.operation, request.input); if (receipt.jobId) jobs.push(receipt.jobId); return receipt; }, () => true);
    await f.wait();
    assert.ok(jobs.length > 0, 'database-only journal entries need a durable background projection job');
    const history = await runExperienceCli(f, 'history', ['--full']); assert.equal(history.payload.length, 1); assert.equal(history.payload[0].log.output, body);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'project_journal.db')), false);
    const revision = history.payload[0].sourceRef.revision;
    await f.reopen(); await enqueueAvailableDataMigrations(f.store(), request => f.call(request.operation, request.input), () => true);
    await f.wait();
    assert.equal((await runExperienceCli(f, 'history', ['--full'])).payload[0].sourceRef.revision, revision);
  } finally { await f.close(); }
});

test('unchanged distributed history decodes only selected large bodies and keeps source projections stable', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(sourceRoot, `${i}.json`), JSON.stringify(digest(i, { unknownRetainedBody: '完整来源🌿'.repeat(15000) })));
  try {
    const job = await f.import(); const store = f.store();
    const ids = new Set(store.rows('SELECT content_id FROM run_digests').map(row => row.content_id));
    const before = store.rows("SELECT o.id,o.revision FROM objects o JOIN evidence e ON e.id=o.id WHERE e.type='run_digest_source' ORDER BY o.id");
    const original = store.contentRange.bind(store); let decoded = 0; let bytes = 0;
    store.contentRange = (id, metadata, offset, end) => { const value = original(id, metadata, offset, end); if (ids.has(id)) { decoded++; bytes += String(metadata.encoding).startsWith('chunked:') ? value.length : Number(metadata.byte_length); } return value; };
    try { for (let i = 0; i < 4; i++) assert.equal((await runExperienceCli(f, 'history', ['--limit', '3'])).payload.length, 3); }
    finally { store.contentRange = original; }
    assert.equal(decoded, 12); assert.ok(bytes < job.progress.originalBytes / 8);
    await f.import('same-source-projection');
    assert.deepEqual(store.rows("SELECT o.id,o.revision FROM objects o JOIN evidence e ON e.id=o.id WHERE e.type='run_digest_source' ORDER BY o.id"), before);
    process.stdout.write(JSON.stringify({ fixture: f.base, distributedCliCalls: 4, currentSources: 150, sourceBytes: job.progress.originalBytes, selectedBodyDecodes: decoded, decodedBytes: bytes }) + '\n');
  } finally { await f.close(); }
});

test('a journal projection failure rolls back its evidence object and leaves the original journal available', async () => {
  const f = await fixture();
  try {
    const store = f.store(); store.db.run('INSERT INTO project_journal_entries VALUES(?,?,?,?,?,?,?,?,?)', [91, f.identity.projectId, 'v11-journal', 'step', '2026-10-09T00:00:00Z', 'codex', 'actual command', '原始正文', 'Completed']);
    const original = store.db.run.bind(store.db);
    store.db.run = (sql, values) => { if (sql.startsWith('INSERT INTO project_journal_sources')) throw new Error('projection_commit_interrupted'); return original(sql, values); };
    try { assert.throws(() => store.syncProjectJournalSource(f.identity.projectId, 91), /projection_commit_interrupted/); }
    finally { store.db.run = original; }
    assert.equal(store.rows("SELECT COUNT(*) AS count FROM evidence WHERE type='project_journal'")[0].count, 0);
    assert.equal(store.readProjectJournal(f.identity.projectId, { executionLogId: 91 }).logs[0].output, '原始正文');
    store.syncProjectJournalSource(f.identity.projectId, 91);
    assert.equal((await runExperienceCli(f, 'history', ['--full'])).payload[0].log.output, '原始正文');
  } finally { await f.close(); }
});

test('ordinary MCP reads digest evidence in full without gaining host query or foreign-project permissions', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const bytes = JSON.stringify(digest(0, { unknownRetainedBody: '分页全文🌿'.repeat(10000) })); fs.writeFileSync(path.join(sourceRoot, 'one.json'), bytes);
  let source; let foreignSource;
  try {
    await f.import(); const evidence = (await f.call('read_run_digests', { root: f.project })).items[0];
    source = runtimeMcpSource(f.root, f.identity.projectId);
    const handlers = new Map(); registerUnifiedMcpTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler), registerResource() {} }, source);
    const found = JSON.parse((await handlers.get('solomap_search')({ query: 'run_digest', kinds: ['evidence'], limit: 10 })).content[0].text); assert.ok(found.items.some(item => item.objectId === evidence.ref.objectId));
    let cursor; const parts = [];
    do { const result = JSON.parse((await handlers.get('solomap_read')({ ref: evidence.ref.objectId, revision: 1, view: 'content', limit: 2000, ...(cursor ? { cursor } : {}) })).content[0].text); parts.push(Buffer.from(result.data, 'base64')); cursor = result.cursor; } while (cursor);
    assert.equal(Buffer.concat(parts).toString('utf8'), bytes);
    await assert.rejects(source.call('query_run_digests', { projectId: f.identity.projectId, nodeId: 'step' }), /action_denied/);
    await assert.rejects(source.call('write', { kind: 'evidence', scope: f.identity.projectId, action: 'create', idempotencyKey: 'forged-digest', data: { type: 'run_digest', content: bytes } }), /host_observation_requires_authorization/);
    const other = path.join(f.base, 'other'); fs.mkdirSync(other); const identity = await f.call('register_project', { root: other }); foreignSource = runtimeMcpSource(f.root, identity.projectId);
    await assert.rejects(foreignSource.call('read', { ref: evidence.ref.objectId }), /scope_denied/);
    await assert.rejects(foreignSource.call('search', { scope: f.identity.projectId, kinds: ['evidence'] }), /scope_denied/);
  } finally { await source?.close(); await foreignSource?.close(); await f.close(); }
});

test('index maintenance repairs a preexisting formal digest after sources are moved and unchanged health reads no digest bodies', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'one.json'), JSON.stringify(digest(30, { tokenUsage: { totalTokens: 42 }, changedFiles: Array.from({ length: 91 }, (_, i) => `file-${i}.js`) })));
  const { getRunIndexHealth, backfillRunIndexFromDigests } = require('../out/runIndexMaintenance.js');
  try {
    const bytes = fs.readFileSync(path.join(sourceRoot, 'one.json'));
    const source = { identity: `run-digests:${f.identity.projectId}`, key: 'one.json', hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
    f.store().captureMigrationSource(source, bytes);
    f.store().importRunDigestSource(f.identity.projectId, { source, bytes });
    fs.renameSync(sourceRoot, sourceRoot + '-retained');
    const before = await getRunIndexHealth(f.project, path.resolve(__dirname, '..'), f.root); assert.equal(before.digestCount, 1); assert.equal(before.missingDigestCount, 1);
    const after = await backfillRunIndexFromDigests(f.project, path.resolve(__dirname, '..'), f.root); assert.equal(after.backfilledCount, 1); assert.equal(after.ok, true);
    const entries = await f.call('read_project_run_indexes', { root: f.project }); assert.equal(entries[0].files.length, 91); assert.equal(entries[0].totalTokens, 42);
    const store = f.store(); const ids = new Set(store.rows('SELECT content_id FROM run_digests').map(row => row.content_id)); let decodes = 0; const original = store.content.bind(store);
    store.content = id => { if (ids.has(id)) decodes++; return original(id); };
    try { for (let i = 0; i < 12; i++) assert.equal((await getRunIndexHealth(f.project, '', f.root)).ok, true); assert.equal((await backfillRunIndexFromDigests(f.project, '', f.root)).backfilledCount, 0); } finally { store.content = original; }
    assert.equal(decodes, 0); assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'project_journal.db')), false);
  } finally { await f.close(); }
});

test('the distributed experience CLI reads complete formal evidence after the legacy source is moved', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const value = digest(0, { nodeId: 'step', changedFiles: ['src/target.js'], handoff: { nextAgentBrief: '接续这条正式经验', recommendedFirstActions: ['核对当前事实'] } });
  fs.writeFileSync(path.join(sourceRoot, 'one.json'), JSON.stringify(value));
  try {
    await f.import(); fs.renameSync(sourceRoot, sourceRoot + '-retained');
    const toolRoot = path.join(f.root, 'tools'); fs.mkdirSync(toolRoot);
    const legacyDependency = path.join(toolRoot, 'node_modules', 'sql.js'); fs.mkdirSync(path.join(legacyDependency, 'dist'), { recursive: true });
    for (const file of ['package.json', 'dist/sql-wasm.js', 'dist/sql-wasm.wasm']) fs.copyFileSync(path.resolve(__dirname, '../node_modules/sql.js', file), path.join(legacyDependency, file));
    for (const file of fs.readdirSync(path.resolve(__dirname, '../resources/tools')).filter(name => name.startsWith('solomap-') && name.endsWith('.cjs'))) fs.copyFileSync(path.resolve(__dirname, '../resources/tools', file), path.join(toolRoot, file));
    const cli = path.join(toolRoot, 'solomap-experience.cjs');
    const history = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'history', '--project', f.project, '--global', f.root, '--json', '--full'], { env: f.env })).stdout);
    assert.equal(history.payload.length, 1); assert.equal(history.payload[0].userIntent, value.userIntent); assert.ok(history.payload[0].sourceRef.objectId);
    const handoff = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'handoff', '--project', f.project, '--global', f.root, '--json'], { env: f.env })).stdout); assert.equal(handoff.payload[0].brief, value.handoff.nextAgentBrief);
    const markdown = (await promisify(execFile)(process.execPath, [cli, 'handoff', '--project', f.project, '--global', f.root], { env: f.env })).stdout;
    assert.match(markdown, /接续这条正式经验/);
    assert.match(markdown, new RegExp(`solomap://objects/${handoff.payload[0].sourceRef.objectId}.*revision[=: ]+${handoff.payload[0].sourceRef.revision}`));
    const summary = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'summary', '--project', f.project, '--global', f.root, '--json'], { env: f.env })).stdout); assert.equal(summary.payload.totalRecords, 1); assert.equal(summary.payload.graphRunCount, 1);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'project_journal.db')), false);
  } finally { await f.close(); }
});

test('all retained digest history is searchable while unchanged prompts decode only the three selected bodies', async () => {
  const f = await fixture(); const sourceRoot = path.join(f.project, '.solopreneur', 'run-digests'); fs.mkdirSync(sourceRoot);
  const originals = [];
  for (let i = 0; i < 150; i++) {
    const value = digest(i, { ...(i < 3 ? { nodeId: 'old-match', changedFiles: Array.from({ length: 91 }, (_, j) => `source-${j}.js`) } : {}), unknownRetainedBody: '完整来源🌿'.repeat(15000) });
    const bytes = '\uFEFF' + JSON.stringify(value, null, 2) + '\n'; originals.push({ value, bytes }); fs.writeFileSync(path.join(sourceRoot, `${i}.json`), bytes);
  }
  try {
    const job = await f.import(); assert.equal(job.status, 'completed', job.error); assert.equal(job.progress.imported, 150);
    fs.renameSync(sourceRoot, sourceRoot + '-retained'); await f.reopen();
    const store = f.store(); const ids = new Set(store.rows('SELECT content_id FROM run_digests').map(row => row.content_id));
    const originalContent = store.content.bind(store); let decoded = 0; let decodedBytes = 0;
    const originalRows = store.rows.bind(store); let ranking;
    store.rows = (sql, values) => { if (sql.includes('AS score') && sql.includes('run_digest_signals')) ranking = { sql, values }; return originalRows(sql, values); };
    store.content = id => { const bytes = originalContent(id); if (ids.has(id)) { decoded++; decodedBytes += bytes.length; } return bytes; };
    const originalRead = fs.readFileSync; let oldReads = 0;
    fs.readFileSync = function(file, ...args) { if (String(file).includes('run-digests')) oldReads++; return originalRead.call(this, file, ...args); };
    try {
      for (let i = 0; i < 4; i++) {
        const prompt = await buildExecutionExperiencePrompt(f.project, { nodeId: 'old-match', runKind: 'step', contextText: 'source-90.js' }, f.root);
        assert.ok(prompt.includes(originals[0].value.userIntent), 'a relevant run older than 120 must still be recalled');
      }
    } finally { fs.readFileSync = originalRead; store.content = originalContent; store.rows = originalRows; }
    assert.equal(decoded, 12); assert.equal(oldReads, 0);
    assert.ok(decodedBytes < job.progress.originalBytes / 8, `${decodedBytes} must avoid re-reading the complete ${job.progress.originalBytes} byte history`);
    let cursor; const entries = [];
    do { const page = await f.call('read_run_digests', { root: f.project, limit: 37, ...(cursor === undefined ? {} : { cursor }) }); entries.push(...page.items); cursor = page.nextCursor; } while (cursor !== null);
    assert.equal(entries.length, 150); assert.equal(entries.find(item => item.digest.runId === 'history:0').digest.changedFiles.length, 91);
    const first = entries.find(item => item.digest.runId === 'history:0');
    assert.equal((await f.call('read', { ref: first.ref.objectId, revision: first.ref.revision })).data.content, originals[0].bytes);
    const graph = await readExecutionGraph(f.project, f.root); assert.equal(graph.runCount, 150);
    assert.equal(graph.runs.find(run => run.sourceRunId === 'history:0').changedFiles.length, 91);
    assert.ok(Object.values(graph.experienceNodes).every(node => node.stats.uses === 0 && node.stats.wins === 0), 'historical observation is not proven adoption');
    assert.ok(ranking, 'capture the ranking query executed by the actual prompt');
    const plan = store.rows(`EXPLAIN QUERY PLAN ${ranking.sql}`, ranking.values);
    assert.ok(plan.some(row => /SEARCH d USING INDEX run_digests_project/.test(String(row.detail))));
    assert.ok(plan.filter(row => /SEARCH s USING.*run_digest_signals_lookup/.test(String(row.detail))).length >= 2);
    assert.equal(plan.some(row => /SCAN s\b/.test(String(row.detail))), false);
    process.stdout.write(JSON.stringify({ fixture: f.base, retained: 150, sourceBytes: job.progress.originalBytes, repeatedPrompts: 4, selectedBodyDecodes: decoded, decodedBytes, legacyReads: oldReads, plan }) + '\n');
  } finally { await f.close(); }
});
