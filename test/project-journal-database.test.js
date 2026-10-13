const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { SyncEngine } = require('../out/db/syncEngine.js');
const { importAgentRuns, importProjectGrowth } = require('../out/projectDataMigration.js');

test('formal conversation pages remain usable with an unreadable retired journal', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-formal-journal-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  const projectId = owner.projectIds.get(project);
  owner.store.appendProjectJournal(projectId, 'formal-journal', { nodeId: '__solo__', timestamp: new Date().toISOString(), agentCli: 'claude', command: 'formal', output: '完整正文🌿'.repeat(10000), status: 'Completed' }, 1);
  const oldPath = path.join(project, '.solopreneur', 'project_journal.db'); fs.writeFileSync(oldPath, 'retained unreadable historical source');
  const retained = fs.readFileSync(oldPath);
  const engine = new SyncEngine(path.join(project, '.solopreneur', 'roadmap.csv'), oldPath, path.resolve(__dirname, '..'), root);
  t.after(() => engine.close());
  for (const read of [() => engine.readAgentExecutions('__solo__'), async () => (await engine.readAgentExecutionPage('__solo__')).logs, () => engine.readRecentProjectAgentExecutions(), async () => [await engine.readAgentExecutionById(1)]]) {
    const logs = await read(); assert.equal(logs.length, 1); assert.equal(logs[0].output, '完整正文🌿'.repeat(10000));
  }
  await engine.loadHistory(); assert.equal(engine.getProjectAgentExecutions().length, 1);
  assert.deepEqual(fs.readFileSync(oldPath), retained);
});

test('damaged native identity does not hide the complete formal conversation or expose a stale resume target', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-damaged-history-view-'));
  const root=path.join(base,'.solomap-global'),project=path.join(base,'project');fs.mkdirSync(project);
  const owner=await require('./analysis-fixture.js').openAnalysisOwner(t,root,[{path:project}]);
  const id=owner.projectIds.get(project),location=await owner.store.registerProject({root:project});
  const run=owner.store.prepareRun(id,location.locationId,{root:project,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'完整用户原文🌿'.repeat(10000),command:'claude',userMessage:'原目标',metadata:{interactiveSession:true,agentCli:'claude'},idempotencyKey:'damaged-history-run'});
  let binding=owner.store.writeRunBinding(id,{executionLogId:1,generation:run.generation,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:project,cliPath:'claude',bindingNonce:'damaged-view',method:'caller_assigned',contract:'official_stable'},idempotencyKey:'damaged-view-seed'});
  binding=owner.store.writeRunBinding(id,{executionLogId:1,generation:run.generation,expectedHeadRevision:binding.headRevision,revision:{sessionId:'original-native-session',method:'caller_assigned',contract:'official_stable',state:'planned'},idempotencyKey:'damaged-view-plan'});
  binding=owner.store.writeRunBinding(id,{executionLogId:1,generation:run.generation,expectedHeadRevision:binding.headRevision,confirmSessionId:'original-native-session',evidence:{source:'owned-fixture'},idempotencyKey:'damaged-view-confirm'});
  const output='完整保存的原始输出🌿\n'.repeat(10000);
  owner.store.updateProjectJournal(id,1,{agentCli:'claude',command:'claude',output,status:'Completed'});
  const before=owner.store.readRunTurnJournal(id,1);
  const damaged=structuredClone(binding);damaged.revisions[1].revision=1;
  const content=owner.store.putContent(JSON.stringify(damaged),'application/json');
  owner.store.db.run('UPDATE run_control SET binding_content_id=? WHERE project_id=? AND run_id=?',[content,id,run.runId]);
  const wal=fs.readFileSync(path.join(root,'solomap.db-wal'));
  const after=await owner.ops({operation:'read_run_turn_journal',input:{root:project,executionLogId:1}});
  assert.equal(after.entry.output,output);assert.equal(after.turnId,before.turnId);
  assert.deepEqual({...after.entry,dataState:undefined},{...before.entry,dataState:undefined});
  assert.equal(after.entry.dataState.resumableSessionId,'');
  await assert.rejects(owner.ops({operation:'read_run_binding',input:{root:project,executionLogId:1}}),error=>error.code==='identity_binding_invalid');
  assert.deepEqual(fs.readFileSync(path.join(root,'solomap.db-wal')),wal);
});

