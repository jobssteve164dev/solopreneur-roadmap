const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solomap-run-client-'🌿-"));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  const state = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: 'original 🌿 input\n'.repeat(10000), command: 'original command', userMessage: '用户目标', metadata: { interactiveSession: true }, idempotencyKey: 'client-prepare' });
  return { base, root, project, state, store, call, async close() { await ops.close(); store.close(); fs.rmSync(base, { recursive: true, force: true }); } };
}

test('review consumption pins the complete formal decision and launch evidence while later document revisions change', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const input = { root: f.project, executionLogId: 2, parentExecutionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '复核输入', command: 'readonly', userMessage: '目标', launchRequest: { reviewEvidence: { workspaceRoot: f.project, completionCriteria: Array.from({ length: 25 }, (_, i) => `标准${i}`), mainOutput: '完整输出🌿'.repeat(10000) } }, idempotencyKey: 'review-pin-prepare' };
    const review = await f.call('prepare_run', input);
    const scope = { projectId: review.projectId, executionLogId: 2, generation: review.generation, turnId: review.turnId };
    const raw = { status: 'pass', summary: '完整结论🌿'.repeat(10000), criteria: input.launchRequest.reviewEvidence.completionCriteria.map(criterion => ({ criterion, status: 'pass', evidence: ['output:main'], reason: '完整证据' })) };
    const decision = await f.call('write_run_document', { ...scope, purpose: 'review_result', bytes: Buffer.from(JSON.stringify(raw)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'review-pinned-decision' });
    await f.call('patch_run_state', { ...scope, expectedRevision: review.revision, patch: { reviewResultObjectId: decision.objectId, reviewResultRevision: decision.revision }, idempotencyKey: 'review-pinned-pointer' });
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 2); const accepted = await client.readStatus(ref);
    await f.call('write_run_document', { ...scope, purpose: 'review_result', bytes: Buffer.from('{"status":"revise"}').toString('base64'), mimeType: 'application/json', expectedRevision: 1, idempotencyKey: 'review-new-decision' });
    const evidence = await client.readReviewEvidence(ref, accepted);
    assert.deepEqual(evidence.result, raw); assert.deepEqual(evidence.manifest, input.launchRequest.reviewEvidence);
  } finally { await f.close(); }
});

test('late review source reads the completed turn revision while terminal controls still resolve the current turn', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    await f.call('append_run_log', { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('第一轮全文🌿').toString('base64'), idempotencyKey: 'late-review-first-output' });
    const initial = await client.readStatus(ref);
    const first = await client.checkpoint(ref, initial, { action: 'complete', outcome: 'partial', summary: '第一轮结束', idempotencyKey: 'late-review-complete' });
    const source = (await f.call('list_run_states', { root: f.project, pendingConsumer: true })).items[0];
    const second = await client.checkpoint(ref, first, { action: 'start', message: '第二轮任务', idempotencyKey: 'late-review-second-start' });
    await f.call('append_run_log', { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout', sequence: 1, offset: Buffer.byteLength('第一轮全文🌿'), bytes: Buffer.from('第二轮全文🌿').toString('base64'), idempotencyKey: 'late-review-second-output' });
    const pinned = await client.readStatus(ref, source.revision);
    assert.equal(pinned.turnId, source.turnId); assert.equal(pinned.userMessage, '用户目标');
    assert.equal((await client.readData(pinned.outputFilePath, pinned)).toString(), '第一轮全文🌿');
    assert.equal((await client.findConversation(f.project, 1)).status.turnId, second.turnId);
  } finally { await f.close(); }
});

