const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { importAgentRuns } = require('../out/projectDataMigration.js');
const { registerLearningTask, writeLearningJson } = require('./fixtures/legacy-task-report.cjs');
const { createSessionBindingValue, appendSessionBindingValue } = require('../out/sessionIdentity.js');
const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
const { prepareAgentRun } = require('../out/agentRunPreparation.js');

async function history(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-historical-lifecycle-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const closeCallbacks = []; let owner = await openAnalysisOwner({ after: close => closeCallbacks.push(close) }, root, [{ path: project }]);
  t.after(async () => { for (const close of closeCallbacks.splice(0).reverse()) await close(); });
  const sourceRoot = path.join(project, '.solopreneur', 'agent-runs'), runDir = path.join(sourceRoot, '__solo__', '71'); fs.mkdirSync(runDir, { recursive: true });
  const startedAt = '2026-09-01T10:00:00.000Z', finishedAt = '2026-09-01T10:01:00.000Z';
  const taskId = registerLearningTask(project, { executionLogId: 71, runDir, userMessage: '原始历史用户需求', startedAt });
  const sessionId = crypto.randomUUID();
  let binding = createSessionBindingValue({ runId: '71', provider: 'claude', workspaceRoot: project, cliPath: 'claude', bindingNonce: 'original-binding-nonce', method: 'caller_assigned', contract: 'official_stable', createdAt: startedAt, providerContext: { retained: '完整源上下文' } });
  binding = appendSessionBindingValue(binding, 1, { sessionId, method: 'caller_assigned', contract: 'official_stable', state: 'planned', createdAt: startedAt });
  binding = appendSessionBindingValue(binding, 2, { sessionId, supersedesRevision: 2, method: 'caller_assigned', contract: 'official_stable', state: 'confirmed', createdAt: finishedAt, confirmedAt: finishedAt, evidence: { source: 'official_native_observation', original: '完整身份来源' }, providerContext: { retained: '完整源上下文' } });
  fs.writeFileSync(path.join(runDir, 'session.json'), JSON.stringify(binding));
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), '完整历史提示词🌿'.repeat(1000));
  fs.writeFileSync(path.join(runDir, 'command.txt'), 'claude original arguments');
  fs.writeFileSync(path.join(runDir, 'output.log'), '完整历史原字节输出🌿'.repeat(1000));
  fs.writeFileSync(path.join(runDir, 'started_at'), startedAt);
  writeLearningJson(path.join(runDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: project, taskId, executionLogId: 71, turnId: '1:complete', createdAt: finishedAt, report: { summary: '历史首轮结果', decisions: ['保留完整历史'] } });
  const status = { learningTaskId: taskId, workspaceRoot: project, nodeId: '__solo__', executionLogId: 71, rootExecutionLogId: 71, runKind: 'solo',
    agentCli: 'claude', selectedModel: 'original-model', status: 'Waiting', interactiveSession: true, startedAt, turnStartedAt: startedAt, finishedAt,
    checkpointSequence: 1, checkpointOutcome: 'partial', checkpointSummary: '历史首轮结果', checkpointNext: '继续原任务',
    bindingNonce: 'original-binding-nonce', sessionProvider: 'claude', nativeSessionId: sessionId, nativeSessionIdIsCurrent: true, sessionBindingHeadRevision: 3,
    sessionFilePath: path.join(runDir, 'session.json'), promptFilePath: path.join(runDir, 'prompt.txt'), commandFilePath: path.join(runDir, 'command.txt'), outputFilePath: path.join(runDir, 'output.log'), globalDataPath: root };
  const statuses = path.join(project, '.solopreneur', 'agent-status'); fs.mkdirSync(statuses);
  const statusFile = path.join(statuses, '71.json'); writeLearningJson(statusFile, status);
  const projectId = owner.projectIds.get(project); owner.store.importProjectJournal(projectId, { id: 71, nodeId: '__solo__', timestamp: startedAt, agentCli: 'claude', command: 'claude original arguments', output: '原项目日志完整内容', status: 'Waiting' });
  const client = new RunLifecycleClient((operation, input) => owner.ops({ operation, input }), root);
  return { get store() { return owner.store; }, get ops() { return owner.ops; }, base, root, project, projectId, sourceRoot, runDir, statuses, statusFile, status, taskId, binding, client,
    restart: async () => { for (const close of closeCallbacks.splice(0).reverse()) await close(); owner = await openAnalysisOwner({ after: close => closeCallbacks.push(close) }, root, [{ path: project }]); } };
}

test('historical noncurrent binding observation preserves its actual revision while importing the complete later binding', async t => {
  const f = await history(t);
  f.status.sessionBindingHeadRevision = 1;
  f.status.nativeSessionIdIsCurrent = false;
  f.status.nativeSessionId = '';
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const state = f.store.readRunState(f.projectId, 71);
  assert.equal(state.status.sessionBindingHeadRevision, 1);
  assert.equal(state.status.nativeSessionIdIsCurrent, false);
  const found = await f.client.findConversation(f.project, 71);
  assert.deepEqual(await f.client.readBinding(found.reference, found.status), f.binding);
});

test('historical noncurrent binding observation cannot name a nonexistent revision', async t => {
  const f = await history(t);
  f.status.sessionBindingHeadRevision = 9;
  f.status.nativeSessionIdIsCurrent = false;
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.error.includes('historical_run_session_mismatch')));
  assert.equal(await f.client.findConversation(f.project, 71), null);
});

test('settled historical run inputs and status enter the exact recycling plan after full lifecycle adoption', async t => {
  const f = await history(t);
  const launcher = '#!/bin/bash\n# 原历史完整 userMessage 和启动状态\nclaude original arguments\n';
  fs.writeFileSync(path.join(f.runDir, 'run-agent.sh'), launcher);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  const files = (await new MigrationRecycling(f.store).prepare()).files.map(item => item.path);
  for (const name of ['prompt.txt', 'command.txt', 'output.log', 'session.json', 'started_at', 'task-report-1.json', 'run-agent.sh']) assert.ok(files.includes(path.join(f.runDir, name)), `${name} must be available for exact approval`);
  const artifact = await f.ops({ operation: 'read_run_artifact', input: { root: f.project, executionLogId: 71, relativePath: '__solo__/71/run-agent.sh' } });
  assert.equal(Buffer.from(artifact.bytes, 'base64').toString(), launcher);
  assert.ok(files.includes(f.statusFile));
  assert.equal((await f.client.findConversation(f.project, 71)).status.learningTaskId, f.taskId);
});

test('a registered task definition remains outside recycling while one of its original runs has a live legacy owner', async t => {
  const f = await history(t);
  f.status.agentPid = process.pid;
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  assert.deepEqual((await new MigrationRecycling(f.store).prepare()).files, []);
});

test('a legacy owner becoming live after adoption excludes the same run files and task definition from recycling', async t => {
  const f = await history(t);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  f.status.agentPid = process.pid;
  writeLearningJson(f.statusFile, f.status);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  assert.deepEqual((await new MigrationRecycling(f.store).prepare()).files, []);
});

test('the exact status-declared historical input remains readable and recyclable under its original custom filename', async t => {
  const f = await history(t);
  const input = path.join(f.runDir, 'original-user-input.txt');
  const body = '原声明文件的完整输入🌿'.repeat(1000);
  fs.writeFileSync(input, body); f.status.promptFilePath = input;
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.equal(await f.client.readField(found.reference, 'prompt', found.status), body);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  assert.ok((await new MigrationRecycling(f.store).prepare()).files.some(item => item.path === input));
});

test('a missing optional changes artifact is recorded as a historical gap without blocking the remaining original run', async t => {
  const f = await history(t);
  f.status.changesFilePath = path.join(f.runDir, 'changes.txt');
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.retainedGaps.some(item => item.source === f.status.changesFilePath && item.error === 'historical_optional_artifact_missing'));
  const found = await f.client.findConversation(f.project, 71);
  assert.ok(found);
  assert.equal(fs.existsSync(f.status.changesFilePath), false);
  assert.equal(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes.toString()).changesFilePath, f.status.changesFilePath);
});

test('an unverifiable legacy native session remains historical evidence without gaining a resumable identity', async t => {
  const f = await history(t);
  const home = path.join(f.base, 'empty-native-home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(f.runDir, 'codex-home.txt'), home);
  fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify({ version: 1, sessionId: f.binding.revisions.at(-1).sessionId, source: 'legacy_provider_observation', updatedAt: f.status.startedAt }));
  f.status.agentCli = 'codex'; f.status.sessionProvider = 'codex'; f.status.nativeSessionIdIsCurrent = false;
  f.status.sessionBindingHeadRevision = 1; f.status.codexHomeFilePath = path.join(f.runDir, 'codex-home.txt');
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  const binding = await f.client.readBinding(found.reference, found.status);
  assert.equal(binding.revisions.at(-1).state, 'unavailable');
  assert.equal(binding.revisions.at(-1).sessionId, f.binding.revisions.at(-1).sessionId);
  assert.equal(await f.client.getResumableSession(found.reference), null);
  assert.equal(found.status.nativeSessionIdIsCurrent, false);
});

test('a missing noncurrent session file keeps its exact absence and does not block other complete history', async t => {
  const f = await history(t);
  fs.renameSync(path.join(f.runDir, 'session.json'), path.join(f.base, 'test-owned-session-original.json'));
  f.status.nativeSessionIdIsCurrent = false; f.status.nativeSessionId = '';
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.retainedGaps.some(item => item.source === f.status.sessionFilePath && item.error === 'historical_optional_artifact_missing'));
  const found = await f.client.findConversation(f.project, 71);
  assert.equal(await f.client.readBinding(found.reference, found.status), null);
  assert.equal(fs.existsSync(f.status.sessionFilePath), false);
});

test('historical interactive continuation keeps the root run and the current journal turn in the same task', async t => {
  const f = await history(t);
  registerLearningTask(f.project, { executionLogId: 72, runDir: f.runDir, parentExecutionLogId: 71, userMessage: '继续原任务', startedAt: f.status.startedAt });
  f.store.importProjectJournal(f.projectId, { id: 72, nodeId: '__solo__', timestamp: f.status.startedAt, agentCli: 'claude', command: 'claude original arguments', output: '当前续轮完整日志', status: 'Waiting' });
  f.status.executionLogId = 72;
  f.status.runKind = 'solo_continue';
  f.status.checkpointSequence = 2;
  writeLearningJson(path.join(f.runDir, 'task-report-2.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: 72, turnId: '2:complete', createdAt: f.status.finishedAt, report: { summary: '真实续轮结果' } });
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const root = f.store.readRunState(f.projectId, 71);
  const current = await f.client.findConversation(f.project, 72);
  assert.equal(current.runId, root.runId);
  assert.equal(current.status.learningTaskId, f.taskId);
  assert.equal(f.store.resolveRunConversation(f.projectId, 72).state.taskId, root.taskId);
  assert.equal(root.status.rootExecutionLogId, 71);
  const captured = f.store.readMigrationSource(`agent-status:${f.project}`, '71.json');
  assert.equal(JSON.parse(captured.bytes.toString()).executionLogId, 72);
  assert.equal(f.store.readRunTurnJournal(f.projectId, 71).executionLogId, 72);
  assert.equal(f.store.readProjectJournal(f.projectId, { executionLogId: 71 }).logs[0].output, '原项目日志完整内容');
  assert.equal((await f.client.readReport(current.reference, current.status)).report.summary, '真实续轮结果');
  const earlier = await f.client.findConversationTurn(f.project, 71);
  assert.equal((await f.client.readReport(earlier.reference, earlier.status)).report.summary, '历史首轮结果');
  const snapshot = await require('../out/runLifecycleClient.js').readConversationLogSnapshot(f.client, f.project, 71);
  assert.equal(snapshot.stdout.toString(), '原项目日志完整内容');
  const before = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await assert.rejects(f.client.checkpoint(earlier.reference, earlier.status, { action: 'complete', outcome: 'partial', summary: 'cannot mutate history', idempotencyKey: 'history-read-only' }), /historical_turn_read_only/);
  await assert.rejects(f.client.writeStatus(earlier.reference, earlier.status), /historical_turn_read_only/);
  earlier.status.checkpointSummary = 'cannot overwrite the real current turn';
  await assert.rejects(f.client.writeStatus(earlier.reference, earlier.status), /historical_turn_read_only/);
  assert.deepEqual(f.store.readRunState(f.projectId, 71), root);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), before);
});