test('actual presentation keeps formal running and resumable conversations without old status or session files', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-formal-presentation-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  const call = (operation, input) => owner.ops({ operation, input });
  const prepared = await require('../out/agentRunPreparation.js').prepareAgentRun({ workspaceRoot: project, globalDataPath: root, agentCli: 'claude', selectedModel: '', nodeId: '__solo__', executionLogId: 1, runKind: 'solo', userMessage: '保留可继续的会话', prompt: '原始目标', taskPermissionMode: 'auto' }, call);
  const identity = { projectId: prepared.projectId, executionLogId: 1 };
  const present = async () => require('../out/conversationPresentation.js').buildConversationPresentations(project, '__solo__', (await call('read_project_journal', { root: project })).logs, Date.now() + 600000)[0];
  const running = await present(); assert.equal(running.status, 'Running'); assert.equal(running.capabilities.canStop, true); assert.equal(running.capabilities.canOpenTerminal, true);
  assert.equal(running.summary, '保留可继续的会话', 'ordinary conversation cards must show the user request rather than internal journal labels');
  assert.equal(running.conclusion, '');
  const binding = await call('read_run_binding', identity);
  await call('write_run_binding', { ...identity, generation: prepared.generation, expectedHeadRevision: binding.headRevision, confirmSessionId: prepared.status.plannedNativeSessionId, evidence: { source: 'official_native_observation' }, idempotencyKey: 'observed-formal-session' });
  let head = await call('read_run_checkpoint_state', identity);
  const proof = head.proof;
  head = await call('checkpoint_run', { ...identity, generation: head.generation, proof: head.proof, expectedRevision: head.revision, expectedTurnId: head.turnId, action: 'complete', outcome: 'partial', summary: '已完成本轮', idempotencyKey: 'formal-presentation-complete' });
  await call('checkpoint_run', { ...identity, generation: head.generation, proof, expectedRevision: head.revision, action: 'session-close', exitCode: 0, idempotencyKey: 'formal-presentation-close' });
  const closed = await present(); assert.equal(closed.capabilities.canContinue, true); assert.equal(closed.resumableNativeSessionId, prepared.status.plannedNativeSessionId); assert.equal(closed.capabilities.canStop, false);
  assert.equal(closed.summary, '保留可继续的会话'); assert.equal(closed.conclusion, '已完成本轮');
  assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  assert.ok(!JSON.stringify(closed).includes(head.proof), 'presentation cannot expose an execution proof');
});

test('concurrent first project registration waits for the complete identity file', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-register-race-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  fs.mkdirSync(project);
  const identity = path.join(project, '.solopreneur/project.json');
  const store = new UnifiedDataStore(root);
  const originalOpen = fs.openSync;
  let writes = 0;
  fs.openSync = (file, flags, mode) => {
    if (path.basename(String(file)) === 'project.json' && (Number(flags) & fs.constants.O_EXCL)) writes++;
    return originalOpen(file, flags, mode);
  };
  try {
    const first = store.registerProject({ root: project });
    const second = store.registerProject({ root: project }).then(value => ({ value }), error => ({ error: error.message }));
    const [registered, concurrent] = await Promise.all([first, second]);
    assert.equal(concurrent.error, undefined, 'a concurrent request must not parse the pending empty identity');
    assert.equal(concurrent.value.projectId, registered.projectId);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(fs.readFileSync(identity, 'utf8')).projectId, registered.projectId);
  } finally { fs.openSync = originalOpen; store.close(); }
});

test('scoped full history reads each durable page once and accepts an older unpaginated index owner', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-scoped-history-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const registered = await store.registerProject({ root: project });
  for (let id = 1; id <= 1001; id++) store.appendProjectJournal(registered.projectId, `seed:${id}`, { nodeId: 'older', timestamp: '2026-01-01T00:00:00.000Z', output: String(id), status: 'Completed' }, id);
  let scopedReads = 0; let indexReads = 0;
  let release; const gate = new Promise(resolve => { release = resolve; });
  let markStarted; const started = new Promise(resolve => { markStarted = resolve; });
  const indexes = Array.from({ length: 200 }, (_, offset) => ({ executionLogId: offset + 1, nodeId: 'older', files: [], signals: [] }));
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'scoped-history-owner', onCommand: () => ({ status: 'running' }), onData: async request => {
    if (request.operation === 'read_project_journal' && request.input.nodeId === 'older') {
      scopedReads++;
      if (!request.input.offset) { markStarted(); await gate; }
    }
    if (request.operation === 'read_project_run_indexes') { indexReads++; return indexes; }
    return operations(request);
  } });
  const engine = new SyncEngine(path.join(project, '.solopreneur/roadmap.csv'), path.join(project, '.solopreneur/project_journal.db'), path.resolve(__dirname, '..'), root);
  const indexEngine = new SyncEngine(path.join(project, '.solopreneur/roadmap.csv'), path.join(project, '.solopreneur/project_journal.db'), path.resolve(__dirname, '..'), root);
  try {
    const reading = engine.readAgentExecutions('older');
    await started; engine.close(); release();
    assert.equal((await reading).length, 1001, 'switching projects only cancels auxiliary history, not a formal settlement read');
    assert.equal(scopedReads, 3, 'continuation must not repeatedly reread the prefix of its history');
    await indexEngine.initAndSync();
    assert.equal(indexEngine.getRunIndexEntries().length, 200);
    assert.equal(indexReads, 2, 'an old owner returning exactly one full page must not cause an infinite paging loop');
  } finally { release(); engine.close(); indexEngine.close(); await server.close(); await operations.close(); store.close(); }
});