test('the plugin lifecycle client reads the database rather than old status files and preserves CAS on copied status snapshots', async () => {
  const { RunLifecycleClient, runStatusReference, parseRunStatusReference, runDataReference, parseRunDataReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call);
    const ref = runStatusReference(f.project, 1);
    assert.deepEqual(parseRunStatusReference(ref), { root: f.project, executionLogId: 1 });
    assert.deepEqual(parseRunDataReference(runDataReference(ref, 'stdout')), { reference: ref, field: 'stdout' });
    fs.mkdirSync(path.join(f.project, '.solopreneur', 'agent-status'));
    fs.writeFileSync(path.join(f.project, '.solopreneur', 'agent-status', '1.json'), JSON.stringify({ status: 'Failed' }));
    const first = await client.readStatus(ref);
    assert.equal(first.turnId, f.state.turnId);
    assert.equal(first.status, 'Running');
    const second = await client.readStatus(ref);
    await client.writeStatus(ref, { ...first, terminalName: 'actual terminal' });
    await assert.rejects(client.writeStatus(ref, { ...second, status: 'Waiting' }), /revision_conflict/);
    const current = await client.readStatus(ref);
    assert.equal(current.status, 'Running'); assert.equal(current.terminalName, 'actual terminal');
    const serialized = JSON.stringify(current);
    assert.doesNotMatch(serialized, /proof|runSnapshot|checkpointToken/);
    const input = await client.readField(ref, 'prompt');
    assert.equal(input, 'original 🌿 input\n'.repeat(10000));
    await assert.rejects(client.writeStatus(ref, { ...current, workspaceRoot: path.join(f.base, 'other') }), /invalid_run_patch/);
    await assert.rejects(client.writeStatus(ref, { status: 'Waiting' }), /run_status_snapshot_required/);
    assert.equal(await client.readStatus(runStatusReference(f.project, 999)), null);
  } finally { await f.close(); }
});

test('settlement output reads keep the accepted turn boundaries while a later turn appends more bytes', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const identity = { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout' };
    const first = Buffer.from('第一轮完整日志🌿\n'.repeat(12000)); const second = Buffer.from('第二轮日志');
    await f.call('append_run_log', { ...identity, sequence: 0, offset: 0, bytes: first.toString('base64'), idempotencyKey: 'pinned-log-first' });
    const complete = await client.checkpoint(ref, await client.readStatus(ref), { action: 'complete', outcome: 'partial', summary: '第一轮结论', idempotencyKey: 'pinned-log-complete' });
    await client.checkpoint(ref, complete, { action: 'start', message: '下一轮', idempotencyKey: 'pinned-log-start' });
    await f.call('append_run_log', { ...identity, sequence: 1, offset: first.length, bytes: second.toString('base64'), idempotencyKey: 'pinned-log-second' });
    assert.deepEqual(await client.readData(complete.outputFilePath, complete), first);
    const current = await client.readStatus(ref);
    assert.deepEqual(await client.readData(current.outputFilePath, current), second);
    assert.deepEqual(await client.readLog(ref, 'output'), Buffer.concat([first, second]));
  } finally { await f.close(); }
});

test('settlement tail reads fetch only the bounded end of the accepted turn', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const ref = runStatusReference(f.project, 1);
    const first = Buffer.concat([Buffer.alloc(256 * 1024, 65), Buffer.from('第一轮结尾🌿')]);
    const identity = { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout' };
    await f.call('append_run_log', { ...identity, sequence: 0, offset: 0, bytes: first.toString('base64'), idempotencyKey: 'bounded-tail-first' });
    const complete = await new RunLifecycleClient(f.call).checkpoint(ref, await new RunLifecycleClient(f.call).readStatus(ref), { action: 'complete', outcome: 'partial', summary: '第一轮结论', idempotencyKey: 'bounded-tail-complete' });
    const reads = [];
    const client = new RunLifecycleClient(async (operation, input) => {
      if (operation === 'read_run_log') reads.push({ offset: input.offset, limit: input.limit });
      return f.call(operation, input);
    });
    const expected = first.subarray(first.length - 4096);
    assert.deepEqual(await client.readLogTail(ref, 'output', 4096, complete), expected);
    assert.deepEqual(await client.readLogTailInfo(ref, 'output', 4096, complete), { bytes: expected, totalBytes: first.length });
    assert.deepEqual(reads, [
      { offset: first.length - 4096, limit: 4096 },
      { offset: first.length - 4096, limit: 4096 }
    ]);
  } finally { await f.close(); }
});