test('three historical interactive turns retain every verified journal and report without inventing old control versions', async t => {
  const f = await history(t);
  for (const id of [72, 73]) {
    registerLearningTask(f.project, { executionLogId: id, runDir: f.runDir, parentExecutionLogId: 71, userMessage: `真实续轮${id}`, startedAt: f.status.startedAt });
    f.store.importProjectJournal(f.projectId, { id, nodeId: '__solo__', timestamp: f.status.startedAt, agentCli: 'claude', command: 'actual command', output: `真实轮次正文${id}`, status: 'Waiting' });
    writeLearningJson(path.join(f.runDir, `task-report-${id - 70}.json`), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: id, turnId: `${id - 70}:complete`, createdAt: f.status.finishedAt, report: { summary: `真实报告${id}` } });
  }
  f.status.executionLogId = 73; f.status.checkpointSequence = 3; f.status.runKind = 'solo_continue';
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const latest = await f.client.findConversation(f.project, 73);
  for (const id of [71, 72, 73]) {
    const found = await f.client.findConversationTurn(f.project, id);
    assert.equal(found.runId, latest.runId);
    const report = await f.client.readReport(found.reference, found.status);
    assert.equal(report.report.summary, id === 71 ? '历史首轮结果' : `真实报告${id}`);
    const journal = await f.client.readJournal(found.reference, found.status);
    assert.equal(journal.executionLogId, id);
    if (id === 72) assert.equal(await f.client.readField(found.reference, 'command', found.status), 'actual command');
  }
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_control_revisions').reduce((n, row) => n + row.n, 0), 1);
});

test('continuing an unadopted historical conversation first joins the same formal task and preserves its complete original source', async t => {
  const f = await history(t);
  const originals = new Map([f.statusFile, ...fs.readdirSync(f.runDir).map(name => path.join(f.runDir, name))].map(file => [file, fs.readFileSync(file)]));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  const adopted = await f.client.adoptConversationHistory(f.project, 71);
  assert.equal(adopted.status.nativeSessionId, f.binding.revisions.at(-1).sessionId);
  assert.equal((await f.client.readData(require('../out/runLifecycleClient.js').runDataReference(adopted.reference, 'output'), adopted.status)).toString('utf8'), fs.readFileSync(path.join(f.runDir, 'output.log'), 'utf8'));
  const next = await prepareAgentRun({ agentCli: 'claude', selectedModel: 'original-model', prompt: '继续用户原始任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 0,
    launchIntentId: 'historical-action-continuation', userMessage: '继续处理完整原始目标', runKind: 'solo_continue', globalDataPath: f.root, taskPermissionMode: 'auto',
    nativeSessionId: adopted.status.nativeSessionId, continuation: true, parentExecutionLogId: 71, expectedParentTurnId: adopted.turnId }, (operation, input) => f.ops({operation, input}));
  assert.equal(next.taskId, f.store.readRunState(f.projectId,71).taskId);
  assert.notEqual(next.turnId, adopted.turnId);
  const before = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  assert.deepEqual(await f.client.adoptConversationHistory(f.project,71), adopted);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'solomap.db-wal')),before,'an already adopted history lookup cannot restart migration');
  for(const [file,bytes] of originals) assert.deepEqual(fs.readFileSync(file),bytes);
});

test('concurrent history adoption shares one background import and repeated adoption reads no retained files', async t => {
  const f = await history(t);
  const adopted = await Promise.all(Array.from({length:8},()=>f.client.adoptConversationHistory(f.project,71)));
  assert.ok(adopted.every(value=>value.runId===adopted[0].runId));
  assert.equal(f.store.migrationJobCount(),1);
  const job = f.store.migrationJobs()[0];
  const brief = await f.ops({operation:'migration_status',input:{jobId:job.jobId,metadataOnly:true}});
  assert.deepEqual(Object.keys(brief).sort(),['error','jobId','status']);
  const readSync=fs.readFileSync, readAsync=fs.promises.readFile;
  let retainedBytes=0, projectMetadataBytes=0;
  const measure=(file,bytes)=>{
    const target=String(file);
    if(target.startsWith(f.sourceRoot+path.sep)||target.startsWith(f.statuses+path.sep)||target===path.join(f.project,'.agent_status.json'))retainedBytes+=Buffer.byteLength(bytes);
    else if(target.startsWith(f.project+path.sep))projectMetadataBytes+=Buffer.byteLength(bytes);
    return bytes;
  };
  fs.readFileSync=function(file,...args){return measure(file,readSync.call(this,file,...args));};
  fs.promises.readFile=async function(file,...args){return measure(file,await readAsync.call(this,file,...args));};
  const wal=readSync(path.join(f.root,'solomap.db-wal'));
  try{for(let i=0;i<20;i++)assert.equal((await f.client.adoptConversationHistory(f.project,71)).runId,adopted[0].runId);}
  finally{fs.readFileSync=readSync;fs.promises.readFile=readAsync;}
  assert.equal(retainedBytes,0);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'solomap.db-wal')),wal);
  t.diagnostic(`concurrentRequests=8 migrationJobs=1 repeatedRequests=20 retainedBytesRead=${retainedBytes} projectMetadataBytesRead=${projectMetadataBytes} unchangedWal=true`);
});

test('a failed history import can resume in the same job after its retained source is restored', async t => {
  const f=await history(t),retained=path.join(f.base,'retained-history-source');
  fs.renameSync(f.sourceRoot,retained);
  await assert.rejects(f.client.adoptConversationHistory(f.project,71),/ENOENT/);
  const job=f.store.migrationJobs()[0];assert.equal(job.status,'failed');
  fs.renameSync(retained,f.sourceRoot);
  const values=await Promise.all(Array.from({length:8},()=>f.client.adoptConversationHistory(f.project,71)));
  assert.ok(values.every(value=>value&&value.runId===values[0].runId));
  assert.equal(f.store.migrationJobCount(),1);assert.equal(f.store.readMigrationJob(job.jobId).status,'completed');
});

test('history adoption explicitly retries its own conflicted job when the requested conversation is still missing', async t => {
  const f = await history(t);
  const job = f.store.enqueueMemoryMigration({ collection: 'agent-runs', sourceRoot: f.sourceRoot, projectRoot: f.project }, `conversation-history-adoption-v1:${f.project}`);
  const progress = { conflicts: [{ source: 'older-unrelated-run.json', error: 'historical_run_identity_ambiguous' }] };
  f.store.updateMigrationJob(job.jobId, 'completed_with_conflicts', progress);

  const adopted = await f.client.adoptConversationHistory(f.project, 71);

  assert.ok(adopted);
  assert.equal(adopted.status.executionLogId, 71);
  assert.equal(f.store.readMigrationJob(job.jobId).status, 'completed');
});

test('completed history adoption also discovers a later retained conversation without creating a second import job', async t => {
  const f=await history(t);const original=await f.client.adoptConversationHistory(f.project,71);
  const dir=path.join(f.sourceRoot,'__solo__','72');fs.mkdirSync(dir);
  const task=require('./fixtures/legacy-task-report.cjs');const taskId=task.registerLearningTask(f.project,{executionLogId:72,runDir:dir,userMessage:'另一段完整原始历史目标',startedAt:f.status.startedAt});
  for(const name of ['prompt.txt','command.txt','output.log','started_at'])fs.copyFileSync(path.join(f.runDir,name),path.join(dir,name));
  const binding=structuredClone(f.binding);binding.runId='72';const sessionId=crypto.randomUUID();for(const revision of binding.revisions)if(revision.sessionId)revision.sessionId=sessionId;
  fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(binding));
  const status={...f.status,learningTaskId:taskId,executionLogId:72,rootExecutionLogId:72,nativeSessionId:sessionId,...Object.fromEntries([['sessionFilePath','session.json'],['promptFilePath','prompt.txt'],['commandFilePath','command.txt'],['outputFilePath','output.log']].map(([key,name])=>[key,path.join(dir,name)]))};
  fs.writeFileSync(path.join(f.statuses,'72.json'),JSON.stringify(status));
  f.store.importProjectJournal(f.projectId,{id:72,nodeId:'__solo__',timestamp:f.status.startedAt,agentCli:'claude',command:'claude original arguments',output:'另一段历史完整结果',status:'Waiting'});
  const later=await f.client.adoptConversationHistory(f.project,72);
  assert.ok(later);assert.notEqual(f.store.readRunState(f.projectId,72).taskId,f.store.readRunState(f.projectId,71).taskId);assert.equal(later.status.nativeSessionId,sessionId);
  assert.equal(f.store.migrationJobCount(),1);assert.equal((await f.client.findConversation(f.project,71)).runId,original.runId);
});