test('recent startup and new writes do not wait for historical journal or index hydration', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recent-startup-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const csv = path.join(project, '.solopreneur/roadmap.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,,');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const registered = await store.registerProject({ root: project });
  for (let id = 1; id <= 510; id++) store.appendProjectJournal(registered.projectId, `seed:${id}`, { nodeId: '__solo__', timestamp: '2026-01-01T00:00:00.000Z', output: String(id), status: 'Completed' }, id);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'recent-startup-owner', onCommand: () => ({ status: 'running' }), onData: async request => {
    const result = await operations(request);
    if (request.operation === 'read_project_run_indexes' || (request.operation === 'read_project_journal' && request.input.limit === 500)) await gate;
    return result;
  } });
  const engine = new SyncEngine(csv, path.join(path.dirname(csv), 'project_journal.db'), path.resolve(__dirname, '..'), root);
  try {
    const initialized = engine.initAndSync({ history: 'background' });
    assert.equal(await Promise.race([initialized.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]), true, 'bounded startup must finish while old history remains pending');
    fs.writeFileSync(csv, fs.readFileSync(csv, 'utf8').replace('1,Plan,', '1,Updated plan,'));
    engine.refreshNodes();
    assert.equal(engine.getNodes()[0].title, 'Updated plan', 'launch preparation must still read the current CSV without loading history');
    await new Promise(resolve => setTimeout(resolve, 20));
    const id = await engine.logAgentExecution('__solo__', 'codex', 'new', 'new during old hydration', 'Running');
    assert.equal(id, 511);
    assert.equal((await engine.readAgentExecutionPage('__solo__', 20)).logs[0].id, 511);
    await engine.updateAgentExecution(10, 'codex', 'updated', 'newer state', 'Processed');
    release();
    await engine.initAndSync();
    assert.equal(engine.getProjectAgentExecutions().length, 511);
    assert.equal(engine.getAgentExecutions('__solo__').find(log => log.id === 10).output, 'newer state', 'late history must retain an updated row that was outside the recent cache');
    assert.equal(engine.getAgentExecutions('__solo__')[0].id, 511);
    assert.equal((await engine.readAgentExecutionPage('__solo__', 20, 500)).logs.length, 11, 'older pages remain accessible');
  } finally { release(); engine.close(); await server.close(); await operations.close(); store.close(); }
});

test('background startup reserves unmigrated IDs without reading old outputs', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-legacy-id-reservation-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const journalPath = path.join(project, '.solopreneur/project_journal.db');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const legacy = new SqliteStore(journalPath, path.resolve(__dirname, '..'));
  await legacy.init();
  legacy.db.run('INSERT INTO execution_logs(id,nodeId,timestamp,output,status) VALUES(700,?,?,?,?)', ['__solo__', '2026-01-01T00:00:00.000Z', 'old source', 'Completed']);
  legacy.close();
  const original = fs.readFileSync(journalPath);
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'reservation-owner', onCommand: () => ({ status: 'running' }), onData: async request => {
    if (request.operation === 'read_project_journal' && request.input.limit === 500) await gate;
    return operations(request);
  } });
  const engine = new SyncEngine(path.join(path.dirname(journalPath), 'roadmap.csv'), journalPath, path.resolve(__dirname, '..'), root);
  try {
    await engine.initAndSync({ history: 'background' });
    const id = await engine.logAgentExecution('__solo__', 'codex', 'new', 'new before migration', 'Running');
    assert.equal(id, 701);
    assert.deepEqual((await engine.readAgentExecutionPage('__solo__', 20)).logs.map(log => log.id), [701]);
    await require('../out/projectDataMigration.js').importProjectJournal(store, journalPath, { projectRoot: project });
    assert.deepEqual((await engine.readAgentExecutionPage('__solo__', 20)).logs.map(log => log.id), [701, 700]);
    assert.deepEqual(fs.readFileSync(journalPath), original, 'explicit migration must retain the legacy source unchanged');
    release(); await engine.initAndSync();
  } finally { release(); engine.close(); await server.close(); await operations.close(); store.close(); }
});

test('formal startup after journal import does not reopen an unavailable legacy database', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-retired-startup-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const source = path.join(project, '.solopreneur/project_journal.db');
  const legacy = new (require('../out/db/sqliteStore.js').SqliteStore)(source, path.resolve(__dirname, '..')); await legacy.init();
  legacy.db.run('INSERT INTO execution_logs(id,nodeId,timestamp,output,status) VALUES(700,?,?,?,?)', ['__solo__', '2026-01-01T00:00:00.000Z', '历史全文🌿\n', 'Completed']);
  legacy.close();
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{path:project}]);
  await require('../out/projectDataMigration.js').importProjectJournal(owner.store, source, {projectRoot:project});
  fs.writeFileSync(source, 'fixture-owned retired source now unavailable'); const retained = fs.readFileSync(source);
  const engine = new SyncEngine(path.join(project,'.solopreneur/roadmap.csv'), source, path.resolve(__dirname,'..'), root); t.after(()=>engine.close());
  await engine.initAndSync({history:'background'});
  assert.equal(await engine.logAgentExecution('__solo__','codex','new','新任务全文🧭\n','Running'),701);
  assert.equal((await engine.readAgentExecutionById(700)).output,'历史全文🌿\n');
  assert.deepEqual(fs.readFileSync(source),retained);
});

test('journal migration reserves all historical IDs before yielding to a live writer', async () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-import-allocation-'));
  const root=path.join(base,'.solomap-global'),project=path.join(base,'project'),source=path.join(project,'.solopreneur/project_journal.db');
  const legacy=new (require('../out/db/sqliteStore.js').SqliteStore)(source,path.resolve(__dirname,'..')); await legacy.init();
  for(let id=1;id<=3;id++) legacy.db.run('INSERT INTO execution_logs(id,nodeId,timestamp,output,status) VALUES(?,?,?,?,?)',[id,'__solo__','2026-01-01T00:00:00.000Z',`原始正文${id}🌿\n`,'Completed']);
  legacy.close(); const original=fs.readFileSync(source);
  const store=new UnifiedDataStore(root); const projectId=(await store.registerProject({root:project})).projectId;
  const imported=store.importProjectJournal.bind(store); let live; let first=true;
  store.importProjectJournal=(...args)=>{const result=imported(...args); if(first){first=false;setImmediate(()=>{live=store.appendProjectJournal(projectId,'new-during-import',{nodeId:'__solo__',timestamp:new Date().toISOString(),output:'新的完整正文🧭\n',status:'Running'}).executionLogId;});}return result;};
  try{
    await require('../out/projectDataMigration.js').importProjectJournal(store,source,{projectRoot:project});
    assert.equal(live,4,'a live task must not take an ID still owned by the remaining source');
    for(let id=1;id<=3;id++) assert.equal(store.readProjectJournal(projectId,{executionLogId:id}).logs[0].output,`原始正文${id}🌿\n`);
    assert.equal(store.readProjectJournal(projectId,{executionLogId:live}).logs[0].output,'新的完整正文🧭\n');
    assert.deepEqual(fs.readFileSync(source),original);
  }finally{store.close();}
});