test('a native reply tail reads only the requested suffix and retains its full byte length', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const reply = Buffer.concat([Buffer.alloc(256 * 1024, 66), Buffer.from('原生回复结尾🌿')]);
    const complete = await f.call('checkpoint_run', {
      projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, proof: f.state.proof,
      expectedRevision: f.state.revision, expectedTurnId: f.state.turnId, action: 'complete', outcome: 'partial',
      summary: '原生回复完成', workspaceEvidenceSource: 'native', nativeReply: reply.toString(), idempotencyKey: 'native-tail-complete'
    });
    const reads = [];
    const client = new RunLifecycleClient(async (operation, input) => {
      if (operation === 'read_run_document') reads.push({ tailBytes: input.tailBytes, purpose: input.purpose });
      return f.call(operation, input);
    });
    const info = await client.readLogTailInfo(runStatusReference(f.project, 1), 'output', 4096, await client.readStatus(runStatusReference(f.project, 1), complete.revision));
    assert.deepEqual(info, { bytes: reply.subarray(reply.length - 4096), totalBytes: reply.length });
    assert.deepEqual(reads, [{ tailBytes: 4096, purpose: `native_reply_${f.state.turnId.replace(/-/g, '')}` }]);
  } finally { await f.close(); }
});

test('the plugin lifecycle client pins multi-page content and logs to the accepted run identity without generating files', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const expected = Buffer.from('full α🌿 output\n'.repeat(12000));
    await f.call('append_run_log', { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: expected.toString('base64'), idempotencyKey: 'client-log' });
    assert.deepEqual(await client.readLog(ref, 'stdout'), expected);
    assert.equal(await client.readField(ref, 'command'), 'original command');
    const states = await client.listStatuses(f.project);
    assert.equal(states.length, 1); assert.equal(states[0].reference, ref);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
    assert.equal(fs.existsSync(path.join(f.root, 'active-conversations')), false);
  } finally { await f.close(); }
});

test('a live log read stops at its accepted head while a concurrent append remains available to the next read', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const expected = Buffer.from('original log bytes\n'.repeat(12000));
    const identity = { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, stream: 'stdout' };
    await f.call('append_run_log', { ...identity, sequence: 0, offset: 0, bytes: expected.toString('base64'), idempotencyKey: 'client-initial-head' });
    let injected = false;
    const client = new RunLifecycleClient(async (operation, input) => {
      const result = await f.call(operation, input);
      if (operation === 'read_run_log' && !injected) {
        injected = true;
        await f.call('append_run_log', { ...identity, sequence: 1, offset: expected.length, bytes: Buffer.from('newly accepted bytes').toString('base64'), idempotencyKey: 'client-concurrent-append' });
      }
      return result;
    });
    const ref = runStatusReference(f.project, 1);
    assert.deepEqual(await client.readLog(ref, 'stdout'), expected);
    assert.deepEqual(await client.readLog(ref, 'stdout'), Buffer.concat([expected, Buffer.from('newly accepted bytes')]));
  } finally { await f.close(); }
});

test('a plugin write retry recovers its original committed status after a newer disjoint update', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const before = await client.readStatus(ref);
    const first = await client.writeStatus(ref, { ...before, terminalName: 'accepted terminal' });
    await client.writeStatus(ref, { ...first, waitingSince: '2026-10-09T12:00:00Z' });
    const replay = await client.writeStatus(ref, { ...before, terminalName: 'accepted terminal' });
    assert.equal(replay.terminalName, 'accepted terminal'); assert.equal(replay.waitingSince, undefined);
    const current = await client.readStatus(ref);
    assert.equal(current.waitingSince, '2026-10-09T12:00:00Z');
  } finally { await f.close(); }
});

test('a multi-page prompt read keeps its original revision when a producer changes the input after its first page', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    let injected = false;
    const client = new RunLifecycleClient(async (operation, input) => {
      const result = await f.call(operation, input);
      if (operation === 'read' && input.view === 'content' && !injected) {
        injected = true;
        await f.call('patch_run_inputs', { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation, expectedRevision: f.state.revision, prompt: 'updated input', command: 'new command', idempotencyKey: 'client-change-input' });
      }
      return result;
    });
    const ref = runStatusReference(f.project, 1);
    assert.equal(await client.readField(ref, 'prompt'), 'original 🌿 input\n'.repeat(10000));
    assert.equal(await client.readField(ref, 'prompt'), 'updated input');
  } finally { await f.close(); }
});