for (const existing of [false, true]) test(`completed historical Solo runs without a completion attachment enter the durable queue${existing ? ' when discovered again' : ''}`, async t => {
  const f = await history(t), status = { ...f.status, status: 'In Progress', interactiveSession: false };
  delete status.checkpointOutcome; delete status.checkpointSummary;
  writeLearningJson(f.statusFile, status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const original = f.store.readRunState(f.projectId, 71);
  if (existing) {
    // Exact test-only model of the previous importer, which captured the run but omitted its queue source.
    f.store.db.run('DELETE FROM run_consumer_sources WHERE run_id=?', [original.runId]);
    assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  }
  const queued = f.store.listRunStates({ projectId: f.projectId, pendingConsumer: true }).items;
  assert.equal(queued.length, 1); assert.equal(queued[0].runId, original.runId); assert.equal(queued[0].turnId, original.turnId);
  assert.equal(queued[0].revision, original.revision); assert.equal(queued[0].taskId, original.taskId);
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-run-source')); fs.renameSync(f.statuses, path.join(f.base, 'retained-status-source'));
  await f.restart();
  assert.deepEqual(f.store.listRunStates({ projectId: f.projectId, pendingConsumer: true }).items, queued);
});

test('historical queue rediscovery leaves an already accepted settlement and a newer formal state alone', async t => {
  const f = await history(t), status = { ...f.status, status: 'In Progress', interactiveSession: false };
  delete status.checkpointOutcome; delete status.checkpointSummary; writeLearningJson(f.statusFile, status);
  await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  const original = f.store.readRunState(f.projectId, 71);
  const queued = f.store.rows('SELECT * FROM run_consumer_sources WHERE run_id=?', [original.runId]); assert.equal(queued.length, 1);
  const scope = { projectId: f.projectId, executionLogId: 71, generation: original.generation, expectedRevision: original.revision, expectedTurnId: original.turnId };
  const lease = await f.ops({ operation: 'claim_run_consumer', input: { ...scope, owner: await require('../out/agentRunPreparation.js').getAgentRunDeliveryOwner() } });
  const journal = f.store.readRunTurnJournal(f.projectId, 71);
  await f.ops({ operation: 'commit_run_settlement', input: { ...scope, token: lease.token, journal: { agentCli: 'claude', command: 'claude original arguments', output: '历史对话已正式结算', status: 'Completed' }, digest: { schemaVersion: 2, runId: '__solo__:71', nodeId: '__solo__', executionLogId: journal.executionLogId, finishedAt: f.status.finishedAt, decision: { summary: '历史对话已正式结算' } }, idempotencyKey: 'historical-accepted-settlement' } });
  assert.equal(f.store.rows('SELECT state FROM run_consumer_sources WHERE run_id=?', [original.runId])[0].state, 'committed');
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
  assert.equal(f.store.listRunStates({ projectId: f.projectId, pendingConsumer: true }).items.length, 0);
  await f.ops({ operation: 'write', input: { kind: 'run', action: 'patch', scope: f.projectId, objectId: original.runId, expectedRevision: f.store.readRunState(f.projectId, 71).revision, data: { status: 'Stopped' }, idempotencyKey: 'newer-formal-status-than-history' } });
  const after = f.store.readRunState(f.projectId, 71), updatedWal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(f.store.readRunState(f.projectId, 71), after); assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), updatedWal);
  assert.equal(f.store.listRunStates({ projectId: f.projectId, pendingConsumer: true }).items.length, 0);
});

test('late discovery of a retained completion source attaches it without overwriting a newer formal run update', async t => {
  const f = await history(t);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const original = f.store.readRunState(f.projectId, 71);
  await f.ops({ operation: 'write', input: { kind: 'run', action: 'patch', scope: f.projectId, objectId: original.runId, expectedRevision: original.revision, data: { status: 'Stopped' }, idempotencyKey: 'newer-than-legacy-completion' } });
  const updated = f.store.readRunState(f.projectId, 71);
  const bytes = Buffer.from('{retained-broken-completion'); fs.writeFileSync(path.join(f.runDir, 'completion.json'), bytes);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const after = f.store.readRunState(f.projectId, 71);
  assert.equal(after.runId, original.runId); assert.equal(after.turnId, updated.turnId); assert.equal(f.store.read(after.runId).data.status, 'Stopped');
  assert.equal(after.status.checkpointSummary, updated.status.checkpointSummary); assert.equal(after.status.failureCode, undefined);
  assert.deepEqual(f.store.readMigrationSource(after.status.historicalCompletionSource.identity, after.status.historicalCompletionSource.key).bytes, bytes);
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
});

for (const body of ['{broken-json', 'null', '[]', '{"markCompleted":"true"}', '{"markCompleted":true,"reason":42}']) test(`invalid historical completion ${body} keeps full bytes and a stable failed state across replay and restart`, async t => {
  const f = await history(t), status = { ...f.status, status: 'In Progress', interactiveSession: false, completionDecisionFilePath: path.join(f.runDir, 'completion.json') };
  delete status.checkpointOutcome; fs.writeFileSync(f.statusFile, JSON.stringify(status));
  const bytes = Buffer.from(body); fs.writeFileSync(path.join(f.runDir, 'completion.json'), bytes);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const original = f.store.readRunState(f.projectId, 71);
  assert.equal(original.status.status, 'Failed'); assert.equal(original.status.failureCode, 'completion_state_invalid');
  const mapping = f.store.rows('SELECT object_id,stage FROM migration_items WHERE source_identity=? AND source_key=?', [original.status.historicalCompletionSource.identity, original.status.historicalCompletionSource.key])[0];
  assert.equal(mapping.object_id, original.runId); assert.equal(mapping.stage, 'imported');
  assert.deepEqual(f.store.readMigrationSource(original.status.historicalCompletionSource.identity, original.status.historicalCompletionSource.key).bytes, bytes);
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []); assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-source-isolation')); fs.renameSync(f.statuses, path.join(f.base, 'retained-status-isolation'));
  await f.restart(); assert.deepEqual(f.store.readRunState(f.projectId, 71), original);
});

for (const markCompleted of [false, true]) test(`valid historical completion ${markCompleted} keeps its intended result without an invalid-state failure`, async t => {
  const f = await history(t), status = { ...f.status, status: 'In Progress', interactiveSession: false };
  delete status.checkpointOutcome; fs.writeFileSync(f.statusFile, JSON.stringify(status));
  fs.writeFileSync(path.join(f.runDir, 'completion.json'), JSON.stringify({ markCompleted, reason: '保留完整合法结果🌿' }));
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const state = f.store.readRunState(f.projectId, 71); assert.equal(state.status.failureCode, undefined);
  const decision = JSON.parse((await f.client.readData(require('../out/runLifecycleClient.js').runDataReference(runStatusReference(f.project, 71), 'decision'))).toString('utf8'));
  assert.equal(decision.markCompleted, markCompleted);
  if (markCompleted) assert.equal(decision.reason, '保留完整合法结果🌿');
});

test('trusted historical task, turn, run and complete native binding survive source isolation and continue through the formal owner', async t => {
  const f = await history(t); const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(result.conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found, 'registered historical conversation must be adopted into formal lifecycle');
  const binding = await f.client.readBinding(found.reference, found.status); assert.deepEqual(binding, f.binding);
  assert.equal(found.status.learningTaskId, f.taskId); assert.equal(found.status.checkpointSequence, 1); assert.equal(found.status.checkpointOutcome, 'partial');
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
  assert.equal((await f.client.readLog(found.reference, 'output')).toString(), '完整历史原字节输出🌿'.repeat(1000));
  assert.equal(f.store.readRunTurnJournal(f.projectId, 71).entry.output, '原项目日志完整内容');
  const reports = f.store.readRegisteredReportSources(f.projectId, { taskId: f.taskId }); assert.equal(reports.reports.length, 1); assert.equal(found.turnId, reports.reports[0].turnId);
  const plan = f.store.readRunExecutionPlan(f.projectId, 71); assert.equal(plan.prompt, '完整历史提示词🌿'.repeat(1000)); assert.equal(plan.command, 'claude original arguments');
  const beforeReplay = f.store.readRunState(f.projectId, 71), revision = f.store.reportSourceRevision(f.projectId);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.deepEqual(f.store.readRunState(f.projectId, 71), beforeReplay); assert.equal(f.store.reportSourceRevision(f.projectId), revision);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-old-runs')); fs.renameSync(f.statuses, path.join(f.base, 'retained-old-statuses'));
  await f.restart();
  const reread = await f.client.findConversation(f.project, 71); assert.deepEqual(await f.client.readBinding(reread.reference, reread.status), f.binding);
  const continued = await prepareAgentRun({ agentCli: 'claude', selectedModel: 'original-model', prompt: '继续原历史任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 0,
    userMessage: '继续原任务', runKind: 'solo_continue', globalDataPath: f.root, taskPermissionMode: 'auto', nativeSessionId: f.binding.revisions[2].sessionId,
    continuation: true, parentExecutionLogId: 71, expectedParentTurnId: found.turnId, launchIntentId: 'historical-continuation' }, (operation, input) => f.ops({ operation, input }));
  assert.equal(continued.taskId, plan.taskId); assert.equal(continued.conversationId, plan.conversationId);
  assert.equal(continued.status.learningTaskId, f.taskId); assert.equal(continued.status.sourceParentTurnId, found.turnId);
  const executions = f.store.readRegisteredReportSources(f.projectId, { taskId: f.taskId }).tasks[0].executions;
  assert.deepEqual(executions.map(run => run.id).sort((a,b)=>a-b), [71, Number(continued.status.rootExecutionLogId)].sort((a,b)=>a-b));
  assert.equal(fs.existsSync(f.sourceRoot), false); assert.equal(fs.existsSync(f.statuses), false);
});

test('historical workspace evidence and roadmap backup remain readable through formal references after source isolation', async t => {
  const f = await history(t), snapshot = JSON.stringify({ 'original.txt': { size: 17, mtimeMs: 1790000000000 } });
  const changes = 'M original.txt\nA 新文件🌿.txt\n', roadmapBackup = 'id,title,status\n1,原路线图,Pending\n';
  fs.writeFileSync(path.join(f.runDir, 'workspace-before.json'), snapshot);
  fs.writeFileSync(path.join(f.runDir, 'changes.txt'), changes);
  fs.writeFileSync(path.join(f.runDir, 'roadmap-before.csv'), roadmapBackup);
  Object.assign(f.status, { workspaceSnapshotPath: path.join(f.runDir, 'workspace-before.json'), changesFilePath: path.join(f.runDir, 'changes.txt'), roadmapBackupFilePath: path.join(f.runDir, 'roadmap-before.csv') });
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-workspace-history')); fs.renameSync(f.statuses, path.join(f.base, 'retained-workspace-statuses'));
  assert.equal(await f.client.readField(found.reference, 'workspace', found.status), snapshot);
  assert.equal(await f.client.readField(found.reference, 'changes', found.status), changes);
  const document = f.store.readRunDocument(f.projectId, 71, 'roadmap_backup', Number(found.status.roadmapBackupRevision));
  assert.equal(document.objectId, found.status.roadmapBackupObjectId); assert.equal(Buffer.from(document.bytes, 'base64').toString(), roadmapBackup);
});

test('startup discovers a historical owner that has finished without replaying unchanged sources or creating another task', async t => {
  const f = await history(t), { enqueueStartupDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  f.status.agentPid = process.pid; writeLearningJson(f.statusFile, f.status);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.ok(f.store.migrationJobs().some(job => job.args.collection === 'agent-runs' && job.status === 'completed'));
  assert.throws(() => f.store.readMigrationSource(`agent-status:${f.project}`, '71.json'), /migration_source_missing/);
  f.status.agentPid = 0; writeLearningJson(f.statusFile, f.status);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.ok(await f.client.findConversation(f.project, 71), 'changed historical status must not remain hidden behind an already completed import job');
  const before = f.store.search({ scope: f.projectId }).sourceSequence, jobs = f.store.migrationJobCount();
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  assert.equal(f.store.migrationJobCount(), jobs);
  assert.equal(f.store.readRegisteredReportSources(f.projectId, { taskId: f.taskId }).tasks.length, 1);
  assert.equal(fs.readFileSync(f.statusFile, 'utf8'), JSON.stringify(f.status, null, 2) + '\n');
});

for (const invalid of ['task', 'workspace', 'nonce', 'session', 'revisions']) test(`historical lifecycle rejects ${invalid} without manufacturing an accepted conversation`, async t => {
  const f = await history(t);
  if (invalid === 'task') f.status.learningTaskId = 'task-' + crypto.randomUUID();
  if (['workspace', 'nonce', 'session', 'revisions'].includes(invalid)) {
    const binding = structuredClone(f.binding);
    if (invalid === 'workspace') binding.workspaceRoot = path.join(f.base, 'other-project');
    if (invalid === 'nonce') binding.bindingNonce = 'another-binding';
    if (invalid === 'session') binding.revisions.at(-1).sessionId = crypto.randomUUID();
    if (invalid === 'revisions') binding.revisions[1].revision = 7;
    fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify(binding));
  }
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => /historical_run_|identity_binding_invalid/.test(item.error)), 'invalid lifecycle must expose a precise migration conflict');
  assert.equal(await f.client.findConversation(f.project, 71), null);
  const captured = f.store.readMigrationSource(`agent-status:${f.project}`, '71.json');
  assert.ok(captured); assert.deepEqual(JSON.parse(captured.bytes.toString()), f.status);
  assert.equal(f.store.readRegisteredReportSources(f.projectId, { taskId: f.taskId }).reports.length, 1);
  assert.equal(fs.existsSync(f.runDir), true);
});