for (const kind of ['intent', 'flow']) test(`the first ${kind} run reserves historical journal identities through the owner without a SyncEngine`, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-direct-journal-allocation-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const source = path.join(project, '.solopreneur/project_journal.db');
  const legacy = new (require('../out/db/sqliteStore.js').SqliteStore)(source, path.resolve(__dirname, '..')); await legacy.init();
  legacy.db.run('INSERT INTO execution_logs(id,nodeId,timestamp,output,status) VALUES(700,?,?,?,?)', ['__solo__', '2026-01-01T00:00:00.000Z', '保留原编号及完整正文🌿\n', 'Completed']);
  legacy.close(); const original = fs.readFileSync(source);
  const store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({operation, input});
  try {
    const common = {root:project, prompt:'完整原始目标', command:'codex', userMessage:'新用户任务', metadata:{launchIntentHash:'direct-launch'}, idempotencyKey:'direct-prepare'};
    let run;
    if (kind === 'intent') run = await call('prepare_run_intent', {...common, nodeId:'__solo__', runKind:'solo', launchIntentId:'direct-first'});
    else {
      const {createFlowTrace, createFlowLoop} = require('../out/flowStore.js');
      const flow = createFlowTrace(project, common.userMessage); flow.loops=[createFlowLoop(flow.goal,1)];
      await call('write_flow_trace', {root:project, flow, expectedRevision:0, idempotencyKey:'direct-flow'});
      run = await call('prepare_flow_role', {...common, flowId:flow.flowId, loopId:'loop-1', role:'planner', attempt:0});
    }
    assert.equal(run.status.rootExecutionLogId,701);
    await require('../out/projectDataMigration.js').importProjectJournal(store,source,{projectRoot:project});
    assert.equal(store.readProjectJournal(run.projectId,{executionLogId:700}).logs[0].output,'保留原编号及完整正文🌿\n');
    assert.equal(store.readRunCheckpointState(run.projectId,701).runId,run.runId);
    assert.deepEqual(fs.readFileSync(source),original);
  } finally { await ops.close(); store.close(); }
});

test('journal allocation survives an owner restart and unchanged initialization writes nothing or rereads retained history', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-allocation-cold-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const source = path.join(project, '.solopreneur/project_journal.db');
  const legacy = new (require('../out/db/sqliteStore.js').SqliteStore)(source, path.resolve(__dirname, '..')); await legacy.init();
  const retainedOutput = '保留的大正文🌿\n'.repeat(50000);
  legacy.db.run('INSERT INTO execution_logs(id,nodeId,timestamp,output,status) VALUES(700,?,?,?,?)', ['__solo__', '2026-01-01T00:00:00.000Z', retainedOutput, 'Completed']); legacy.close();
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  try {
    assert.equal((await ops({operation:'initialize_project_journal',input:{root:project}})).minimumExecutionLogId,701);
    await ops.close(); store.close();
    fs.writeFileSync(source,'fixture-owned unavailable old source'); const retained=fs.readFileSync(source);
    store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    const walPath = path.join(root,'solomap.db-wal');
    const wal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
    let contentBytes=0; const content=store.content.bind(store);
    store.content=(...args)=>{const result=content(...args);contentBytes+=result.length;return result;};
    for(let i=0;i<20;i++) assert.equal((await ops({operation:'initialize_project_journal',input:{root:project}})).minimumExecutionLogId,701);
    assert.deepEqual(fs.existsSync(walPath)?fs.readFileSync(walPath):Buffer.alloc(0),wal,'unchanged initialization cannot write events, revisions or content');
    assert.ok(contentBytes<10000,`small allocation reads must not scale with retained history: ${contentBytes}`);
    assert.deepEqual(fs.readFileSync(source),retained);
    t.diagnostic(`retainedOutputBytes=${Buffer.byteLength(retainedOutput)} repeatedInitializations=20 allocationContentBytesRead=${contentBytes} unchangedWal=true`);
  } finally { await ops.close(); store.close(); }
});

test('legacy read-only lifecycle reconciliation does not write to the migration source', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-readonly-history-'));
  const journalPath = path.join(fixture, '.solopreneur/project_journal.db');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const legacy = new SqliteStore(journalPath, path.resolve(__dirname, '..'));
  await legacy.init();
  legacy.db.run('INSERT INTO execution_logs(nodeId,timestamp,output,status) VALUES(?,?,?,?)', ['step', '2020-01-01T00:00:00.000Z', 'Agent conversation started', 'Running']);
  legacy.close(); const original = fs.readFileSync(journalPath);
  const reader = new SqliteStore(journalPath, path.resolve(__dirname, '..'));
  try {
    await reader.initJournalReadOnly();
    assert.equal(reader.getRecentExecutionLogs(20)[0].status, 'Failed');
    assert.deepEqual(fs.readFileSync(journalPath), original);
  } finally { reader.close(); }
});