test('plugin native binding consumers use formal identity revisions and reject old-owner writes without session files', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    assert.equal(await client.readBinding(ref), null); assert.equal(await client.getResumableSession(ref), null);
    const before = await client.readStatus(ref);
    const binding = await client.writeBinding(ref, before, { expectedHeadRevision: 0, seed: { runId: '1', provider: 'claude', workspaceRoot: f.project, cliPath: 'claude', bindingNonce: '1'.repeat(64), method: 'caller_assigned', contract: 'official_stable', createdAt: f.state.status.startedAt }, idempotencyKey: 'client-native-seed' });
    const nativeId = 'a'.repeat(32);
    const planned = await client.writeBinding(ref, await client.readStatus(ref), { expectedHeadRevision: binding.headRevision, revision: { sessionId: nativeId, method: 'caller_assigned', contract: 'official_stable', state: 'planned' }, idempotencyKey: 'client-native-planned' });
    assert.equal(await client.getResumableSession(ref), null);
    const capturedStatus = await client.readStatus(ref);
    const confirmed = await client.writeBinding(ref, capturedStatus, { expectedHeadRevision: planned.headRevision, confirmSessionId: nativeId, evidence: { source: 'official_native_observation' }, idempotencyKey: 'client-native-confirm' });
    assert.equal(JSON.parse((await client.readData(capturedStatus.sessionFilePath, capturedStatus)).toString()).headRevision, planned.headRevision);
    assert.equal((await client.readBinding(ref, capturedStatus)).headRevision, planned.headRevision);
    assert.equal((await client.readData(capturedStatus.codexHomeFilePath, capturedStatus)).toString(), '');
    assert.equal(confirmed.headRevision, 3);
    const resumable = await client.getResumableSession(ref);
    assert.equal(resumable.sessionId, nativeId); assert.equal(resumable.revision, 3); assert.equal(resumable.workspaceRoot, f.project);
    assert.equal((await client.readBinding(ref)).headRevision, 3);
    const current = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    await f.call('claim_run', { projectId: current.projectId, executionLogId: 1, expectedRevision: current.revision, idempotencyKey: 'client-native-replacement-owner' });
    await assert.rejects(client.writeBinding(ref, capturedStatus, { expectedHeadRevision: 3, revision: { method: 'caller_assigned', contract: 'official_stable', state: 'unavailable' }, idempotencyKey: 'client-old-native-writer' }), /run_owner_conflict/);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('plugin output consumers retain stdout and stderr in committed order without duplicating retried bytes', async () => {
  const { RunLifecycleClient, runStatusReference, parseRunDataReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const identity = { projectId: f.state.projectId, executionLogId: 1, generation: f.state.generation };
    const first = Buffer.from('first stdout🌿'); const error = Buffer.from([255, 0, 128, 10]); const final = Buffer.from('final stdout');
    await f.call('append_run_log', { ...identity, stream: 'stdout', sequence: 0, offset: 0, bytes: first.toString('base64'), idempotencyKey: 'ordered-first' });
    const errorIntent = { ...identity, stream: 'stderr', sequence: 0, offset: 0, bytes: error.toString('base64'), idempotencyKey: 'ordered-stderr' };
    await f.call('append_run_log', errorIntent);
    await f.call('append_run_log', { ...identity, stream: 'stdout', sequence: 1, offset: first.length, bytes: final.toString('base64'), idempotencyKey: 'ordered-final' });
    await f.call('append_run_log', errorIntent);
    assert.deepEqual(await client.readLog(ref, 'output'), Buffer.concat([first, error, final]));
    assert.deepEqual(await client.readLog(ref, 'stdout'), Buffer.concat([first, final]));
    assert.deepEqual(await client.readLog(ref, 'stderr'), error);
    assert.equal(parseRunDataReference((await client.readStatus(ref)).outputFilePath).field, 'output');
    await assert.rejects(f.call('append_run_log', { ...errorIntent, stream: 'output', idempotencyKey: 'forge-output' }), /reserved_log_stream/);
    assert.deepEqual(await client.readLog(ref, 'output'), Buffer.concat([first, error, final]));
  } finally { await f.close(); }
});

test('plugin start, completion and close actions bind the accepted turn and replay without copied checkpoint commands', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const before = await client.readStatus(ref);
    const fields = { action: 'complete', outcome: 'partial', summary: '实际结果', idempotencyKey: 'client-formal-complete' };
    const done = await client.checkpoint(ref, before, fields);
    assert.equal(done.status, 'In Progress'); assert.equal(done.checkpointSummary, '实际结果');
    const started = await client.checkpoint(ref, done, { action: 'start', message: '下一轮目标', idempotencyKey: 'client-formal-start' });
    assert.equal(started.status, 'Running'); assert.equal(started.executionLogId, 2);
    const replay = await client.checkpoint(ref, before, fields);
    assert.equal(replay.executionLogId, 1); assert.equal(replay.checkpointSequence, done.checkpointSequence);
    await assert.rejects(client.checkpoint(ref, before, { ...fields, idempotencyKey: 'client-unaccepted-late-result' }), /revision_conflict/);
    const closed = await client.checkpoint(ref, started, { action: 'session-close', exitCode: 143, idempotencyKey: 'client-formal-close' });
    assert.equal(closed.interactiveSessionClosed, true); assert.equal(closed.status, 'Failed');
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('journal conversation aliases resolve the same formal run while each turn keeps its original report and evidence', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const before = await client.readStatus(ref);
    const report = { schemaVersion: 1, summary: '第一轮报告', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'first result');
    const first = await client.checkpoint(ref, before, { action: 'complete', outcome: 'candidate_complete', summary: '第一轮完整结论', report, idempotencyKey: 'client-evidence-complete' });
    const firstChanges = await client.readField(ref, 'changes', first);
    assert.match(firstChanges, /result\.txt/);
    const second = await client.checkpoint(ref, first, { action: 'start', message: '第二轮', idempotencyKey: 'client-evidence-start' });
    const resolved = await client.findConversation(f.project, Number(second.executionLogId));
    assert.equal(resolved.reference, ref); assert.equal(resolved.turnId, (await f.call('read_run_state', { root: f.project, executionLogId: 1 })).turnId);
    assert.equal((await client.findConversation(f.project, 1)).reference, ref);
    assert.equal(await client.findConversation(f.project, 999), null);
    assert.equal(await client.readField(ref, 'changes', first), firstChanges);
    assert.equal(await client.readField(ref, 'changes', second), '');
    assert.deepEqual(JSON.parse((await client.readData(first.completionDecisionFilePath, first)).toString('utf8')), { markCompleted: true, reason: '第一轮完整结论', outcome: 'candidate_complete' });
    assert.equal((await client.readReport(ref, first)).availability, 'available');
    assert.deepEqual((await client.readReport(ref, first)).report, report);
    assert.equal(await client.readReport(ref, second), null);
    const other = await f.call('prepare_run', { root: f.project, executionLogId: 3, nodeId: 'another', runKind: 'step', prompt: 'other prompt', command: 'true', userMessage: 'other', idempotencyKey: 'client-other-run' });
    assert.notEqual(other.runId, f.state.runId);
    await assert.rejects(client.readField(runStatusReference(f.project, 3), 'changes', first), /run_status_snapshot_required/);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('a settled status snapshot reads the workspace evidence revision it committed after a later evidence update', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const { workspaceDocumentPurpose } = require('../out/runWorkspace.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    fs.writeFileSync(path.join(f.project, 'delivered.txt'), 'actual result');
    const settled = await client.checkpoint(ref, await client.readStatus(ref), { action: 'complete', outcome: 'partial', summary: '已经交付', idempotencyKey: 'pin-workspace-evidence' });
    const state = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    const purpose = workspaceDocumentPurpose(state.turnId, 'changes');
    const original = await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose });
    const expected = Buffer.from(original.bytes, 'base64').toString();
    await f.call('write_run_document', { projectId: state.projectId, executionLogId: 1, generation: state.generation, purpose, bytes: Buffer.from('later independent evidence').toString('base64'), mimeType: 'text/plain', expectedRevision: original.revision, idempotencyKey: 'later-workspace-evidence' });
    assert.equal(await client.readField(ref, 'changes', settled), expected);
  } finally { await f.close(); }
});