test('a live owner cannot defer a status whose declared run files escape its scoped directory', async t => {
  const f = await history(t);
  f.status.agentPid = process.pid;
  f.status.outputFilePath = path.join(f.base, 'outside', 'output.log');
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.error.includes('historical_run_source_conflict')));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
});

test('a registered historical run in the original node directory keeps its actual execution identity', async t => {
  const f = await history(t), original = path.join(f.base, 'isolated-original-run'), parent = path.dirname(f.runDir);
  fs.renameSync(f.runDir, original); fs.renameSync(parent, path.join(f.base, 'retained-empty-original-parent')); fs.renameSync(original, parent);
  for (const key of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) f.status[key] = path.join(parent, path.basename(f.status[key]));
  registerLearningTask(f.project, { executionLogId: 71, runDir: parent, userMessage: '不改原目标', startedAt: f.status.startedAt, taskId: f.taskId });
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project }); assert.deepEqual(result.conflicts, []);
  assert.ok(await f.client.findConversation(f.project, 71));
  assert.equal(f.store.readRunArtifact(f.projectId, 71, '__solo__/prompt.txt').bytes, Buffer.from('完整历史提示词🌿'.repeat(1000)).toString('base64'));
  assert.deepEqual(f.store.readProjectRunIndexes(f.projectId).map(row => row.executionLogId), [71]);
});

test('a node-directory output archived before adoption converges after status repair and append', async t => {
  const f = await history(t), original = path.join(f.base, 'isolated-original-run'), nodeDir = path.dirname(f.runDir);
  fs.renameSync(f.runDir, original); fs.renameSync(nodeDir, path.join(f.base, 'retained-empty-original-parent')); fs.renameSync(original, nodeDir);
  for (const key of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) f.status[key] = path.join(nodeDir, path.basename(f.status[key]));
  registerLearningTask(f.project, { executionLogId: 71, runDir: nodeDir, userMessage: '不改原目标', startedAt: f.status.startedAt, taskId: f.taskId });
  f.status.learningTaskId = `task-${crypto.randomUUID()}`; writeLearningJson(f.statusFile, f.status);
  assert.ok((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts.length);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  f.status.learningTaskId = f.taskId; writeLearningJson(f.statusFile, f.status);
  const outputFile = path.join(nodeDir, 'output.log'); fs.appendFileSync(outputFile, '节点根目录追加输出🌿');
  const current = fs.readFileSync(outputFile);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.ok(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/output.log').bytes.equals(current));
  assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(current));
});

test('a node-directory output with omitted artifact paths converges after status repair and append', async t => {
  const f = await history(t), original = path.join(f.base, 'isolated-original-run'), nodeDir = path.dirname(f.runDir);
  fs.renameSync(f.runDir, original); fs.renameSync(nodeDir, path.join(f.base, 'retained-empty-original-parent')); fs.renameSync(original, nodeDir);
  for (const key of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) delete f.status[key];
  registerLearningTask(f.project, { executionLogId: 71, runDir: nodeDir, userMessage: '不改原目标', startedAt: f.status.startedAt, taskId: f.taskId });
  f.status.learningTaskId = `task-${crypto.randomUUID()}`; writeLearningJson(f.statusFile, f.status);
  assert.ok((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts.length);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  f.status.learningTaskId = f.taskId; writeLearningJson(f.statusFile, f.status);
  const outputFile = path.join(nodeDir, 'output.log'); fs.appendFileSync(outputFile, '省略路径的节点根目录追加输出🌿');
  const current = fs.readFileSync(outputFile);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.ok(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/output.log').bytes.equals(current));
  assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(current));
});

test('replaying an unchanged historical run repairs damaged content without the base64 artifact reader', async t => {
  const f = await history(t);
  const outputFile = path.join(f.runDir, 'output.log');
  const output = Buffer.from('大体积历史输出🌿'.repeat(200000));
  fs.writeFileSync(outputFile, output);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const contentId = f.store.rows('SELECT content_id FROM project_run_artifacts WHERE project_id=? AND execution_log_id=? AND relative_path=?', [f.projectId, 71, '__solo__/71/output.log'])[0].content_id;
  f.store.db.run('DELETE FROM content_chunks WHERE content_id=? AND ordinal=1', [contentId]);
  const readRunArtifact = f.store.readRunArtifact;
  f.store.readRunArtifact = () => { throw new Error('base64_artifact_reader_used'); };
  try {
    assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  } finally { f.store.readRunArtifact = readRunArtifact; }
  assert.deepEqual(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/71/output.log').bytes, output);
});

test('late historical byte changes are retained as source versions without overwriting the formally adopted run', async t => {
  const f = await history(t); assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const before = f.store.readRunState(f.projectId, 71), oldOutput = await f.client.readLog(runStatusReference(f.project, 71), 'output');
  const changed = Buffer.from('随后出现的完整历史来源🌿'.repeat(1000)); fs.writeFileSync(path.join(f.runDir, 'output.log'), changed);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project }); assert.ok(result.conflicts.length);
  assert.deepEqual(f.store.readRunState(f.projectId, 71), before);
  assert.deepEqual(await f.client.readLog(runStatusReference(f.project, 71), 'output'), oldOutput);
  const captured = f.store.readMigrationSource(`agent-runs:${f.project}`, '__solo__/71/output.log');
  assert.equal(captured.sourceRevision, 2); assert.deepEqual(captured.bytes, changed);
});

test('an append-only historical output refreshes the formal archive and remains recyclable', async t => {
  const f = await history(t), outputFile = path.join(f.runDir, 'output.log');
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  for (const suffix of ['后续运行输出🌿'.repeat(1000), '再次追加的运行输出🌿'.repeat(1000)]) {
    fs.appendFileSync(outputFile, suffix);
    const current = fs.readFileSync(outputFile);
    const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
    assert.deepEqual(result.conflicts, []);
    assert.ok(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/71/output.log').bytes.equals(current));
    assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(current));
  }
  const beforeReplay = f.store.readRunState(f.projectId, 71);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.deepEqual(f.store.readRunState(f.projectId, 71), beforeReplay);
  assert.equal(f.store.migrationSourceState(`agent-runs:${f.project}`, '__solo__/71/output.log').stage, 'imported');
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  assert.ok((await new MigrationRecycling(f.store).prepare()).files.some(item => item.path === outputFile));
});

test('an empty adopted historical output accepts its first exact append', async t => {
  const f = await history(t), outputFile = path.join(f.runDir, 'output.log');
  fs.writeFileSync(outputFile, '');
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  fs.appendFileSync(outputFile, '空归档后的第一段输出🌿');
  const current = fs.readFileSync(outputFile);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.ok(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/71/output.log').bytes.equals(current));
  assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(current));
});

test('an output archived before lifecycle adoption converges after its status is repaired and bytes append', async t => {
  const f = await history(t), outputFile = path.join(f.runDir, 'output.log');
  f.status.learningTaskId = `task-${crypto.randomUUID()}`; writeLearningJson(f.statusFile, f.status);
  assert.ok((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts.length);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  f.status.learningTaskId = f.taskId; writeLearningJson(f.statusFile, f.status);
  fs.appendFileSync(outputFile, '状态修复前已经追加的完整输出🌿');
  const current = fs.readFileSync(outputFile);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.ok(f.store.readRunArtifactBytes(f.projectId, 71, '__solo__/71/output.log').bytes.equals(current));
  assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(current));
});

test('the original project-root status is adopted and survives source isolation with its complete provenance', async t => {
  const f = await history(t), rootStatus = path.join(f.project, '.agent_status.json');
  fs.renameSync(f.statusFile, rootStatus);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.ok(found, 'project-root historical status must enter the same formal lifecycle');
  assert.deepEqual(f.store.readMigrationSource(`project-agent-status:${f.project}`, '.agent_status.json').bytes, fs.readFileSync(rootStatus));
  fs.renameSync(rootStatus, path.join(f.base, 'retained-root-status.json'));
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-root-status-runs'));
  await f.restart();
  const resumed = await f.client.findConversation(f.project, 71);
  assert.equal(resumed.status.learningTaskId, f.taskId);
  assert.deepEqual(await f.client.readBinding(resumed.reference, resumed.status), f.binding);
  assert.equal((await f.client.readReport(resumed.reference, resumed.status)).report.summary, '历史首轮结果');
});

test('startup notices changes to the project-root historical status after a completed conflict job', async t => {
  const f = await history(t), rootStatus = path.join(f.project, '.agent_status.json');
  const { enqueueStartupDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  f.status.agentPid = process.pid; writeLearningJson(f.statusFile, f.status); fs.renameSync(f.statusFile, rootStatus);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(await f.client.findConversation(f.project, 71), null);
  f.status.agentPid = 0; writeLearningJson(rootStatus, f.status);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.ok(await f.client.findConversation(f.project, 71), 'project-root status changes must invalidate the prior discovery job');
  const before = f.store.search({ scope: f.projectId }).sourceSequence, jobs = f.store.migrationJobCount();
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before); assert.equal(f.store.migrationJobCount(), jobs);
});

test('a project-root status symlink is rejected without adopting its target as project-owned history', async t => {
  const f = await history(t), rootStatus = path.join(f.project, '.agent_status.json');
  const outsideStatus = path.join(f.base, 'other-owner-status.json'); fs.renameSync(f.statusFile, outsideStatus); fs.symlinkSync(outsideStatus, rootStatus);
  const original = fs.readFileSync(outsideStatus);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.source === rootStatus && /migration_source_invalid/.test(item.error)), 'root status symlinks must expose a precise source conflict');
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.deepEqual(fs.readFileSync(outsideStatus), original);
});