test('journal migration yields during both logs and indexes so new data can commit', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-yield-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const source = path.join(project, '.solopreneur/project_journal.db');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  for (let index = 0; index < 3; index++) {
    const id = legacy.logExecution('step', 'codex', 'run', `old ${index}`, 'Completed');
    legacy.upsertRunIndex({ executionLogId: id, nodeId: 'step', runKind: 'step', agentCli: 'codex', status: 'Completed', startedAt: '', finishedAt: '', durationMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, outputPath: '', outputBytes: 0, outputTail: '', commandPath: '', promptPath: '', changesPath: '', touchedFilesPath: '', updatedAt: '' });
  }
  legacy.close();
  const store = new UnifiedDataStore(root); const registered = await store.registerProject({ root: project });
  let logs = 0; let indexes = 0; const observed = [];
  const importLog = store.importProjectJournal.bind(store); const importIndex = store.importHistoricalRunIndex.bind(store);
  store.importProjectJournal = (...args) => {
    const result = importLog(...args); logs++;
    if (logs === 1) setImmediate(() => {
      observed.push(['logs', logs]);
      store.appendProjectJournal(registered.projectId, 'live-during-import', { nodeId: '__solo__', timestamp: new Date().toISOString(), output: 'new live data', status: 'Running' });
    });
    return result;
  };
  store.importHistoricalRunIndex = (...args) => {
    importIndex(...args); indexes++;
    if (indexes === 1) setImmediate(() => {
      observed.push(['indexes', indexes]);
      store.upsertProjectRunIndex(registered.projectId, { ...args[1], executionLogId: 2, outputTail: 'fresh live state', status: 'Processed' });
    });
  };
  try {
    await require('../out/projectDataMigration.js').importProjectJournal(store, source, { projectRoot: project });
    assert.deepEqual(observed, [['logs', 1], ['indexes', 1]]);
    assert.equal(store.readProjectJournal(registered.projectId).logs[0].output, 'new live data');
    assert.equal(store.readProjectRunIndexes(registered.projectId, { limit: 1, offset: 1 }).length, 1);
    assert.equal(store.readProjectRunIndexes(registered.projectId).find(index => index.executionLogId === 2).outputTail, 'fresh live state', 'legacy imports cannot overwrite a live index committed during a yield');
  } finally { store.close(); }
});

test('project journal writes are immediate and concurrent through the single Runtime owner', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-db-')), '.solomap-global');
  const project = path.join(path.dirname(root), 'project');
  fs.mkdirSync(project); fs.mkdirSync(root);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    const writes = await Promise.all(Array.from({ length: 12 }, (_, index) => operations({ operation: 'append_project_journal', input: {
      root: project, idempotencyKey: `run-${index}`, entry: { nodeId: 'step', timestamp: new Date(2026, 0, 1, 0, index).toISOString(), agentCli: 'codex', command: `command-${index}`, output: `output-${index}`, status: 'Processed' }
    } })));
    assert.equal(new Set(writes.map(item => item.executionLogId)).size, 12);
    const page = await operations({ operation: 'read_project_journal', input: { root: project, nodeId: 'step', limit: 20, offset: 0 } });
    assert.equal(page.logs.length, 12);
    assert.equal(page.hasMore, false);
    await operations({ operation: 'update_project_journal', input: { root: project, executionLogId: writes[0].executionLogId, agentCli: 'codex', command: 'updated', output: 'ready', status: 'Completed' } });
    const updated = await operations({ operation: 'read_project_journal', input: { root: project, executionLogId: writes[0].executionLogId, limit: 1 } });
    assert.equal(updated.logs[0].output, 'ready');
    assert.equal(updated.logs[0].status, 'Completed');
  } finally { await operations.close(); store.close(); }
});

test('project journal IDs are isolated per project', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-scope-')), '.solomap-global');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const projects = [path.join(path.dirname(root), 'one'), path.join(path.dirname(root), 'two')];
  projects.forEach(project => fs.mkdirSync(project));
  try {
    for (const project of projects) await operations({ operation: 'append_project_journal', input: { root: project, executionLogId: 1, idempotencyKey: 'legacy:1', entry: { nodeId: 'step', timestamp: '2026-01-01T00:00:00.000Z', agentCli: 'codex', command: 'run', output: project, status: 'Completed' } } });
    const histories = await Promise.all(projects.map(project => operations({ operation: 'read_project_journal', input: { root: project } })));
    assert.deepEqual(histories.map(history => [history.logs[0].id, history.logs[0].output]), [[1, projects[0]], [1, projects[1]]]);
  } finally { await operations.close(); store.close(); }
});