test('the plugin stop consumer closes a prepared task through its captured identity and rejects a stale turn', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const captured = await client.readStatus(ref);
    const settled = await client.checkpoint(ref, captured, { action: 'complete', outcome: 'partial', summary: '第一轮', idempotencyKey: 'stop-prior-complete' });
    const next = await client.checkpoint(ref, settled, { action: 'start', message: '新一轮', idempotencyKey: 'stop-new-turn' });
    await assert.rejects(client.stop(ref, captured, '停止旧轮', 'stop-captured-old-turn'), /revision_conflict|checkpoint_turn_conflict/);
    assert.equal((await client.readStatus(ref)).interactiveSessionClosed, undefined);
    const stopped = await client.stop(ref, next, '用户停止当前对话', 'stop-current-turn');
    assert.equal(stopped.interactiveSessionClosed, true); assert.equal(stopped.status, 'Failed');
    assert.equal((await client.stop(ref, next, '用户停止当前对话', 'stop-current-turn')).checkpointSummary, '用户停止当前对话');
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('a sealed report retains its exact revision when its live object is later corrected', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, 1);
    const report = { schemaVersion: 1, summary: '原轮正式报告', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const done = await client.checkpoint(ref, await client.readStatus(ref), { action: 'complete', outcome: 'candidate_complete', summary: '正式完成', report, idempotencyKey: 'report-seal-complete' });
    const original = await client.readReport(ref, done);
    await f.call('write', { kind: 'report', action: 'patch', scope: f.state.projectId, objectId: original.objectId, expectedRevision: original.revision, data: { content: JSON.stringify({ ...report, summary: '后来的新修订' }) }, idempotencyKey: 'report-seal-later-correction' });
    assert.deepEqual((await client.readReport(ref, done)).report, report, 'a later report revision cannot rewrite accepted completion evidence');
    assert.equal(done.taskReportRevision, original.revision);
  } finally { await f.close(); }
});