for (const placement of ['canonical', 'nested']) test(`startup adopts a finished historical owner with unchanged source bytes and timestamps (${placement})`, async t => {
  const f = await history(t), { spawn } = require('node:child_process');
  const { enqueueStartupDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  if (placement === 'nested') {
    const directory = path.join(f.statuses, 'retained'); fs.mkdirSync(directory);
    const nested = path.join(directory, '71.json'); fs.renameSync(f.statusFile, nested); f.statusFile = nested;
  }
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.once('data',()=>process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => { if (child.exitCode === null) child.stdin.end('exit'); await closed; });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  f.status.agentPid = child.pid; writeLearningJson(f.statusFile, f.status);
  const bytes = fs.readFileSync(f.statusFile), stat = fs.statSync(f.statusFile);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(await f.client.findConversation(f.project, 71), null, 'live historical owner must stay untouched');
  child.stdin.end('exit'); assert.equal(await closed, 0);
  assert.deepEqual(fs.readFileSync(f.statusFile), bytes); assert.equal(fs.statSync(f.statusFile).mtimeMs, stat.mtimeMs); assert.equal(fs.statSync(f.statusFile).ctimeMs, stat.ctimeMs);
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  const found = await f.client.findConversation(f.project, 71);
  assert.ok(found, 'owner exit must be discovered independently of source metadata changes');
  assert.equal(found.status.learningTaskId, f.taskId); assert.deepEqual(await f.client.readBinding(found.reference, found.status), f.binding);
  const before = f.store.search({ scope: f.projectId }).sourceSequence, jobs = f.store.migrationJobCount();
  await enqueueStartupDataMigrations(f.store, f.ops, () => true); await f.ops.waitForMigrations();
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before); assert.equal(f.store.migrationJobCount(), jobs);
});

test('project-root and nested status files retain distinct full provenance without growing versions on replay', async t => {
  const f = await history(t), rootStatus = path.join(f.project, '.agent_status.json');
  fs.renameSync(f.statusFile, rootStatus);
  const secondDir = path.join(f.sourceRoot, '__solo__', '72'); fs.cpSync(f.runDir, secondDir, { recursive: true });
  const secondBinding = { ...f.binding, runId: '72' }; fs.writeFileSync(path.join(secondDir, 'session.json'), JSON.stringify(secondBinding));
  registerLearningTask(f.project, { executionLogId: 72, runDir: secondDir, userMessage: '原任务继续', startedAt: f.status.startedAt, taskId: f.taskId });
  const secondStatus = { ...f.status, executionLogId: 72, rootExecutionLogId: 72, checkpointSummary: '另一旧会话原状态' };
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) secondStatus[field] = path.join(secondDir, path.basename(secondStatus[field]));
  writeLearningJson(path.join(secondDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: 72, turnId: '1:complete', createdAt: f.status.finishedAt, report: { summary: '另一旧会话原汇报' } });
  const nestedDir = path.join(f.statuses, 'project-root'); fs.mkdirSync(nestedDir);
  const nestedStatus = path.join(nestedDir, '.agent_status.json'); writeLearningJson(nestedStatus, secondStatus);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  let original;
  assert.doesNotThrow(() => { original = f.store.readMigrationSource(`project-agent-status:${f.project}`, '.agent_status.json'); }, 'project-root status must retain an independent physical-source receipt');
  const nested = f.store.readMigrationSource(`agent-status:${f.project}`, 'project-root/.agent_status.json');
  assert.ok(original, 'project-root status must have an independent physical-source identity'); assert.ok(nested); assert.deepEqual(original.bytes, fs.readFileSync(rootStatus)); assert.deepEqual(nested.bytes, fs.readFileSync(nestedStatus));
  assert.equal(original.sourceRevision, 1); assert.equal(nested.sourceRevision, 1);
  assert.ok(await f.client.findConversation(f.project, 71)); assert.ok(await f.client.findConversation(f.project, 72));
  assert.deepEqual(f.store.readRunState(f.projectId, 71).status.historicalStatusSource, { identity: `project-agent-status:${f.project}`, key: '.agent_status.json', hash: original.hash });
  assert.deepEqual(f.store.readRunState(f.projectId, 72).status.historicalStatusSource, { identity: `agent-status:${f.project}`, key: 'project-root/.agent_status.json', hash: nested.hash });
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  assert.equal(f.store.readMigrationSource(`project-agent-status:${f.project}`, '.agent_status.json').sourceRevision, 1);
  assert.equal(f.store.readMigrationSource(`agent-status:${f.project}`, 'project-root/.agent_status.json').sourceRevision, 1);
  fs.renameSync(rootStatus, path.join(f.base, 'retained-distinct-root-status.json'));
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-distinct-provenance-runs'));
  fs.renameSync(f.statuses, path.join(f.base, 'retained-distinct-nested-statuses'));
  await f.restart();
  assert.equal((await f.client.findConversation(f.project, 71)).status.checkpointSummary, '历史首轮结果');
  assert.equal((await f.client.findConversation(f.project, 72)).status.checkpointSummary, '另一旧会话原状态');
});

test('an already mixed legacy status receipt remains a conflict without guessing or overwriting either formal run', async t => {
  const f = await history(t), savedStatus = path.join(f.base, 'retained-before-legacy-capture.json');
  fs.renameSync(f.statusFile, savedStatus);
  const secondDir = path.join(f.sourceRoot, '__solo__', '72'); fs.cpSync(f.runDir, secondDir, { recursive: true });
  const secondBinding = { ...f.binding, runId: '72' }; fs.writeFileSync(path.join(secondDir, 'session.json'), JSON.stringify(secondBinding));
  registerLearningTask(f.project, { executionLogId: 72, runDir: secondDir, userMessage: '原任务继续', startedAt: f.status.startedAt, taskId: f.taskId });
  const secondStatus = { ...f.status, executionLogId: 72, rootExecutionLogId: 72, checkpointSummary: '另一旧会话原状态' };
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) secondStatus[field] = path.join(secondDir, path.basename(secondStatus[field]));
  writeLearningJson(path.join(secondDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: 72, turnId: '1:complete', createdAt: f.status.finishedAt, report: { summary: '另一旧会话原汇报' } });
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  const rootStatus = path.join(f.project, '.agent_status.json'); fs.renameSync(savedStatus, rootStatus);
  const nestedDir = path.join(f.statuses, 'project-root'); fs.mkdirSync(nestedDir);
  const nestedStatus = path.join(nestedDir, '.agent_status.json'); writeLearningJson(nestedStatus, secondStatus);
  const locationId = (await f.store.registerProject({ root: f.project })).locationId;
  const oldIdentity = `agent-status:${f.project}`, oldKey = 'project-root/.agent_status.json';
  for (const [file, directory, status, binding] of [[rootStatus, f.runDir, f.status, f.binding], [nestedStatus, secondDir, secondStatus, secondBinding]]) {
    const bytes = fs.readFileSync(file), source = { identity: oldIdentity, key: oldKey, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    f.store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8' });
    f.store.adoptHistoricalRun(f.projectId, locationId, source, { status, binding, prompt: fs.readFileSync(path.join(directory, 'prompt.txt'), 'utf8'), command: fs.readFileSync(path.join(directory, 'command.txt'), 'utf8'), output: fs.readFileSync(path.join(directory, 'output.log')) });
  }
  const before71 = f.store.readRunState(f.projectId, 71), before72 = f.store.readRunState(f.projectId, 72);
  assert.equal(f.store.readMigrationSource(oldIdentity, oldKey).sourceRevision, 2);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.source === rootStatus && /historical_run_target_conflict/.test(item.error)), 'mixed source provenance must remain explicit rather than being guessed from content');
  assert.deepEqual(f.store.readRunState(f.projectId, 71), before71); assert.deepEqual(f.store.readRunState(f.projectId, 72), before72);
  const rootCapture = f.store.readMigrationSource(`project-agent-status:${f.project}`, '.agent_status.json');
  assert.equal(rootCapture.stage, 'conflict'); assert.equal(rootCapture.sourceRevision, 1); assert.deepEqual(rootCapture.bytes, fs.readFileSync(rootStatus));
  assert.equal(f.store.readMigrationSource(oldIdentity, oldKey).sourceRevision, 2); assert.deepEqual(f.store.readMigrationSource(oldIdentity, oldKey).bytes, fs.readFileSync(nestedStatus));
});

async function unregisteredHistory(t, keepAlias = true) {
  const f = await history(t);
  const registrationFile = path.join(f.sourceRoot, 'learning-tasks', `${f.taskId}.json`);
  fs.renameSync(registrationFile, path.join(f.base, 'retained-preexisting-task-envelope.json'));
  f.status.userMessage = '原始未登记用户要求🌿'.repeat(1000);
  if (!keepAlias) {
    delete f.status.learningTaskId;
    fs.renameSync(path.join(f.runDir, 'task-report-1.json'), path.join(f.base, 'retained-pre-learning-report.json'));
  }
  writeLearningJson(f.statusFile, f.status);
  return Object.assign(f, { registrationFile });
}

test('an unregistered historical task retains its original alias, full request, report and native identity through restart and continuation', async t => {
  const f = await unregisteredHistory(t);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project }); assert.deepEqual(result.conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found, 'a genuine old status must not require a registration file that did not exist');
  const accepted = f.store.readRunState(f.projectId, 71);
  assert.equal(found.status.learningTaskId, f.taskId);
  assert.equal(f.store.read(accepted.taskId).data.original_request_content, f.status.userMessage);
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
  assert.deepEqual(await f.client.readBinding(found.reference, found.status), f.binding);
  const state = f.store.readRunState(f.projectId, 71), revision = f.store.reportSourceRevision(f.projectId);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.deepEqual(f.store.readRunState(f.projectId, 71), state); assert.equal(f.store.reportSourceRevision(f.projectId), revision);
  assert.equal(fs.existsSync(f.registrationFile), false, 'migration must not manufacture a physical task registration');
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-unregistered-runs')); fs.renameSync(f.statuses, path.join(f.base, 'retained-unregistered-statuses'));
  await f.restart();
  const resumed = await f.client.findConversation(f.project, 71);
  assert.equal((await f.client.readReport(resumed.reference, resumed.status)).report.summary, '历史首轮结果');
  const continued = await prepareAgentRun({ agentCli: 'claude', selectedModel: 'original-model', prompt: '继续原未登记任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 0,
    userMessage: '继续原未登记任务', runKind: 'solo_continue', globalDataPath: f.root, taskPermissionMode: 'auto', nativeSessionId: f.binding.revisions[2].sessionId,
    continuation: true, parentExecutionLogId: 71, expectedParentTurnId: resumed.turnId, launchIntentId: 'unregistered-continuation' }, (operation, input) => f.ops({ operation, input }));
  assert.equal(continued.taskId, accepted.taskId); assert.equal(continued.conversationId, accepted.conversationId); assert.equal(continued.status.learningTaskId, f.taskId);
  assert.equal(fs.existsSync(f.sourceRoot), false);
});

test('a historical run from before task registration gets one durable formal task without inventing a report or changing its old execution ID', async t => {
  const f = await unregisteredHistory(t, false);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found, 'pre-registration history must remain readable as a formal run');
  const accepted = f.store.readRunState(f.projectId, 71);
  assert.equal(found.status.executionLogId, 71); assert.equal(found.status.learningTaskId, `task-${accepted.taskId}`);
  assert.equal(f.store.read(accepted.taskId).data.original_request_content, f.status.userMessage);
  assert.equal(await f.client.readReport(found.reference, found.status), null);
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  assert.equal(f.store.readRegisteredReportSources(f.projectId).tasks.length, 1);
  assert.equal(fs.existsSync(f.registrationFile), false);
});