test('linking an existing conversation projects it onto a step without creating a journal-only execution', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-link-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const f = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  const source = await f.ops({ operation: 'append_project_journal', input: {
    root: project, idempotencyKey: 'solo-source', entry: {
      nodeId: '__solo__', timestamp: '2026-10-11T10:00:00.000Z', agentCli: 'copilot',
      command: 'copilot -p', output: '用户可见的完整回答', status: 'Completed'
    }
  } });
  await f.ops({ operation: 'link_project_journal', input: {
    root: project, executionLogId: source.executionLogId, nodeId: 'step-1', linkedAt: '2026-10-11T10:01:00.000Z'
  } });
  await f.ops({ operation: 'link_project_journal', input: {
    root: project, executionLogId: source.executionLogId, nodeId: 'step-1', linkedAt: '2026-10-11T10:01:00.000Z'
  } });

  const solo = await f.ops({ operation: 'read_project_journal', input: { root: project, nodeId: '__solo__' } });
  const step = await f.ops({ operation: 'read_project_journal', input: { root: project, nodeId: 'step-1' } });
  assert.equal(solo.logs.length, 1);
  assert.equal(step.logs.length, 1);
  assert.equal(step.logs[0].id, source.executionLogId);
  assert.equal(step.logs[0].nodeId, 'step-1');
  assert.equal(step.logs[0].status, 'Linked');
  assert.equal(step.logs[0].output, solo.logs[0].output);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM project_journal_entries')[0].count, 1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM project_journal_links')[0].count, 1);

  const projectData = path.join(project, '.solopreneur'); fs.mkdirSync(projectData, { recursive: true });
  const engine = new SyncEngine(path.join(projectData, 'roadmap.csv'), path.join(projectData, 'project_journal.db'), path.resolve(__dirname, '..'), root);
  t.after(() => engine.close());
  await engine.readAgentExecutions('__solo__');
  await engine.readAgentExecutions('step-1');
  assert.equal(engine.getAgentExecutions('__solo__').length, 1);
  assert.equal(engine.getAgentExecutions('step-1').length, 1);
  assert.equal(engine.getProjectAgentExecutions().length, 1, 'project-wide execution consumers must not count a relationship projection as another run');
  assert.equal((await engine.readAgentExecutionById(source.executionLogId)).nodeId, '__solo__');
});

test('SyncEngine loads complete journal pages and exposes writes only after durable commit', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-sync-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  fs.writeFileSync(path.join(solopreneur, 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,2026-01-01T00:00:00.000Z,');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const registered = await store.registerProject({ root: project });
  for (let id = 1; id <= 510; id++) store.appendProjectJournal(registered.projectId, `seed:${id}`, { nodeId: 'step', timestamp: '2026-01-01T00:00:00.000Z', agentCli: 'codex', command: 'run', output: String(id), status: 'Completed' }, id);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-sync-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  let serverOpen = true;
  const engine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
  try {
    await engine.initAndSync();
    assert.equal(engine.getProjectAgentExecutions().length, 510);
    const id = await engine.logAgentExecution('step', 'codex', 'new', 'durable', 'Running');
    assert.equal((await operations({ operation: 'read_project_journal', input: { root: project, executionLogId: id } })).logs[0].output, 'durable');
    await server.close(); serverOpen = false;
    const before = engine.getProjectAgentExecutions().length;
    await assert.rejects(engine.logAgentExecution('step', 'codex', 'failed', 'must not appear', 'Running'));
    assert.equal(engine.getProjectAgentExecutions().length, before);
    const restartedServer = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-sync-restarted', onCommand: () => ({ status: 'running' }), onData: operations });
    serverOpen = true;
    const restartedEngine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
    await restartedEngine.initAndSync();
    assert.equal(restartedEngine.getProjectAgentExecutions().length, 511);
    assert.equal(restartedEngine.getProjectAgentExecutions().some(entry => entry.output === 'must not appear'), false);
    restartedEngine.close();
    await restartedServer.close(); serverOpen = false;
  } finally { if (serverOpen) await server.close(); await operations.close(); store.close(); }
});

test('a direct execution read returns the newer cached record when its database response becomes stale', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-direct-read-race-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  fs.writeFileSync(path.join(solopreneur, 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,,');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const registered = await store.registerProject({ root: project });
  store.appendProjectJournal(registered.projectId, 'direct-read-race', { nodeId: '__solo__', timestamp: '2026-10-11T12:00:00.000Z', agentCli: 'codex', command: 'old', output: 'old', status: 'Running' }, 1);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let markStarted; const started = new Promise(resolve => { markStarted = resolve; });
  let delayed = true;
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'direct-read-race-owner', onCommand: () => ({ status: 'running' }), onData: async request => {
    const result = await operations(request);
    if (delayed && request.operation === 'read_project_journal' && request.input.executionLogId === 1) { delayed = false; markStarted(); await gate; }
    return result;
  } });
  const engine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
  try {
    const staleRead = engine.readAgentExecutionById(1);
    await started;
    await engine.updateAgentExecution(1, 'codex', 'new', 'fresh', 'Processed');
    release();
    const result = await staleRead;
    assert.equal(result.output, 'fresh');
    assert.equal(result.status, 'Processed');
  } finally { release(); engine.close(); await server.close(); await operations.close(); store.close(); }
});

test('plugin restart reserves legacy IDs and reads imported history only from the authority', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-restart-migration-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  fs.writeFileSync(path.join(solopreneur, 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,2026-01-01T00:00:00.000Z,');
  const journal = new (require('../out/db/sqliteStore.js').SqliteStore)(path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'));
  await journal.init(); const legacyId = journal.logExecution('step', 'codex', 'resume', 'legacy running task', 'Running'); journal.close();
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-restart-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  try {
    const engine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
    await engine.initAndSync();
    assert.equal(engine.getAgentExecutions('step').find(entry => entry.id === legacyId), undefined);
    const newId = await engine.logAgentExecution('step', 'codex', 'new', 'new run during migration', 'Running');
    assert.equal(newId, legacyId + 1);
    await operations({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: path.join(solopreneur, 'project_journal.db'), projectRoot: project, idempotencyKey: 'restart-race' } });
    await operations.waitForMigrations();
    const history = await operations({ operation: 'read_project_journal', input: { root: project, limit: 10 } });
    assert.deepEqual(history.logs.map(entry => entry.output), ['new run during migration', 'legacy running task']);
    assert.deepEqual((await engine.readAgentExecutions('step')).map(entry => entry.output), ['new run during migration', 'legacy running task']);
    engine.close();
  } finally { await server.close(); await operations.close(); store.close(); }
});

test('completed run artifacts are content-addressed in the global database', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-run-artifact-')), '.solomap-global');
  const project = path.join(path.dirname(root), 'project');
  fs.mkdirSync(project); fs.mkdirSync(root);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    const content = Buffer.from('the final task report');
    await operations({ operation: 'write_run_artifact', input: { root: project, executionLogId: 41, relativePath: 'task-report.json', mimeType: 'application/json', bytes: content.toString('base64'), hash: require('node:crypto').createHash('sha256').update(content).digest('hex') } });
    const artifact = await operations({ operation: 'read_run_artifact', input: { root: project, executionLogId: 41, relativePath: 'task-report.json' } });
    assert.equal(Buffer.from(artifact.bytes, 'base64').toString(), content.toString());
  } finally { await operations.close(); store.close(); }
});