test('a formal launch stores the original roadmap bytes once without creating a per-run backup directory', async () => {
  const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const bytes = Buffer.from('id,title,status\nstep,用户原路线图🌿,Pending\n');
    fs.writeFileSync(path.join(f.project, '.solopreneur', 'roadmap.csv'), bytes);
    const request = { root: f.project, launchIntentId: 'source-roadmap-backup', nodeId: '__solo__', runKind: 'solo', prompt: '原始请求', command: 'actual command', userMessage: '原始请求', metadata: { launchIntentHash: 'same-hash', captureRoadmapBackup: true }, idempotencyKey: 'source-roadmap-backup' };
    const run = await f.call('prepare_run_intent', request);
    fs.appendFileSync(path.join(f.project, '.solopreneur', 'roadmap.csv'), 'another,后来用户新条目,Completed\n');
    const readFile = fs.promises.readFile;
    let repeatedBackupReads = 0;
    fs.promises.readFile = async (file, ...args) => {
      if (String(file) === path.join(f.project, '.solopreneur', 'roadmap.csv')) repeatedBackupReads++;
      return readFile(file, ...args);
    };
    let replay;
    try { replay = await f.call('prepare_run_intent', request); }
    finally { fs.promises.readFile = readFile; }
    assert.equal(replay.runId, run.runId);
    assert.equal(repeatedBackupReads, 0, 'a replay must recover its accepted snapshot without reading a new workspace');
    const client = new RunLifecycleClient(f.call); const ref = runStatusReference(f.project, run.status.rootExecutionLogId);
    const status = await client.readStatus(ref);
    assert.deepEqual(await client.readData(runDataReference(ref, 'roadmap-backup'), status), bytes);
    assert.ok(status.roadmapBackupObjectId); assert.equal(status.roadmapBackupRevision, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')).sort(), ['project.json', 'roadmap.csv']);
  } finally { await f.close(); }
});