test('an unregistered historical continuation uses its captured prompt when the old status omitted userMessage', async t => {
  const f = await unregisteredHistory(t, false);
  delete f.status.userMessage;
  writeLearningJson(f.statusFile, f.status);
  const prompt = fs.readFileSync(path.join(f.runDir, 'prompt.txt'), 'utf8');
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const run = f.store.readRunState(f.projectId, 71);
  assert.equal(f.store.read(run.taskId).data.original_request_content, prompt);
  assert.equal(Object.hasOwn(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), 'userMessage'), false);
});

test('an unregistered multi-turn status retains both verified journals and their reports', async t => {
  const f = await unregisteredHistory(t);
  f.status.executionLogId = 72;
  f.status.runKind = 'solo_continue';
  f.status.checkpointSequence = 2;
  writeLearningJson(path.join(f.runDir, 'task-report-2.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: 72, turnId: '2:complete', createdAt: f.status.finishedAt, report: { summary: '未登记续轮真实报告' } });
  writeLearningJson(f.statusFile, f.status);
  f.store.importProjectJournal(f.projectId, { id: 72, nodeId: '__solo__', timestamp: f.status.finishedAt, agentCli: 'claude', command: 'claude original arguments', output: '继续轮次日志', status: 'Waiting' });
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const run = f.store.readRunState(f.projectId, 71);
  const task = f.store.readRegisteredReportSources(f.projectId, { taskId: run.status.learningTaskId }).tasks[0];
  assert.deepEqual(task.executions.map(execution => execution.id), [71, 72]);
  for (const [id, summary] of [[71, '历史首轮结果'], [72, '未登记续轮真实报告']]) {
    const turn = await f.client.findConversationTurn(f.project, id);
    assert.equal((await f.client.readReport(turn.reference, turn.status)).report.summary, summary);
    assert.equal((await f.client.readJournal(turn.reference, turn.status)).executionLogId, id);
  }
});

for (const invalid of ['undeclared report execution', 'foreign current journal node']) test(`an unregistered multi-turn status rejects ${invalid}`, async t => {
  const f = await unregisteredHistory(t);
  f.status.executionLogId = 72;
  f.status.runKind = 'solo_continue';
  f.status.checkpointSequence = 2;
  writeLearningJson(path.join(f.runDir, 'task-report-2.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: invalid === 'undeclared report execution' ? 73 : 72, turnId: '2:complete', createdAt: f.status.finishedAt, report: { summary: '不得错误归属的报告' } });
  writeLearningJson(f.statusFile, f.status);
  f.store.importProjectJournal(f.projectId, { id: 72, nodeId: invalid === 'foreign current journal node' ? 'another-node' : '__solo__', timestamp: f.status.finishedAt, agentCli: 'claude', command: 'claude original arguments', output: '继续轮次日志', status: 'Waiting' });
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => /historical_run_(?:report_mismatch|identity_invalid)/.test(item.error)));
  assert.equal(await f.client.findConversation(f.project, 71), null);
});

test('an unregistered numbered run remains discoverable when its old status omitted artifact paths', async t => {
  const f = await unregisteredHistory(t, false);
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) delete f.status[field];
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.ok(await f.client.findConversation(f.project, 71));
});

test('an unregistered numbered run remains discoverable through a verified project alias', async t => {
  const f = await unregisteredHistory(t);
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) delete f.status[field];
  writeLearningJson(f.statusFile, f.status);
  const alias = path.join(f.base, 'project-alias');
  fs.symlinkSync(f.project, alias, 'dir');
  assert.deepEqual((await importAgentRuns(f.store, path.join(alias, '.solopreneur', 'agent-runs'), { projectRoot: alias })).conflicts, []);
  fs.appendFileSync(path.join(f.runDir, 'output.log'), '通过项目别名追加的输出🌿');
  assert.deepEqual((await importAgentRuns(f.store, path.join(alias, '.solopreneur', 'agent-runs'), { projectRoot: alias })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
  assert.ok((await f.client.readLog(runStatusReference(f.project, 71), 'output')).equals(fs.readFileSync(path.join(f.runDir, 'output.log'))));
});

test('an unregistered status without a workspace field retains its project through the verified native binding', async t => {
  const f = await unregisteredHistory(t); delete f.status.workspaceRoot; writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found);
  assert.equal(found.status.workspaceRoot, f.project); assert.equal(found.status.learningTaskId, f.taskId);
  assert.deepEqual(await f.client.readBinding(found.reference, found.status), f.binding);
  assert.equal(Object.hasOwn(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), 'workspaceRoot'), false, 'original source must retain its genuinely absent field');
});

test('an unregistered status without workspace or native binding retains the physically verified migration project', async t => {
  const f = await unregisteredHistory(t, false);
  delete f.status.workspaceRoot;
  f.status.nativeSessionIdIsCurrent = false;
  f.status.nativeSessionId = '';
  fs.renameSync(path.join(f.runDir, 'session.json'), path.join(f.base, 'retained-unbound-session.json'));
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.equal(found.status.workspaceRoot, f.project);
  assert.equal(await f.client.readBinding(found.reference, found.status), null);
  assert.equal(Object.hasOwn(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), 'workspaceRoot'), false);
});

test('an unregistered status from a retired project path rebases its declared artifacts to the verified current project', async t => {
  const f = await unregisteredHistory(t, false);
  const retiredRoot = path.join(f.base, 'retired-project-location');
  f.status.workspaceRoot = retiredRoot;
  for (const field of ['promptFilePath', 'commandFilePath', 'outputFilePath', 'sessionFilePath']) {
    f.status[field] = path.join(retiredRoot, path.relative(f.project, f.status[field]));
  }
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.equal(found.status.workspaceRoot, f.project);
  assert.equal(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes).workspaceRoot, retiredRoot);
});

test('a retired project path rebases through a verified current alias with its original report', async t => {
  const f = await unregisteredHistory(t);
  const retiredRoot = path.join(f.base, 'retired-project-location');
  f.status.workspaceRoot = retiredRoot;
  for (const field of ['promptFilePath', 'commandFilePath', 'outputFilePath', 'sessionFilePath']) {
    f.status[field] = path.join(retiredRoot, path.relative(f.project, f.status[field]));
  }
  const reportFile = path.join(f.runDir, 'task-report-1.json');
  const report = JSON.parse(fs.readFileSync(reportFile)); report.projectPath = retiredRoot; writeLearningJson(reportFile, report);
  writeLearningJson(f.statusFile, f.status);
  const alias = path.join(f.base, 'project-alias'); fs.symlinkSync(f.project, alias, 'dir');
  assert.deepEqual((await importAgentRuns(f.store, path.join(alias, '.solopreneur', 'agent-runs'), { projectRoot: alias })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);
  assert.equal(found.status.workspaceRoot, f.project);
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
});

test('a registered historical status without the optional task alias retains the uniquely registered task', async t => {
  const f = await history(t); delete f.status.learningTaskId; writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found);
  assert.equal(found.status.learningTaskId, f.taskId);
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
  assert.equal(Object.hasOwn(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), 'learningTaskId'), false);
});

test('two unregistered historical runs with the same recorded task alias retain one original request and both report relationships', async t => {
  const f = await unregisteredHistory(t), secondDir = path.join(f.sourceRoot, '__solo__', '72');
  fs.cpSync(f.runDir, secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, 'session.json'), JSON.stringify({ ...f.binding, runId: '72' }));
  const secondStatus = { ...f.status, executionLogId: 72, rootExecutionLogId: 72, userMessage: '后续补充要求', checkpointSummary: '第二条旧会话结果' };
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) secondStatus[field] = path.join(secondDir, path.basename(secondStatus[field]));
  writeLearningJson(path.join(f.statuses, '72.json'), secondStatus);
  writeLearningJson(path.join(secondDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: f.project, taskId: f.taskId, executionLogId: 72, turnId: '1:complete', createdAt: f.status.finishedAt, report: { summary: '第二条旧会话结果' } });
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const first = f.store.readRunState(f.projectId, 71), second = f.store.readRunState(f.projectId, 72);
  assert.equal(first.taskId, second.taskId); assert.equal(first.conversationId, second.conversationId);
  assert.equal(f.store.read(first.taskId).data.original_request_content, f.status.userMessage);
  assert.equal(second.status.userMessage, '后续补充要求');
  const reports = f.store.readRegisteredReportSources(f.projectId, { taskId: f.taskId });
  assert.equal(reports.tasks.length, 1); assert.deepEqual(reports.tasks[0].executions.map(run => run.id), [71, 72]);
  assert.deepEqual(reports.reports.map(report => report.report.summary).sort(), ['历史首轮结果', '第二条旧会话结果'].sort());
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
});

test('an active legacy run is deferred until its writer exits and then adopts only the final exact bytes', async t => {
  const f = await unregisteredHistory(t), outputFile = path.join(f.runDir, 'output.log');
  f.status.agentPid = process.pid;
  writeLearningJson(f.statusFile, f.status);
  const first = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(first.conflicts, []);
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.throws(() => f.store.readMigrationSource(`agent-status:${f.project}`, '71.json'), /migration_source_missing/);
  const finalOutput = '活跃旧会话最终完整输出🌿'.repeat(6000);
  fs.writeFileSync(outputFile, finalOutput);
  Object.assign(f.status, { agentPid: 0, processBirth: '', status: 'In Progress', checkpointOutcome: 'partial', checkpointSummary: '旧会话已安全交接', finishedAt: '2026-09-16T01:20:00.000Z' });
  writeLearningJson(f.statusFile, f.status);
  const adopted = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.deepEqual(adopted.conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found);
  assert.equal((await f.client.readLog(found.reference, 'output', found.status)).toString(), finalOutput);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
  assert.equal(f.store.readMigrationSource(`agent-runs:${f.project}`, '__solo__/71/output.log').bytes.toString(), finalOutput);
});

test('runtime migration probe automatically adopts a deferred legacy run after its owner exits', async t => {
  const f = await unregisteredHistory(t), outputFile = path.join(f.runDir, 'output.log');
  const bootstrap = require('../out/runtimeDatabaseBootstrap.js');
  f.status.agentPid = process.pid;
  writeLearningJson(f.statusFile, f.status);
  await bootstrap.enqueueStartupDataMigrations(f.store, f.ops, () => true);
  await f.ops.waitForMigrations();
  assert.equal(await f.client.findConversation(f.project, 71), null);
  const baseline = await bootstrap.historicalRunOwnerStateStamp(f.store, () => true);

  const finalOutput = 'owner 退出后的最终正文🌿'.repeat(4000);
  fs.writeFileSync(outputFile, finalOutput);
  Object.assign(f.status, { agentPid: 0, processBirth: '', status: 'Processed', finishedAt: '2026-09-16T01:20:00.000Z' });
  writeLearningJson(f.statusFile, f.status);
  const next = await bootstrap.refreshHistoricalRunMigrations(f.store, f.ops, () => true, baseline);
  await f.ops.waitForMigrations();

  assert.notEqual(next, baseline);
  const found = await f.client.findConversation(f.project, 71);
  assert.ok(found);
  assert.equal((await f.client.readLog(found.reference, 'output', found.status)).toString(), finalOutput);
});