test('legacy project data migrates in the background while live-consumer run files stay local', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-data-migration-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const journalPath = path.join(project, '.solopreneur', 'project_journal.db'); const runsRoot = path.join(project, '.solopreneur', 'agent-runs');
  fs.mkdirSync(runsRoot, { recursive: true }); fs.mkdirSync(root);
  const { SqliteStore } = require('../out/db/sqliteStore.js'); const journal = new SqliteStore(journalPath, path.resolve(__dirname, '..'));
  await journal.init(); const executionLogId = journal.logExecution('step', 'codex', 'run', 'legacy output', 'Processed'); journal.close();
  const artifact = path.join(runsRoot, '1', String(executionLogId), 'task-report.json'); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, '{"summary":"done"}');
  const recyclableArtifact = path.join(path.dirname(artifact), 'output.log'); fs.writeFileSync(recyclableArtifact, 'archived output');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  try {
    await operations({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: journalPath, projectRoot: project, idempotencyKey: 'journal' } });
    await operations({ operation: 'import_project_data', input: { collection: 'agent-runs', sourceRoot: runsRoot, projectRoot: project, idempotencyKey: 'runs' } });
    await operations.waitForMigrations();
    const history = await operations({ operation: 'read_project_journal', input: { root: project, nodeId: 'step' } });
    assert.equal(history.logs[0].output, 'legacy output');
    const archived = await operations({ operation: 'read_run_artifact', input: { root: project, executionLogId, relativePath: path.join('1', String(executionLogId), 'task-report.json') } });
    assert.equal(Buffer.from(archived.bytes, 'base64').toString(), '{"summary":"done"}');
    const overview = await operations({ operation: 'migration_overview', input: {} });
    assert.equal(overview.jobs.filter(job => ['project-journal', 'agent-runs'].includes(job.args.collection)).every(job => job.status === 'completed'), true);
    assert.equal(overview.reviewableFiles, 1);
    assert.equal(overview.recyclableFiles, 0);
    assert.equal(fs.existsSync(journalPath), true); assert.equal(fs.existsSync(artifact), true);
    const plan = await operations({ operation: 'prepare_recycling', input: {} });
    assert.deepEqual(plan.files.map(file => path.basename(file.path)), ['project_journal.db'], 'the exact captured physical journal becomes reviewable after its consistent snapshot is imported');
    assert.equal(plan.files.some(file => file.path === artifact), false, 'task reports remain available to live consumers');
    assert.equal(fs.existsSync(journalPath), true);
  } finally { await operations.close(); store.close(); }
});