for (const invalid of ['report', 'request', 'source-path', 'workspace', 'nonce', 'session', 'revisions']) test(`unregistered historical adoption rejects ${invalid} without leaving an invented task or conversation`, async t => {
  const f = await unregisteredHistory(t);
  if (invalid === 'request') { delete f.status.userMessage; fs.writeFileSync(path.join(f.runDir, 'prompt.txt'), ''); }
  if (invalid === 'source-path') f.status.outputFilePath = path.join(f.base, 'another-project', 'output.log');
  if (invalid === 'report') {
    const file = path.join(f.runDir, 'task-report-1.json'), value = JSON.parse(fs.readFileSync(file)); value.taskId = 'task-' + crypto.randomUUID(); writeLearningJson(file, value);
  }
  if (['workspace', 'nonce', 'session', 'revisions'].includes(invalid)) {
    const binding = structuredClone(f.binding);
    if (invalid === 'workspace') binding.workspaceRoot = path.join(f.base, 'another-project');
    if (invalid === 'nonce') binding.bindingNonce = 'another-binding';
    if (invalid === 'session') binding.revisions.at(-1).sessionId = crypto.randomUUID();
    if (invalid === 'revisions') binding.revisions[1].revision = 7;
    fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify(binding));
  }
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  const expected = { report: 'historical_run_report_mismatch', request: 'historical_run_task_source_missing', 'source-path': 'historical_run_source_conflict', workspace: 'historical_run_binding_mismatch', nonce: 'historical_run_binding_mismatch', session: 'historical_run_session_mismatch', revisions: 'identity_binding_invalid' }[invalid];
  assert.ok(result.conflicts.some(item => item.error.includes(expected)), 'the actual missing or conflicting provenance must remain explicit');
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['task', 'conversation'] }).items.length, 0, 'failed adoption must roll back its task and conversation');
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
  assert.equal(fs.existsSync(f.registrationFile), false);
});

for (const registered of [false, true]) for (const [field, name] of [['sessionFilePath', 'session.json'], ['promptFilePath', 'prompt.txt'], ['commandFilePath', 'command.txt'], ['outputFilePath', 'output.log']]) test(`historical adoption reads the exact declared ${field} for ${registered ? 'registered' : 'unregistered'} sources`, async t => {
  const f = registered ? await history(t) : await unregisteredHistory(t), alternate = path.join(f.runDir, `original-${name}`);
  let expected;
  if (field === 'sessionFilePath') {
    expected = structuredClone(f.binding); const sessionId = crypto.randomUUID();
    for (const revision of expected.revisions) if (revision.sessionId) revision.sessionId = sessionId;
    f.status.nativeSessionId = sessionId; fs.writeFileSync(alternate, JSON.stringify(expected));
  } else {
    expected = `原状态声明的独立${name}完整正文🌿`.repeat(1000); fs.writeFileSync(alternate, expected);
  }
  f.status[field] = alternate; writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71); assert.ok(found);
  if (field === 'sessionFilePath') assert.deepEqual(await f.client.readBinding(found.reference, found.status), expected);
  else if (field === 'outputFilePath') assert.equal((await f.client.readLog(found.reference, 'output', found.status)).toString(), expected);
  else assert.equal(await f.client.readField(found.reference, field === 'promptFilePath' ? 'prompt' : 'command', found.status), expected);
  const captured = f.store.readMigrationSource(`agent-runs:${f.project}`, `__solo__/71/original-${name}`);
  assert.equal(captured.bytes.toString(), field === 'sessionFilePath' ? JSON.stringify(expected) : expected);
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-declared-runs')); fs.renameSync(f.statuses, path.join(f.base, 'retained-declared-statuses')); await f.restart();
  const reread = await f.client.findConversation(f.project, 71);
  if (field === 'sessionFilePath') assert.deepEqual(await f.client.readBinding(reread.reference, reread.status), expected);
  else if (field === 'outputFilePath') assert.equal((await f.client.readLog(reread.reference, 'output', reread.status)).toString(), expected);
  else assert.equal(await f.client.readField(reread.reference, field === 'promptFilePath' ? 'prompt' : 'command', reread.status), expected);
});

test('storage cleanup preserves an old unclassified artifact when historical status declares its exact role', async t => {
  const f = await history(t), relative = '__solo__/71/original-prompt.data', file = path.join(f.sourceRoot, relative);
  const bytes = Buffer.from('旧版本已经同步的完整提示词🌿'.repeat(1000)), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(file, bytes); f.status.promptFilePath = file; writeLearningJson(f.statusFile, f.status);
  const contentId = f.store.putContent(bytes, 'application/octet-stream', 'binary');
  f.store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [f.projectId, 71, relative, contentId, hash, 'application/octet-stream', Date.now()]);
  f.store.captureMigrationSource({ identity: `agent-runs:${f.project}`, key: relative, hash }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  assert.equal(f.store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE relative_path=?', [relative])[0].artifact_kind, 'unclassified');
  assert.equal(f.store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${f.project}`, relative])[0].source_kind, 'retained');
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE relative_path=? AND execution_log_id=71', [relative])[0].artifact_kind, 'prompt');
  assert.equal(f.store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${f.project}`, relative])[0].source_kind, 'prompt');
  await f.ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(Buffer.from(f.store.readRunArtifact(f.projectId, 71, relative).bytes, 'base64').toString(), bytes.toString());
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('historical status reclassifies an archived custom prompt after its physical source is gone', async t => {
  const f = await history(t), relative = '__solo__/71/archived-prompt.data', file = path.join(f.sourceRoot, relative);
  const bytes = Buffer.from('只保存在统一数据库里的完整旧提示词🌿'.repeat(1000)), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(file, bytes); f.status.promptFilePath = file; writeLearningJson(f.statusFile, f.status);
  const contentId = f.store.putContent(bytes, 'application/octet-stream', 'binary');
  f.store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [f.projectId, 71, relative, contentId, hash, 'application/octet-stream', Date.now()]);
  f.store.captureMigrationSource({ identity: `agent-runs:${f.project}`, key: relative, hash }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  fs.unlinkSync(file);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE relative_path=?', [relative])[0].artifact_kind, 'prompt');
  assert.equal(f.store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${f.project}`, relative])[0].source_kind, 'prompt');
  await f.ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(Buffer.from(f.store.readRunArtifact(f.projectId, 71, relative).bytes, 'base64').toString(), bytes.toString());
});

test('cleanup retains a custom status input when its live source conflicts with the archived database copy', async t => {
  const f = await history(t), relative = '__solo__/71/conflicting-prompt.data', file = path.join(f.sourceRoot, relative);
  const archived = Buffer.from('数据库中的旧提示词🌿'), current = Buffer.from('运行目录中发生变化的新提示词');
  const hash = crypto.createHash('sha256').update(archived).digest('hex');
  fs.writeFileSync(file, current); f.status.promptFilePath = file; writeLearningJson(f.statusFile, f.status);
  const contentId = f.store.putContent(archived, 'application/octet-stream', 'binary');
  f.store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [f.projectId, 71, relative, contentId, hash, 'application/octet-stream', Date.now()]);
  f.store.captureMigrationSource({ identity: `agent-runs:${f.project}`, key: relative, hash }, archived, { mimeType: 'application/octet-stream', encoding: 'binary' });
  const imported = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(imported.conflicts.some(item => item.error.includes('historical_run_source_changed')));
  await f.ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(f.store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE relative_path=?', [relative])[0].artifact_kind, 'retained');
  assert.equal(f.store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${f.project}`, relative])[0].source_kind, 'retained');
  assert.equal(Buffer.from(f.store.readRunArtifact(f.projectId, 71, relative).bytes, 'base64').toString(), archived.toString());
  assert.deepEqual(fs.readFileSync(file), current);
});

for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) for (const outside of [false, true]) test(`historical adoption rejects ${outside ? 'outside' : 'missing'} declared ${field} despite a valid same-named decoy`, async t => {
  const f = await unregisteredHistory(t), declaration = outside ? path.join(f.base, 'another-project', path.basename(f.status[field])) : path.join(f.runDir, `missing-${path.basename(f.status[field])}`);
  if (outside) { fs.mkdirSync(path.dirname(declaration)); fs.writeFileSync(declaration, fs.readFileSync(f.status[field])); }
  f.status[field] = declaration; writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.error.includes(outside ? 'historical_run_source_conflict' : 'historical_run_input_missing')));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['task', 'conversation'] }).items.length, 0);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
});

for (const provider of ['codex', 'antigravity']) test(`unregistered flat ${provider} identity retains original bytes and native continuation after historical source isolation`, async t => {
  const f = await unregisteredHistory(t, false), sessionId = crypto.randomUUID();
  const flat = { sessionId, source: provider === 'codex' ? 'codex-output' : 'antigravity-log' };
  fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify(flat));
  const agentCli = provider === 'codex' ? 'codex' : 'agy';
  Object.assign(f.status, { agentCli, sessionProvider: provider });
  for (const key of ['bindingNonce', 'sessionBindingHeadRevision', 'nativeSessionIdIsCurrent', 'nativeSessionId', 'workspaceRoot']) delete f.status[key];
  let transcript, transcriptBody, home;
  if (provider === 'codex') {
    home = path.join(f.base, 'recorded-native-home');fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    transcript = path.join(home, 'sessions', `rollout-original-${sessionId}.jsonl`);
    transcriptBody = JSON.stringify({ type: 'session_meta', timestamp: f.status.startedAt, payload: { id: sessionId, cwd: f.project, timestamp: f.status.startedAt } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '官方旧来源完整正文🌿'.repeat(3000) }] } }) + '\n';
    fs.writeFileSync(transcript, transcriptBody);fs.writeFileSync(path.join(f.runDir, 'codex-home.txt'), home);
    f.status.codexHomeFilePath = path.join(f.runDir, 'codex-home.txt');
  }
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);assert.ok(found);
  const binding = await f.client.readBinding(found.reference, found.status), head = binding.revisions[binding.headRevision - 1];
  assert.equal(head.sessionId, sessionId);assert.equal(head.contract, 'compatibility');
  assert.equal(binding.provider, provider);assert.equal(binding.workspaceRoot, f.project);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-runs:${f.project}`, '__solo__/71/session.json').bytes), flat);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
  if (provider === 'codex') {
    assert.equal(head.providerContext.codex.codexHome, home);
    assert.equal((await f.client.readLog(found.reference, 'native:codex', found.status)).toString(), transcriptBody);
  }
  const sequence = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, sequence);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-flat-history'));fs.renameSync(f.statuses, path.join(f.base, 'retained-flat-statuses'));await f.restart();
  const reread = await f.client.findConversation(f.project, 71);
  assert.equal((await f.client.getResumableSession(reread.reference)).sessionId, sessionId);
  if (provider === 'codex') assert.equal((await f.client.readLog(reread.reference, 'native:codex', reread.status)).toString(), transcriptBody);
  const plan = f.store.readRunExecutionPlan(f.projectId, 71);
  const continued = await prepareAgentRun({ agentCli, selectedModel: 'original-model', prompt: '继续真实旧任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 0,
    userMessage: '继续旧任务', runKind: 'solo_continue', globalDataPath: f.root, taskPermissionMode: 'auto', nativeSessionId: sessionId,
    continuation: true, parentExecutionLogId: 71, expectedParentTurnId: reread.turnId, launchIntentId: `flat-${provider}-continue`,
    ...(provider === 'codex' ? { metadata: { nativeResumeProviderContext: head.providerContext, codexResumeTranscriptPath: transcript } } : {}) }, (operation, input) => f.ops({ operation, input }));
  assert.equal(continued.taskId, plan.taskId);assert.equal(continued.conversationId, plan.conversationId);
  assert.equal(fs.existsSync(f.sourceRoot), false);assert.equal(fs.existsSync(f.statuses), false);
});

test('historical missing physical output retains the full exact project journal instead of creating an empty log', async t => {
  const f = await unregisteredHistory(t), full = '原始日志库保留的完整输出🌿'.repeat(4000);
  f.store.updateProjectJournal(f.projectId, 71, { agentCli: 'claude', command: 'claude original arguments', output: full, status: 'Waiting' });
  fs.renameSync(path.join(f.runDir, 'output.log'), path.join(f.base, 'retained-physical-output'));
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);assert.ok(found);
  assert.equal((await f.client.readLog(found.reference, 'output', found.status)).toString(), full);
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-missing-output-sources'));fs.renameSync(f.statuses, path.join(f.base, 'retained-missing-output-statuses'));await f.restart();
  const reread = await f.client.findConversation(f.project, 71);
  assert.equal((await f.client.readLog(reread.reference, 'output', reread.status)).toString(), full);
});

for (const availability of ['missing', 'invalid', 'save_failed']) test(`unregistered historical ${availability} report receipt retains its real availability after restart`, async t => {
  const f = await unregisteredHistory(t);fs.renameSync(path.join(f.runDir, 'task-report-1.json'), path.join(f.base, 'retained-reported-body'));
  const receipt = { schemaVersion: 1, taskId: f.taskId, projectPath: f.project, executionLogId: 71, turnId: '1:complete', createdAt: f.status.finishedAt, availability };
  writeLearningJson(path.join(f.runDir, 'task-report-status-1.json'), receipt);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71), report = await f.client.readReport(found.reference, found.status);
  assert.ok(report, 'a receipt must remain a formal report observation');assert.equal(report.availability, availability);assert.equal(report.report, null);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-runs:${f.project}`, '__solo__/71/task-report-status-1.json').bytes), receipt);
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  fs.renameSync(f.sourceRoot, path.join(f.base, 'retained-receipt-history'));fs.renameSync(f.statuses, path.join(f.base, 'retained-receipt-statuses'));await f.restart();
  const reread = await f.client.findConversation(f.project, 71);assert.equal((await f.client.readReport(reread.reference, reread.status)).availability, availability);
});