test('legacy growth migration yields between snapshots so Runtime control remains responsive', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-growth-yield-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const source = path.join(project, '.solopreneur', 'project_growth.db');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(root);
  t.after(() => {
    for (const file of [source + '-shm', source + '-wal', source, path.join(project, '.solopreneur', 'project.json'), path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(source), project, root, fixture]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const { SqliteStore } = require('../out/db/sqliteStore.js'); const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  await legacy.init();
  for (const id of ['growth-one', 'growth-two']) legacy.writeGrowthSnapshot({
    snapshot: { id, createdAt: new Date().toISOString(), projectPath: project, gitHead: '', scanReason: 'test', status: 'completed', durationMs: 1, error: '' },
    nodes: [], edges: [], signals: [], labels: []
  });
  legacy.close();
  const store = new UnifiedDataStore(root);
  const originalWrite = store.writeProjectGrowth.bind(store);
  let yieldedAfterFirst = false; let writes = 0; const observations = [];
  store.writeProjectGrowth = (...args) => {
    writes += 1;
    if (writes === 2) observations.push(yieldedAfterFirst);
    const result = originalWrite(...args);
    if (writes === 1) setImmediate(() => { yieldedAfterFirst = true; });
    return result;
  };
  try {
    await importProjectGrowth(store, source, { projectRoot: project });
    assert.deepEqual(observations, [true]);
  } finally { store.close(); }
});

test('captured growth source resumes after restart until it is fully imported', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-growth-resume-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const source = path.join(project, '.solopreneur', 'project_growth.db');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(root);
  t.after(() => {
    for (const file of [source + '-shm', source + '-wal', source, path.join(project, '.solopreneur', 'project.json'), path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(source), project, root, fixture]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const { SqliteStore } = require('../out/db/sqliteStore.js'); const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  await legacy.init();
  legacy.writeGrowthSnapshot({ snapshot: { id: 'resume-growth', createdAt: new Date().toISOString(), projectPath: project, gitHead: '', scanReason: 'test', status: 'completed', durationMs: 1, error: '' }, nodes: [], edges: [], signals: [], labels: [] });
  legacy.close();
  const store = new UnifiedDataStore(root); const bytes = fs.readFileSync(source);
  store.captureMigrationSource({ identity: `project-growth:${project}`, key: path.basename(source), hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  try {
    const result = await importProjectGrowth(store, source, { projectRoot: project });
    assert.equal(result.imported, 1);
    assert.equal(store.readMigrationSource(`project-growth:${project}`, path.basename(source)).stage, 'imported');
  } finally { store.close(); }
});

test('growth writes do not scan the remaining node list for every inserted parent', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/db/unifiedDataStore.ts'), 'utf8');
  assert.doesNotMatch(source, /pendingNodes\.findIndex/);
});

test('each growth snapshot relies on transaction constraints instead of rescanning the whole database', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/db/unifiedDataStore.ts'), 'utf8');
  const body = source.slice(source.indexOf('public writeProjectGrowth('), source.indexOf('public readProjectGrowth('));
  assert.doesNotMatch(body, /PRAGMA foreign_key_check/);
});

test('unchanged migration capture reuses its committed hash without rereading the archived source', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/db/unifiedDataStore.ts'), 'utf8');
  const body = source.slice(source.indexOf('public captureMigrationSource('), source.indexOf('public readMigrationSource('));
  const unchanged = body.slice(body.indexOf('if (previous?.captured_hash'), body.indexOf('const contentId'));
  assert.doesNotMatch(unchanged, /this\.content\(/);
});

test('project journal migration uses a read-only history path without lifecycle reconciliation writes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/projectDataMigration.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function importProjectJournal'), source.indexOf('async function filesUnder'));
  assert.match(body, /getExecutionJournalPageRaw/);
  assert.doesNotMatch(body, /getAllExecutionLogs\(\)/);
});

test('agent-run migration skips unrelated changing files and records unreadable durable directories without stopping the queue', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-run-conflicts-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const runs = path.join(project, '.solopreneur', 'agent-runs');
  const changing = path.join(runs, 'changing.log'); const denied = path.join(runs, 'denied');
  fs.mkdirSync(denied, { recursive: true }); fs.mkdirSync(root); fs.writeFileSync(changing, 'active');
  const store = new UnifiedDataStore(root); const lstat = fs.promises.lstat; const readdir = fs.promises.readdir; let stats = 0;
  fs.promises.lstat = async file => {
    const value = await lstat(file);
    if (file === changing && ++stats > 1) return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { mtimeMs: value.mtimeMs + 1 });
    return value;
  };
  fs.promises.readdir = async (directory, options) => {
    if (directory === denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readdir(directory, options);
  };
  try {
    const result = await importAgentRuns(store, runs, { projectRoot: project });
    assert.equal(result.imported, 0);
    assert.deepEqual(result.conflicts.map(item => path.basename(item.source)).sort(), ['denied']);
  } finally { fs.promises.lstat = lstat; fs.promises.readdir = readdir; store.close(); }
});

test('captured agent-run source resumes after restart until its artifact is written', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-run-resume-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const runs = path.join(project, '.solopreneur', 'agent-runs');
  const relativePath = path.join('3', 'output.log'); const source = path.join(runs, relativePath); const bytes = Buffer.from('captured-before-interruption');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(root); fs.writeFileSync(source, bytes);
  let store = new UnifiedDataStore(root);
  store.captureMigrationSource({ identity: `agent-runs:${project}`, key: relativePath, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  store.close(); store = new UnifiedDataStore(root);
  try {
    const result = await importAgentRuns(store, runs, { projectRoot: project });
    const registered = await store.registerProject({ root: project });
    assert.equal(result.imported, 1);
    const indexedRuns = store.readProjectRunIndexes(registered.projectId);
    assert.equal(indexedRuns.length, 1); assert.equal(indexedRuns[0].nodeId, '3'); assert.ok(indexedRuns[0].executionLogId > 0);
    assert.equal(Buffer.from(store.readRunArtifact(registered.projectId, indexedRuns[0].executionLogId, relativePath).bytes, 'base64').toString(), bytes.toString());
  } finally { store.close(); }
});

test('agent-run resume preserves a newer database artifact and records the conflict', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-run-newer-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const runs = path.join(project, '.solopreneur', 'agent-runs');
  const relativePath = path.join('4', 'output.log'); const source = path.join(runs, relativePath); const legacy = Buffer.from('legacy'); const current = Buffer.from('new live write');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(root); fs.writeFileSync(source, legacy);
  const store = new UnifiedDataStore(root); const registered = await store.registerProject({ root: project });
  const legacyHash = crypto.createHash('sha256').update(legacy).digest('hex'); const currentHash = crypto.createHash('sha256').update(current).digest('hex');
  store.captureMigrationSource({ identity: `agent-runs:${project}`, key: relativePath, hash: legacyHash }, legacy, { mimeType: 'application/octet-stream', encoding: 'binary' });
  store.writeRunArtifact(registered.projectId, { executionLogId: 4, relativePath, bytes: current.toString('base64'), hash: currentHash });
  try {
    const result = await importAgentRuns(store, runs, { projectRoot: project });
    const artifact = store.readRunArtifact(registered.projectId, 4, relativePath);
    assert.equal(result.imported, 0);
    assert.deepEqual(result.conflicts.map(item => path.basename(item.source)), ['output.log']);
    assert.equal(Buffer.from(artifact.bytes, 'base64').toString(), current.toString());
  } finally { store.close(); }
});