test('an unregistered status with no task alias retains the exact alias recorded by its scoped report', async t => {
  const f = await unregisteredHistory(t);delete f.status.learningTaskId;writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const found = await f.client.findConversation(f.project, 71);assert.ok(found);assert.equal(found.status.learningTaskId, f.taskId);
  assert.equal((await f.client.readReport(found.reference, found.status)).report.summary, '历史首轮结果');
  const before = f.store.search({ scope: f.projectId }).sourceSequence;
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, before);
  assert.equal(f.store.readRegisteredReportSources(f.projectId).tasks.length, 1);
  assert.equal(Object.hasOwn(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), 'learningTaskId'), false);
});

for (const invalid of ['native-project', 'native-missing', 'bad-flat-id', 'provider']) test(`flat historical identity rejects ${invalid} without leaving a formal task`, async t => {
  const f = await unregisteredHistory(t, false), sessionId = crypto.randomUUID(), home = path.join(f.base, 'recorded-native-home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const transcript = path.join(home, 'sessions', `rollout-${sessionId}.jsonl`);
  if (invalid !== 'native-missing') fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: invalid === 'native-project' ? path.join(f.base, 'another-project') : f.project } }) + '\n');
  fs.writeFileSync(path.join(f.runDir, 'codex-home.txt'), home);
  fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify({ sessionId: invalid === 'bad-flat-id' ? '' : sessionId, source: 'codex-output' }));
  Object.assign(f.status, { agentCli: 'codex', sessionProvider: invalid === 'provider' ? 'antigravity' : 'codex', codexHomeFilePath: path.join(f.runDir, 'codex-home.txt') });
  for (const key of ['bindingNonce', 'sessionBindingHeadRevision', 'nativeSessionIdIsCurrent', 'nativeSessionId']) delete f.status[key];
  if (invalid === 'native-missing') Object.assign(f.status, { nativeSessionIdIsCurrent: true, nativeSessionId: sessionId });
  writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  const code = { 'native-project': 'historical_run_native_source_mismatch', 'native-missing': 'historical_run_native_source_missing', 'bad-flat-id': 'historical_run_legacy_identity_invalid', provider: 'historical_run_binding_mismatch' }[invalid];
  assert.ok(result.conflicts.some(item => item.error.includes(code)));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['task', 'conversation'] }).items.length, 0);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`agent-status:${f.project}`, '71.json').bytes), f.status);
});

test('missing physical output cannot borrow another node journal with the same numeric execution', async t => {
  const f = await unregisteredHistory(t, false), newDir = path.join(f.sourceRoot, 'another-node', '71');
  fs.mkdirSync(path.dirname(newDir));fs.renameSync(f.runDir, newDir);fs.renameSync(path.join(newDir, 'output.log'), path.join(f.base, 'retained-physical-output'));
  for (const field of ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']) f.status[field] = path.join(newDir, path.basename(f.status[field]));
  f.status.nodeId = 'another-node';writeLearningJson(f.statusFile, f.status);
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.error.includes('historical_run_input_missing')));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['task', 'conversation'] }).items.length, 0);
});

for (const invalid of ['receipt-alias', 'receipt-project', 'two-report-aliases']) test(`unregistered report observations reject ${invalid} without assigning another task`, async t => {
  const f = await unregisteredHistory(t);fs.renameSync(path.join(f.runDir, 'task-report-1.json'), path.join(f.base, 'retained-original-report'));
  const receipt = { schemaVersion: 1, taskId: invalid === 'receipt-alias' ? 'task-another-task' : f.taskId, projectPath: invalid === 'receipt-project' ? path.join(f.base, 'another-project') : f.project, executionLogId: 71, turnId: '1:complete', createdAt: f.status.finishedAt, availability: 'missing' };
  writeLearningJson(path.join(f.runDir, 'task-report-status-1.json'), receipt);
  if (invalid === 'two-report-aliases') {
    delete f.status.learningTaskId;writeLearningJson(f.statusFile, f.status);
    writeLearningJson(path.join(f.runDir, 'task-report-2.json'), { schemaVersion: 1, taskId: 'task-another-task', projectPath: f.project, executionLogId: 71, turnId: '2:complete', createdAt: f.status.finishedAt, report: { summary: 'another task' } });
  }
  const result = await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project });
  assert.ok(result.conflicts.some(item => item.error.includes('historical_run_report_mismatch')));
  assert.equal(await f.client.findConversation(f.project, 71), null);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['task', 'conversation'] }).items.length, 0);
});

test('adopted settled historical report retains its actual current turn start and completion time', async t => {
  const f = await unregisteredHistory(t);assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  const state = f.store.readRunState(f.projectId, 71), turn = f.store.readMetadata(state.turnId);
  assert.equal(turn.data.started_at, Date.parse(f.status.turnStartedAt));
  assert.equal(turn.data.finished_at, Date.parse(f.status.finishedAt));
});

test('adopted flat native history keeps an unfinished JSON line available for its later official append', async t => {
  const f = await unregisteredHistory(t, false), sessionId = crypto.randomUUID(), home = path.join(f.base, 'recorded-native-home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const transcript = path.join(home, 'sessions', `rollout-${sessionId}.jsonl`), nativeTurnId = 'later-official-native-turn';
  const head = JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: f.project } }) + '\n';
  const event = JSON.stringify({ type: 'event_msg', timestamp: '2026-09-01T10:05:00.000Z', payload: { type: 'task_started', turn_id: nativeTurnId } }) + '\n', cut = Math.floor(event.length / 2);
  fs.writeFileSync(transcript, head + event.slice(0, cut));fs.writeFileSync(path.join(f.runDir, 'codex-home.txt'), home);
  fs.writeFileSync(path.join(f.runDir, 'session.json'), JSON.stringify({ sessionId, source: 'codex-session-file' }));
  Object.assign(f.status, { agentCli: 'codex', sessionProvider: 'codex', codexHomeFilePath: path.join(f.runDir, 'codex-home.txt') });
  for (const key of ['bindingNonce', 'sessionBindingHeadRevision', 'nativeSessionIdIsCurrent', 'nativeSessionId']) delete f.status[key];
  writeLearningJson(f.statusFile, f.status);
  assert.deepEqual((await importAgentRuns(f.store, f.sourceRoot, { projectRoot: f.project })).conflicts, []);
  fs.appendFileSync(transcript, event.slice(cut));
  const { RunNativeObserver } = require('../out/runNativeObserver.js');await new RunNativeObserver(f.store).observe(f.store.readRunState(f.projectId, 71));
  const state = f.store.readRunState(f.projectId, 71);assert.equal(state.status.codexNativeTurnId, nativeTurnId);
  assert.equal((await f.client.readLog(runStatusReference(f.project, 71), 'native:codex')).toString(), head + event);
});

test('startup retries an unchanged historical source whose previous importer job completed with a provenance conflict', async t => {
  const f = await unregisteredHistory(t), { enqueueStartupDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  let oldJob;
  await enqueueStartupDataMigrations(f.store, async request => {
    if (request.input.collection !== 'agent-runs') return { scheduled: false };
    const { idempotencyKey, refreshCompleted, ...args } = request.input;
    oldJob = f.store.enqueueMemoryMigration(args, idempotencyKey.replace(/^startup-agent-runs-v\d+:/, 'startup-agent-runs-v5:'));
    f.store.updateMigrationJob(oldJob.jobId, 'completed_with_conflicts', { conflicts: [{ source: f.statusFile, error: 'historical_run_task_mismatch' }] });
    return { scheduled: false };
  }, () => true);
  assert.ok(oldJob);assert.equal(await f.client.findConversation(f.project, 71), null);
  const sourceBytes = fs.readFileSync(f.statusFile), info = fs.statSync(f.statusFile);
  await f.restart();await enqueueStartupDataMigrations(f.store, f.ops, () => true);await f.ops.waitForMigrations();
  assert.ok(await f.client.findConversation(f.project, 71), 'updated importer must reconsider unchanged legacy sources rather than reuse an obsolete completed job');
  assert.deepEqual(fs.readFileSync(f.statusFile), sourceBytes);assert.equal(fs.statSync(f.statusFile).mtimeMs, info.mtimeMs);
  assert.equal(f.store.readMigrationJob(oldJob.jobId).status, 'completed_with_conflicts', 'the earlier failure receipt stays historical');
  const sequence = f.store.search({ scope: f.projectId }).sourceSequence, jobs = f.store.migrationJobCount();
  await enqueueStartupDataMigrations(f.store, f.ops, () => true);await f.ops.waitForMigrations();
  assert.equal(f.store.search({ scope: f.projectId }).sourceSequence, sequence);assert.equal(f.store.migrationJobCount(), jobs);
});
