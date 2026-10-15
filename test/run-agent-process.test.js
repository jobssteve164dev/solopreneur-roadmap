const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { sendRuntimeDataRequest, sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');
const { shellQuote } = require('../out/agentCli.js');

test('the shared packaged runner commits complete output and host completion without generating per-run programs', async () => {
  const runner = path.resolve(__dirname, '../out/runAgentProcess.js');
  assert.ok(fs.existsSync(runner), 'a shared packaged runner must replace per-run program copies');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-shared-runner-'));
  const root = path.join(base, '.solomap-global');
  const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const seed = new UnifiedDataStore(root);
  const project = await seed.registerProject({ root: projectRoot });
  const expected = Buffer.from('α🌿\n'.repeat(10000));
  const source = "process.stdout.write('α🌿\\n'.repeat(10000));process.stderr.write(Buffer.from([0,255,10]));";
  seed.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '任务全文', command: `env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`, userMessage: '用户目标', metadata: { interactiveSession: false }, idempotencyKey: 'prepare' });
  seed.close();
  const runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let errors = ''; runtime.stderr.on('data', b => { errors += b; }); runtime.stdout.resume();
  let agent;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
      assert.equal(runtime.exitCode, null, errors); assert.ok(Date.now() < deadline, errors || 'Runtime must become ready');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    agent = spawn(process.execPath, [runner, '--global-data-path', root, '--project-path', projectRoot, '--execution-log-id', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; let runnerErrors = ''; agent.stdout.on('data', b => stdout.push(b)); agent.stderr.on('data', b => { runnerErrors += b; });
    const [code] = await once(agent, 'exit');
    assert.equal(code, 0, runnerErrors);
    assert.deepEqual(Buffer.concat(stdout), expected);
    const read = (operation, input) => sendRuntimeDataRequest(root, { operation, input: { root: projectRoot, executionLogId: 1, ...input } });
    const state = await read('read_run_state', {});
    assert.equal(state.status.status, 'In Progress');
    assert.equal(state.status.checkpointOutcome, 'partial');
    const parts = []; let offset = 0;
    do { const page = await read('read_run_log', { stream: 'stdout', offset, limit: 8192 }); parts.push(Buffer.from(page.bytes, 'base64')); offset = page.nextOffset; } while (offset !== null);
    assert.deepEqual(Buffer.concat(parts), expected);
    const stderr = await read('read_run_log', { stream: 'stderr', offset: 0 });
    assert.deepEqual(Buffer.from(stderr.bytes, 'base64'), Buffer.from([0,255,10]));
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.solopreneur')), ['project.json']);
    assert.equal(fs.existsSync(path.join(root, 'tmp')), false, 'no path was required by this command');
  } finally {
    if (agent && agent.exitCode === null) { const exited = once(agent, 'exit'); agent.kill('SIGTERM'); await exited; }
    if (runtime.exitCode === null) { const exited = once(runtime, 'exit'); await sendRuntimeControlCommand(root, 'stop'); await exited; }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the shared runner retries its initial claim after the terminal host advances the run revision', async () => {
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('claimed after terminal delivery')")}`);
  const hook = path.join(path.dirname(f.root), 'advance-before-claim.cjs');
  const deliveryId = 'terminal-delivery-race';
  try {
    let state = await f.call('read_run_state');
    state = await f.call('patch_run_state', {
      generation: state.generation,
      expectedRevision: state.revision,
      patch: { terminalDeliveryId: deliveryId },
      idempotencyKey: 'terminal-delivery-identity'
    });
    fs.writeFileSync(hook, `const api=require(${JSON.stringify(path.resolve(__dirname, '../out/autonomousRuntimeControl.js'))});
const original=api.sendRuntimeDataRequest;let advanced=false;
api.sendRuntimeDataRequest=async function(root,request){
 if(!advanced&&request.operation==='claim_run'){
  advanced=true;
  const current=await original(root,{operation:'read_run_state',input:{projectId:request.input.projectId,executionLogId:request.input.executionLogId}});
  await original(root,{operation:'patch_run_state',input:{projectId:current.projectId,executionLogId:request.input.executionLogId,generation:current.generation,expectedRevision:current.revision,patch:{terminalCommandSubmittedAt:'2026-10-13T00:00:00.000Z'},idempotencyKey:'host-submitted-command-before-claim'}});
 }
 return original(root,request);
};`);
    const agent = f.startAgent({ ...process.env, NODE_OPTIONS: `--require=${hook}`, SOLOMAP_TERMINAL_DELIVERY_ID: deliveryId });
    const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    assert.equal(f.stdout().toString(), 'claimed after terminal delivery');
    const claimed = await f.call('read_run_state');
    assert.equal(claimed.generation, state.generation + 1);
    assert.ok(claimed.status.agentPid > 0);
    assert.equal(claimed.status.terminalClaimDeliveryId, deliveryId);
  } finally { await f.close(); }
});

for (const exitCode of [0, 7]) test(`maintenance execution captures its full result and logs before exit ${exitCode}`, async () => {
  const resultBytes = Buffer.from(JSON.stringify({ success: exitCode === 0, detail: '完整安装回执🌿'.repeat(10000) }) + '\n');
  const output = '完整安装输出🌿\n'.repeat(10000);
  const program = `require('fs').writeFileSync(process.env.FIXTURE_RESULT_FILE, JSON.stringify({success:${exitCode === 0},detail:'完整安装回执🌿'.repeat(10000)})+${JSON.stringify('\n')}); process.stdout.write(${JSON.stringify('完整安装输出🌿\n')}.repeat(10000)); process.exitCode=${exitCode};`;
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`, {}, '', 'skill_install');
  const directory = path.join(f.root, 'tmp', 'isolated-install'); fs.mkdirSync(directory, { recursive: true });
  const resultPath = path.join(directory, 'result.json');
  try {
    const state = await f.call('read_run_state');
    await f.call('patch_run_state', { generation: state.generation, expectedRevision: state.revision,
      patch: { maintenanceResultPath: resultPath, maintenanceWorkspaceRoot: directory }, idempotencyKey: 'owned-install-paths' });
    const agent = f.startAgent({ ...process.env, FIXTURE_RESULT_FILE: resultPath });
    const [code] = await once(agent, 'exit'); assert.equal(code, exitCode, f.stderr().toString());
    const final = await f.call('read_run_state');
    const purpose = `maintenance_result_${final.generation}`;
    const recorded = await f.call('read_run_document', { purpose });
    assert.ok(recorded, 'the shared host must capture the exact receipt before settling the run');
    assert.deepEqual(Buffer.from(recorded.bytes, 'base64'), resultBytes);
    assert.equal(f.stdout().toString(), output);
    await f.stopRuntime(); await f.startRuntime();
    assert.deepEqual(await f.call('read_run_document', { purpose }), recorded);
    assert.equal((await f.call('read_run_state')).status.exitCode, exitCode);
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('a migration run completes through the shared runner without a private result file', async () => {
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('migration tools finished')")}`, {}, '', 'migration_apply');
  try {
    const agent = f.startAgent();
    const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    const state = await f.call('read_run_state');
    assert.equal(state.status.maintenanceResultPath, undefined);
    assert.equal(await f.call('read_run_document', { purpose: `maintenance_result_${state.generation}` }), null);
    assert.equal(f.stdout().toString(), 'migration tools finished');
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

async function executionFixture(command, metadata = {}, initialOutput = '', runKind = 'solo') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solomap-shared-runner-case-'🌿-"));
  const root = path.join(base, '.solomap-global');
  const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  require('node:child_process').execFileSync('git', ['init', '-q', projectRoot]);
  assert.equal(require('node:child_process').execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), projectRoot);
  const seed = new UnifiedDataStore(root);
  const project = await seed.registerProject({ root: projectRoot });
  const prepared = seed.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: '__solo__', runKind, prompt: '任务原文', command, userMessage: '用户目标', metadata, idempotencyKey: 'prepare' });
  if (initialOutput) seed.appendRunLog(project.projectId, { executionLogId: 1, generation: prepared.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from(initialOutput).toString('base64'), idempotencyKey: 'existing-output' });
  seed.close();
  let runtime; let agent; const output = []; const errors = [];
  const startRuntime = async () => {
    runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
    runtime.stdout.resume(); let runtimeErrors = ''; runtime.stderr.on('data', b => { runtimeErrors += b; });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
      assert.equal(runtime.exitCode, null, runtimeErrors); assert.ok(Date.now() < deadline, runtimeErrors || 'Runtime readiness');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const stopRuntime = async () => {
    if (runtime?.exitCode === null) { const exited = once(runtime, 'exit'); await sendRuntimeControlCommand(root, 'stop'); await exited; }
  };
  await startRuntime();
  return {
    root, projectRoot, prepared, startRuntime, stopRuntime,
    call: (operation, input = {}) => sendRuntimeDataRequest(root, { operation, input: { projectId: prepared.projectId, executionLogId: 1, ...input } }),
    startAgent(env = process.env, selectedExecutionLogId = 1) {
      agent = spawn(process.execPath, [path.resolve(__dirname, '../out/runAgentProcess.js'), '--global-data-path', root, '--project-path', projectRoot, '--execution-log-id', String(selectedExecutionLogId)], { stdio: 'pipe', env });
      agent.stdout.on('data', b => output.push(b)); agent.stderr.on('data', b => errors.push(b));
      return agent;
    },
    stdout: () => Buffer.concat(output), stderr: () => Buffer.concat(errors),
    async close() {
      if (agent?.exitCode === null && agent.signalCode === null) { const exited = once(agent, 'exit'); agent.kill('SIGTERM'); await exited; }
      await stopRuntime();
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

test('the shared runner preserves the captured Claude native home after the process default changes', async () => {
  const program = "process.stdout.write(process.env.CLAUDE_CONFIG_DIR); require('fs').writeFileSync('result.txt','actual result');";
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`, { agentCli: 'claude', sessionProvider: 'claude', interactiveSession: false });
  const home = path.join(f.root, 'native-home'); const other = path.join(f.root, 'other-native-home');
  try {
    await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'claude', workspaceRoot: f.projectRoot, cliPath: 'claude', bindingNonce: '2'.repeat(64), method: 'caller_assigned', contract: 'official_stable', providerContext: { claude: { claudeHome: home } } }, idempotencyKey: 'claude-home-seed' });
    const agent = f.startAgent({ ...process.env, CLAUDE_CONFIG_DIR: other });
    assert.equal((await once(agent, 'exit'))[0], 0, f.stderr().toString());
    assert.equal(f.stdout().toString(), home);
    assert.equal(fs.existsSync(other), false);
  } finally { await f.close(); }
});

test('Claude preflight preserves the source native MCP configuration after the default root changes', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-claude-config-pin-'));
  const original = path.join(base, 'source', '.claude.json'); const other = path.join(base, 'other', '.claude.json');
  fs.mkdirSync(path.dirname(original), { recursive: true }); fs.writeFileSync(original, JSON.stringify({ theme: 'user-choice', mcpServers: { existing: { command: 'user-command' } } }));
  const program = "require('fs').writeFileSync('result.txt','actual result');";
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`, {
    agentCli: 'claude', sessionProvider: 'claude', interactiveSession: false, agentDatabaseConfigPath: other,
    agentLaunch: { schemaVersion: 1, agentCli: 'claude', selectedModel: '', taskPermissionMode: 'auto', continuation: false, direct: true }
  });
  try {
    await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'claude', workspaceRoot: f.projectRoot, cliPath: 'claude', bindingNonce: '3'.repeat(64), method: 'caller_assigned', contract: 'official_stable', providerContext: { claude: { claudeHome: path.dirname(original), configPath: original } } }, idempotencyKey: 'claude-config-seed' });
    const agent = f.startAgent({ ...process.env, CLAUDE_CONFIG_DIR: path.dirname(other) });
    assert.equal((await once(agent, 'exit'))[0], 0, f.stderr().toString());
    const configured = JSON.parse(fs.readFileSync(original, 'utf8'));
    assert.equal(configured.mcpServers.solomap_data?.env.SOLOMAP_MANAGED_BRIDGE, '1');
    assert.equal(configured.theme, 'user-choice'); assert.deepEqual(configured.mcpServers.existing, { command: 'user-command' });
    assert.equal(fs.existsSync(other), false);
  } finally { await f.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('a default Claude native context keeps the config override unset when the runner inherits another override', async () => {
  const program = "process.stdout.write(String(process.env.CLAUDE_CONFIG_DIR || 'unset')); require('fs').writeFileSync('result.txt','actual result');";
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`, { agentCli: 'claude', sessionProvider: 'claude', interactiveSession: false });
  try {
    await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'claude', workspaceRoot: f.projectRoot, cliPath: 'claude', bindingNonce: '4'.repeat(64), method: 'caller_assigned', contract: 'official_stable', providerContext: { claude: { claudeHome: path.join(f.root, 'default-home'), configDirOverride: null } } }, idempotencyKey: 'claude-default-seed' });
    const agent = f.startAgent({ ...process.env, CLAUDE_CONFIG_DIR: path.join(f.root, 'other-home') });
    assert.equal((await once(agent, 'exit'))[0], 0, f.stderr().toString());
    assert.equal(f.stdout().toString(), 'unset');
  } finally { await f.close(); }
});

for (const kind of ['unchanged-old', 'new-receipt', 'invalid-directory']) test(`maintenance recovery identity and failed sealing preserve ${kind}`, async () => {
  const program = kind === 'new-receipt' ? "require('fs').writeFileSync(process.env.FIXTURE_RESULT_FILE,'new receipt🌿')" : kind === 'invalid-directory' ? "require('fs').mkdirSync(process.env.FIXTURE_RESULT_FILE)" : "process.stdout.write('no receipt produced')";
  const f = await executionFixture(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`, {}, '', 'mcp_install');
  const resultPath = path.join(f.root, 'tmp', 'owned-operation', 'result.json'); fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  try {
    if (kind !== 'invalid-directory') fs.writeFileSync(resultPath, 'previous receipt🌿');
    const oldPurpose = `maintenance_result_${f.prepared.generation}`;
    const old = await f.call('write_run_document', { generation: f.prepared.generation, turnId: f.prepared.turnId, purpose: oldPurpose,
      bytes: Buffer.from('previous receipt🌿').toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'previous-maintenance-receipt' });
    let state = await f.call('read_run_state');
    await f.call('patch_run_state', { generation: state.generation, expectedRevision: state.revision, patch: { maintenanceResultPath: resultPath }, idempotencyKey: 'maintenance-result-target' });
    const agent = f.startAgent({ ...process.env, FIXTURE_RESULT_FILE: resultPath }); const [code] = await once(agent, 'exit');
    state = await f.call('read_run_state');
    assert.ok(state.generation > f.prepared.generation);
    const current = await f.call('read_run_document', { purpose: `maintenance_result_${state.generation}` });
    assert.equal(code, kind === 'new-receipt' ? 0 : 1, f.stderr().toString());
    if (kind === 'new-receipt') assert.equal(Buffer.from(current.bytes, 'base64').toString(), 'new receipt🌿');
    else {
      assert.equal(current, null); assert.equal(state.status.status, 'Failed');
      assert.match(String(state.status.summary || state.status.checkpointSummary), kind === 'unchanged-old' ? /maintenance_result_missing/ : /capability_attachment_path_invalid/);
    }
    assert.equal((await f.call('read_run_document', { purpose: oldPurpose })).objectId, old.objectId);
    assert.equal(fs.existsSync(resultPath), true, 'old and failed physical evidence must be retained');
  } finally { await f.close(); }
});

test('the packaged review runner preserves native read-only flags, seals full JSON, and retires its path input', async () => {
  for (const mode of ['valid', 'writes', 'invalid']) {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-cli-'));
    const cli = path.join(cliRoot, 'codex');
    const source = `const fs=require('fs');const args=process.argv.slice(1);if(!args.includes('read-only')||!args.includes('never'))process.exit(9);const prompt=fs.readFileSync(0,'utf8');if(prompt!=='任务原文')process.exit(8);${mode === 'writes' ? "fs.writeFileSync('forbidden-change.txt','changed');" : ''}process.stdout.write(${JSON.stringify(mode === 'invalid' ? 'no decision' : 'SOLOMAP_REVIEW_JSON_START\n{"status":"pass","summary":"完整复核🌿","findings":[],"nextAction":"","criteria":[],"goalSatisfied":true,"evidenceSufficient":true}\nSOLOMAP_REVIEW_JSON_END')});`;
    fs.writeFileSync(cli, `#!/bin/bash\nexec ${shellQuote(process.execPath)} -e ${shellQuote(source)} -- "$@"\n`, { mode: 0o755 });
    const metadata = { agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: '', taskPermissionMode: 'auto', continuation: false, direct: false, readOnly: true } };
    const f = await executionFixture('placeholder', metadata, '', 'agent_review');
    try {
      const agent = f.startAgent(); const [code] = await once(agent, 'exit');
      assert.equal(code, mode === 'valid' ? 0 : mode === 'writes' ? 126 : 125, f.stderr().toString());
      const state = await f.call('read_run_state');
      if (mode === 'valid') {
        const result = await f.call('read_run_document', { purpose: 'review_result' });
        assert.equal(JSON.parse(Buffer.from(result.bytes, 'base64')).summary, '完整复核🌿');
        assert.equal(state.status.status, 'In Progress');
      } else assert.equal(state.status.failureCode, mode === 'writes' ? 'reviewer_workspace_modified' : 'agent_review_failed');
      assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'tmp')), []);
    } finally { await f.close(); fs.rmSync(cliRoot, { recursive: true, force: true }); }
  }
});

for (const mode of ['auto', 'never']) for (const preconfirmed of [false, true]) test(`an unattended Codex correction preserves ${mode} permissions and official native identity${preconfirmed ? ' when preconfirmed' : ''}`, async () => {
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-correction-cli-'));
  const cli = path.join(cliRoot, 'codex'); const sessionId = 'cc70ea64-51ec-41ef-842b-72f62bb8b7b3';
  const home = path.join(cliRoot, 'source-codex-home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "original-provider-model"\n');
  const text = '完整修正输出🌿'.repeat(20000);
  const source = `if(JSON.stringify(process.argv.slice(1,4))!==JSON.stringify(['--profile','solomap','app-server']))process.exit(9);const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){if(m.params.capabilities!==null)process.exit(6);send({id:0,result:{}});}if(m.method==='thread/resume'){if(m.params.threadId!==${JSON.stringify(sessionId)}||${mode === 'auto' ? "m.params.sandbox!=='danger-full-access'||m.params.approvalPolicy!=='never'" : "m.params.sandbox!==undefined||m.params.approvalPolicy!==undefined"})process.exit(8);send({id:1,result:{thread:{id:m.params.threadId}}});}if(m.method==='turn/start'){if(m.params.input[0].text!=='任务原文'||!Array.isArray(m.params.input[0].text_elements))process.exit(7);require('fs').writeFileSync('correction.txt','交付');send({id:2,result:{turn:{id:'native-turn-one'}}});send({method:'item/agentMessage/delta',params:{threadId:${JSON.stringify(sessionId)},turnId:'native-turn-one',delta:'完整修正输出🌿'.repeat(20000)}});send({method:'turn/completed',params:{threadId:${JSON.stringify(sessionId)},turn:{id:'native-turn-one',status:'completed'}}});}});`;
  const sourceContextCheck = `if(process.env.CODEX_HOME!==${JSON.stringify(home)}){process.stderr.write('source_codex_home_lost');process.exit(5);}if(!require('fs').readFileSync(require('path').join(process.env.CODEX_HOME,'solomap.config.toml'),'utf8').includes('SoloMap managed database MCP begin')){process.stderr.write('source_codex_mcp_missing');process.exit(4);}`;
  fs.writeFileSync(cli, `#!/bin/bash\nexec ${shellQuote(process.execPath)} -e ${shellQuote(sourceContextCheck + source)} -- "$@"\n`, { mode: 0o755 });
  const launch = { schemaVersion: 1, agentCli: cli, selectedModel: 'original-model', taskPermissionMode: mode, continuation: true, direct: false };
  const f = await executionFixture('placeholder', { agentLaunch: launch, agentCli: cli, plannedNativeSessionId: sessionId, agentDatabaseConfigPath: path.join(cliRoot, 'config.toml'), bindingNonce: '1'.repeat(64) }, '', 'agent_review_revision');
  try {
    const binding = await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: f.projectRoot, cliPath: cli, bindingNonce: '1'.repeat(64), createdAt: f.prepared.status.startedAt, providerContext: { codex: { codexHome: home } }, method: 'provider_callback', contract: 'official_stable' }, idempotencyKey: 'revision-binding-seed' });
    const planned = await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: binding.headRevision, revision: { sessionId, method: 'provider_callback', contract: 'official_stable', state: 'planned', createdAt: f.prepared.status.startedAt, evidence: { source: 'confirmed_resume_target' } }, idempotencyKey: 'revision-binding-planned' });
    if (preconfirmed) await f.call('write_run_binding', { generation: f.prepared.generation, expectedHeadRevision: planned.headRevision, confirmSessionId: sessionId, evidence: { source: 'confirmed_resume_transcript' }, idempotencyKey: 'revision-binding-preconfirmed' });
    const agent = f.startAgent({ ...process.env, CODEX_HOME: path.join(cliRoot, 'other-codex-home') }); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString()); assert.ok(f.stdout().toString().includes(text));
    assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /model = "original-provider-model"/);
    assert.equal(fs.existsSync(path.join(cliRoot, 'config.toml')), false, 'the fallback configuration must not replace the source session configuration');
    assert.equal(fs.existsSync(path.join(cliRoot, 'other-codex-home')), false, 'the current default must not receive the source session configuration');
    const confirmed = await f.call('read_run_binding');
    assert.equal(confirmed.revisions.at(-1).state, 'confirmed'); assert.equal(confirmed.revisions.at(-1).sessionId, sessionId);
    assert.equal(confirmed.headRevision, 3, 'the native handshake must retain a matching confirmation without adding another revision');
    assert.equal((await f.call('read_run_state')).status.nativeSessionIdIsCurrent, true);
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); fs.rmSync(cliRoot, { recursive: true, force: true }); }
});

test('an automatic correction preserves the pre-session commit and seals its own complete Git diff', async () => {
  const { execFileSync } = require('node:child_process');
  const command = `${shellQuote(process.execPath)} -e ${shellQuote("require('fs').writeFileSync('result.txt','修正后的交付');process.stdout.write('已修正')")}`;
  const f = await executionFixture(command, {}, '', 'agent_review_revision');
  const git = (...args) => execFileSync('git', ['-C', f.projectRoot, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(f.projectRoot, 'result.txt'), '第一轮已提交产物'); git('add', 'result.txt'); git('commit', '-q', '-m', 'fixture baseline');
    const originalHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(f.projectRoot, 'result.txt'), '复核前未提交产物');
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    const state = await f.call('read_run_state');
    assert.match(String(state.status.baseGitHash || ''), /^[a-f0-9]{40}$/);
    assert.notEqual(state.status.baseGitHash, originalHead);
    assert.equal(git('show', `${state.status.baseGitHash}:result.txt`), '复核前未提交产物');
    const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
    const client = new RunLifecycleClient((operation, input) => f.call(operation, input));
    const ref = runStatusReference(f.projectRoot, 1); const status = await client.readStatus(ref);
    const evidence = await client.readGitEvidence(ref, status);
    assert.ok(evidence.patch.includes('-复核前未提交产物'));
    assert.ok(evidence.patch.includes('+修正后的交付'));
  } finally { await f.close(); }
});

test('an unattended AGY correction receives its fixed database instruction through stdin and resumes the original conversation', async () => {
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agy-correction-cli-'));
  const cli = path.join(cliRoot, 'agy'); const sessionId = 'agy-original-conversation';
  const source = `const args=process.argv.slice(1);if(!args.includes('--print')||args[args.indexOf('--conversation')+1]!==${JSON.stringify(sessionId)})process.exit(9);const instruction=require('fs').readFileSync(0,'utf8');if(!instruction.includes('solomap_read')||!instruction.includes('"view":"full"')||!instruction.includes('data.prompt_content')||instruction.includes('cursor=null'))process.exit(8);require('fs').writeFileSync('correction.txt',instruction);process.stdout.write('原会话已完整修正');`;
  fs.writeFileSync(cli, `#!/bin/bash\nexec ${shellQuote(process.execPath)} -e ${shellQuote(source)} -- "$@"\n`, { mode: 0o755 });
  const f = await executionFixture('placeholder', { agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: '', taskPermissionMode: 'auto', continuation: true, direct: false }, plannedNativeSessionId: sessionId, agentCli: cli, agentDatabaseConfigPath: path.join(cliRoot, 'mcp_config.json') }, '', 'agent_review_revision');
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString()); assert.ok(f.stdout().toString().includes('原会话已完整修正'));
    const state = await f.call('read_run_state'); assert.equal(state.status.status, 'In Progress');
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); fs.rmSync(cliRoot, { recursive: true, force: true }); }
});

test('a Flow paused after wrapper claim keeps its child gated and resumes the same accepted role', async () => {
  const { createFlowTrace, createFlowLoop } = require('../out/flowStore.js');
  const f = await executionFixture('unused fixture command');
  try {
    const flow = createFlowTrace(f.projectRoot, '暂停后仍要完成原目标'); flow.loops = [createFlowLoop(flow.goal, 1)];
    await f.call('write_flow_trace', { root: f.projectRoot, flow, expectedRevision: 0, idempotencyKey: 'gate-flow-create' });
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("require('fs').writeFileSync('gated-result.txt','原角色已交付')")}`;
    const run = await f.call('prepare_flow_role', { root: f.projectRoot, flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0, prompt: '原始角色全文', command, userMessage: flow.goal, status: 'Running', metadata: { launchIntentHash: 'gated-flow-launch' }, idempotencyKey: 'gate-flow-role' });
    const id = run.status.rootExecutionLogId;
    const hook = path.join(path.dirname(f.root), 'pause-before-gate.cjs');
    fs.writeFileSync(hook, `const api=require(${JSON.stringify(path.resolve(__dirname, '../out/autonomousRuntimeControl.js'))});const original=api.sendRuntimeDataRequest;let paused=false;api.sendRuntimeDataRequest=async function(root,request){if(!paused&&request.operation==='read_run_log_head'&&request.input.executionLogId===${id}){paused=true;const current=await original(root,{operation:'read_flow_trace',input:{root:${JSON.stringify(f.projectRoot)},flowId:${JSON.stringify(flow.flowId)}}});await original(root,{operation:'write_flow_trace',input:{root:${JSON.stringify(f.projectRoot)},flow:{...current.flow,status:'paused'},expectedRevision:current.revision,idempotencyKey:'pause-after-claim'}});process.stderr.write('paused-before-child\\n');}return original(root,request);};`);
    const agent = f.startAgent({ ...process.env, NODE_OPTIONS: `--require=${hook}` }, id);
    const deadline = Date.now() + 10000;
    let state;
    do {
      state = await f.call('read_run_state', { executionLogId: id });
      assert.ok(Date.now() < deadline, f.stderr().toString());
      if (!state.status.agentChildPid) await new Promise(resolve => setTimeout(resolve, 20));
    } while (!state.status.agentChildPid);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'gated-result.txt')), false, 'a paused goal must keep the actual CLI behind the child gate');
    assert.equal(agent.exitCode, null, f.stderr().toString());
    const paused = await f.call('read_flow_trace', { root: f.projectRoot, flowId: flow.flowId });
    await f.call('write_flow_trace', { root: f.projectRoot, flow: { ...paused.flow, status: 'running' }, expectedRevision: paused.revision, idempotencyKey: 'resume-after-claim' });
    const [code] = await once(agent, 'exit'); assert.equal(code, 0, f.stderr().toString());
    assert.equal(fs.readFileSync(path.join(f.projectRoot, 'gated-result.txt'), 'utf8'), '原角色已交付');
    const done = await f.call('read_run_state', { executionLogId: id }); assert.equal(done.runId, run.runId); assert.equal(done.taskId, run.taskId);
  } finally { await f.close(); }
});

test('a newer parent turn after wrapper claim prevents an old automatic correction from executing', async () => {
  const f = await executionFixture('unused fixture command', { interactiveSession: true });
  try {
    const parent = await f.call('read_run_checkpoint_state');
    await f.call('checkpoint_run', { generation: parent.generation, proof: parent.proof, expectedRevision: parent.revision, expectedTurnId: parent.turnId, action: 'complete', outcome: 'partial', summary: '原轮次已交付', idempotencyKey: 'gated-parent-complete' });
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("require('fs').writeFileSync('obsolete-correction.txt','错误重启了旧修正')")}`;
    const run = await f.call('prepare_run', { root: f.projectRoot, executionLogId: 2, parentExecutionLogId: 1, expectedParentTurnId: parent.turnId, nodeId: '__solo__', runKind: 'agent_review_revision', prompt: '修正旧轮次', command, userMessage: '原目标', idempotencyKey: 'gated-parent-revision' });
    const hook = path.join(path.dirname(f.root), 'newer-parent-before-gate.cjs');
    fs.writeFileSync(hook, `const api=require(${JSON.stringify(path.resolve(__dirname, '../out/autonomousRuntimeControl.js'))});const original=api.sendRuntimeDataRequest;let advanced=false;api.sendRuntimeDataRequest=async function(root,request){if(!advanced&&request.operation==='read_run_log_head'&&request.input.executionLogId===2){advanced=true;const identity={projectId:${JSON.stringify(run.projectId)},executionLogId:1};const current=await original(root,{operation:'read_run_checkpoint_state',input:identity});await original(root,{operation:'checkpoint_run',input:{...identity,generation:current.generation,proof:current.proof,expectedRevision:current.revision,expectedTurnId:current.turnId,action:'start',message:'新一轮用户要求',idempotencyKey:'advance-parent-after-claim'}});}return original(root,request);};`);
    const agent = f.startAgent({ ...process.env, NODE_OPTIONS: `--require=${hook}` }, 2);
    const [code] = await once(agent, 'exit'); assert.notEqual(code, 0, 'obsolete corrections must not execute');
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'obsolete-correction.txt')), false);
    const child = await f.call('read_run_state', { executionLogId: 2 }); assert.equal(child.status.status, 'Failed'); assert.equal(child.status.hostOutputPending, false);
    const current = await f.call('read_run_state'); assert.equal(current.status.status, 'Running'); assert.equal(current.status.userMessage, '新一轮用户要求');
  } finally { await f.close(); }
});

test('the shared runner ignores retired execution enhancement metadata', async () => {
  const f = await executionFixture('printf "feature=%s" "$SOLOMAP_RTK_OUTPUT_OPTIMIZER"', {
    enhancementEnvLines: ['export SOLOMAP_RTK_OUTPUT_OPTIMIZER=1'],
    enhancementPreflightLines: ['printf "full enhancement preflight🌿\\n"']
  });
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit'); assert.equal(code, 0, f.stderr().toString());
    assert.equal(f.stdout().toString(), 'feature=');
    const page = await f.call('read_run_log', { stream: 'preflight:enhancements:stdout' });
    assert.equal(page.totalBytes, 0);
    assert.equal(Buffer.from(page.bytes, 'base64').toString(), '');
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('a host stop closes the tracked runner and preserves accepted output without PID or status files', async () => {
  const command = `env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('accepted original output🌿');setInterval(()=>{},1000)")}`;
  const f = await executionFixture(command, { interactiveSession: true });
  try {
    const agent = f.startAgent(); const closed = once(agent, 'exit');
    let state; const deadline = Date.now() + 10000;
    for (;;) {
      state = await f.call('read_run_state');
      if (state.status.agentChildPid && (await f.call('read_run_log_head', { stream: 'stdout' })).totalBytes) break;
      assert.ok(Date.now() < deadline, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 20));
    }
    const intent = { generation: state.generation, expectedRevision: state.revision, expectedTurnId: state.turnId, reason: '用户停止', idempotencyKey: 'host-stop-original-run' };
    const stopped = await f.call('stop_run', intent); await closed;
    assert.equal(stopped.status.interactiveSessionClosed, true); assert.equal(stopped.status.status, 'Failed');
    assert.equal((await f.call('stop_run', intent)).turnId, state.turnId);
    const output = await f.call('read_run_log', { stream: 'stdout' });
    assert.match(Buffer.from(output.bytes, 'base64').toString(), /accepted original output🌿/);
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('the shared runner honors continuation stops without overwriting saved outcomes', async t => {
  for(const mode of ['running','child-first','saved','failed'])await t.test(mode,async()=>{
    const expected='完整已接受输出🌿\n'.repeat(10000);
    const command=`exec ${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('完整已接受输出🌿\\n'.repeat(10000));setInterval(()=>{},1000)")}`;
    const f=await executionFixture(command,{interactiveSession:true});
    try{
      let env=process.env;
      if(mode==='child-first'){
        const hook=path.join(path.dirname(f.root),'defer-wrapper-signal.cjs');
        // Deliver the real child signal first; the wrapper's original handler runs later.
        fs.writeFileSync(hook,"const original=process.on;process.on=function(event,listener){return original.call(this,event,event==='SIGTERM'?(...args)=>setTimeout(()=>listener(...args),700):listener);};");
        env={...process.env,NODE_OPTIONS:`--require=${hook}`};
      }
      const agent=f.startAgent(env),ended=once(agent,'exit');let state;const deadline=Date.now()+10000;
      for(;;){state=await f.call('read_run_checkpoint_state');if(state.status.agentChildPid&&f.stdout().toString().replace(/\r\n/g,'\n')===expected)break;assert.equal(agent.exitCode,null,f.stderr().toString());assert.ok(Date.now()<deadline,'shared runner must capture full output');await new Promise(resolve=>setTimeout(resolve,20));}
      if(mode==='saved'||mode==='failed'){
        state=await f.call('checkpoint_run',{generation:state.generation,proof:state.proof,expectedRevision:state.revision,expectedTurnId:state.turnId,action:'complete',outcome:mode==='saved'?'partial':'failed',summary:`saved-${mode}-result`,idempotencyKey:`saved-result:${mode}`});
      }
      const original=await f.call('read_run_state'),stop={generation:original.generation,expectedRevision:original.revision,expectedTurnId:original.turnId,reason:'正在原会话中继续处理。',requireVerifiedIdentity:true,outcome:'partial',idempotencyKey:`continuation-stop:${mode}`};
      const stopped=await f.call('stop_run',stop);const [code]=await ended;assert.equal(code,143);
      assert.equal(stopped.status.interactiveSessionClosed,true);assert.equal(stopped.turnId,original.turnId);assert.equal(stopped.taskId,original.taskId);
      assert.equal(stopped.status.checkpointOutcome,mode==='failed'?'failed':'partial');assert.equal(stopped.status.checkpointSummary,mode==='saved'||mode==='failed'?`saved-${mode}-result`:'正在原会话中继续处理。');
      const parts=[];let offset=0;
      do{const page=await f.call('read_run_log',{stream:'stdout',offset,limit:8192});parts.push(Buffer.from(page.bytes,'base64'));offset=page.nextOffset;}while(offset!==null);
      assert.equal(Buffer.concat(parts).toString().replace(/\r\n/g,'\n'),expected);
      if(mode==='running'||mode==='child-first')assert.doesNotMatch(f.stderr().toString(),/SoloMap 无法完成本轮执行/);
      assert.deepEqual(fs.readdirSync(path.join(f.projectRoot,'.solopreneur')),['project.json']);
    }finally{await f.close();}
  });
});

test('a nonzero child exit records failure after preserving both complete streams', async () => {
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('partial output');process.stderr.write('failure evidence');process.exitCode=7")}`);
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 7, f.stderr().toString());
    const state = await f.call('read_run_state');
    assert.equal(state.status.status, 'Failed'); assert.equal(state.status.checkpointOutcome, 'failed');
    const stdout = await f.call('read_run_log', { stream: 'stdout' });
    const stderr = await f.call('read_run_log', { stream: 'stderr' });
    assert.equal(Buffer.from(stdout.bytes, 'base64').toString(), 'partial output');
    assert.equal(Buffer.from(stderr.bytes, 'base64').toString(), 'failure evidence');
  } finally { await f.close(); }
});

test('an unattended step preserves the existing no-deliverable failure and records its workspace evidence in the database', async () => {
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('finished without changes')")}`, {}, '', 'step');
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 125, f.stderr().toString());
    const state = await f.call('read_run_state');
    assert.equal(state.status.status, 'Failed'); assert.equal(state.status.failureCode, 'no_deliverable_changes');
    assert.equal(state.status.workspaceChangeCount, 0);
    assert.match(f.stdout().toString(), /finished without changes/);
    const evidence = await f.call('read', { ref: state.status.workspaceChangesObjectId });
    assert.equal(Buffer.from(evidence.data.content.data, 'base64').toString(), '');
    assert.ok(evidence.relations.some(relation => relation.target === state.turnId));
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('an unattended step with a real deliverable keeps its success and complete changes evidence without files', async () => {
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote("require('fs').writeFileSync('user-deliverable.txt','complete user result')")}`, {}, '', 'step');
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    const state = await f.call('read_run_state');
    assert.equal(state.status.checkpointOutcome, 'partial'); assert.equal(state.status.workspaceChangeCount, 1);
    const evidence = await f.call('read', { ref: state.status.workspaceChangesObjectId });
    assert.equal(Buffer.from(evidence.data.content.data, 'base64').toString(), 'A user-deliverable.txt');
    assert.equal(fs.readFileSync(path.join(f.projectRoot, 'user-deliverable.txt'), 'utf8'), 'complete user result');
    assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('a generated CLI reads the complete fixed-version prompt through the ordinary MCP with quotes and Unicode in its paths', async () => {
  const f = await executionFixture('preparing');
  const cli = path.join(path.dirname(f.root), 'claude');
  const configPath = path.join(path.dirname(f.root), '.claude.json');
  const expected = '用户原文完整 🌿\n每一行都要保留\n'.repeat(10000);
  const source = `#!${process.execPath}
const fs=require('fs');
const {Client}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/client/index.js'))});
const {StdioClientTransport}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'))});
async function main(){
 const instruction=process.argv.slice(2).find(value=>value.startsWith('Read the complete SoloMap'));
 const match=instruction?.match(/solomap_read with (\\{.*?\\}),/);
 if(!match)throw Error('database prompt instruction missing');
 const parameters=JSON.parse(match[1]);
 if(parameters.view!=='full')throw Error('database prompt must use one full read');
 const configured=JSON.parse(fs.readFileSync(process.env.SOLOMAP_TEST_MCP_CONFIG,'utf8')).mcpServers.solomap_data;
 const client=new Client({name:'real-cli-prompt-reader',version:'1'});
 const transport=new StdioClientTransport({...configured,cwd:process.cwd(),stderr:'pipe'});
 try {await client.connect(transport);
  const response=await client.callTool({name:'solomap_read',arguments:parameters});
  if(response.isError)throw Error(response.content[0].text);
  const result=JSON.parse(response.content[0].text);if(typeof result?.data?.prompt_content!=='string')throw Error('complete prompt missing');
  await new Promise(resolve=>process.stdout.write(result.data.prompt_content,resolve));}
 finally {await client.close();await transport.close();}
}
main().catch(error=>{process.stderr.write(String(error));process.exitCode=1});`;
  fs.writeFileSync(cli, source, { mode: 0o700 });
  try {
    let state = await f.call('read_run_state');
    state = await f.call('patch_run_state', { generation: state.generation, expectedRevision: state.revision, patch: { agentDatabaseConfigPath: configPath, agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: 'test-model', taskPermissionMode: 'auto', continuation: false, direct: false } }, idempotencyKey: 'cli-plan' });
    await f.call('patch_run_inputs', { generation: state.generation, expectedRevision: state.revision, prompt: expected, command: 'database prompt launch', status: 'Running', idempotencyKey: 'ready-cli' });
    await sendRuntimeDataRequest(f.root, { operation: 'prepare_agent_database', input: { root: f.projectRoot, provider: 'claude', configPath, command: process.execPath } });
    const agent = f.startAgent({ ...process.env, SOLOMAP_TEST_MCP_CONFIG: configPath });
    assert.equal((await once(agent, 'exit'))[0], 0, f.stderr().toString());
    assert.equal(f.stdout().toString(), expected);
    assert.equal(fs.existsSync(path.join(f.root, 'tmp', 'run-inputs')), false);
    const stateAfter = await f.call('read_run_state'); assert.equal(stateAfter.status.checkpointOutcome, 'partial');
    const parts = []; let offset = 0;
    do { const page = await f.call('read_run_log', { stream: 'stdout', offset, limit: 8192 }); parts.push(Buffer.from(page.bytes,'base64')); offset = page.nextOffset; } while(offset!==null);
    assert.equal(Buffer.concat(parts).toString(), expected);
  } finally { await f.close(); }
});

test('the real shared runner preserves full capability evidence and never launches a CLI with no session-id support', async () => {
  const f = await executionFixture('preparing', { interactiveSession: true });
  const cli = path.join(path.dirname(f.root), 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nif(process.argv.includes('--help'))process.stdout.write('old help evidence without the flag');else process.stdout.write('must-not-launch');`, { mode: 0o700 });
  try {
    const before = await f.call('read_run_state');
    await f.call('patch_run_state', { generation: before.generation, expectedRevision: before.revision, patch: { agentDatabaseConfigPath: path.join(path.dirname(f.root), '.claude.json'), agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: 'test-model', taskPermissionMode: 'auto', continuation: false, direct: false } }, idempotencyKey: 'preflight-plan' });
    const agent = f.startAgent(); assert.equal((await once(agent, 'exit'))[0], 126, f.stderr().toString());
    assert.equal(f.stdout().length, 0);
    const state = await f.call('read_run_state'); assert.equal(state.status.status, 'Failed'); assert.equal(state.status.failureCode, 'identity_capability_missing');
    const evidence = await f.call('read_run_log', { stream: 'preflight:identity-help:stdout' });
    assert.equal(Buffer.from(evidence.bytes, 'base64').toString(), 'old help evidence without the flag');
  } finally { await f.close(); }
});

test('a Codex startup failure retries without the daemon while preserving the exact resume identity and all evidence', async () => {
  const f = await executionFixture('preparing', { interactiveSession: true, plannedNativeSessionId: 'confirmed-native-session-123', bindingNonce: 'original-binding-nonce' });
  const cli = path.join(path.dirname(f.root), 'codex');
  fs.writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write('attempt:'+JSON.stringify(process.argv.slice(2))+'\\n');if(!process.argv.includes('--no-daemon')){process.stderr.write('app server did not become ready\\n');process.exitCode=2;}else process.stdout.write('retry completed\\n');`, { mode: 0o700 });
  try {
    const before = await f.call('read_run_state');
    await f.call('patch_run_state', { generation: before.generation, expectedRevision: before.revision, patch: { agentDatabaseConfigPath: path.join(path.dirname(f.root), 'config.toml'), agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: 'test-model', taskPermissionMode: 'auto', continuation: true, direct: false } }, idempotencyKey: 'codex-launch' });
    const agent = f.startAgent(); agent.stdin.end(); assert.equal((await once(agent, 'exit'))[0], 0, f.stderr().toString());
    const attempts = f.stdout().toString().split(/\r?\n/).filter(line => line.startsWith('attempt:')).map(line => JSON.parse(line.slice(8)));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].slice(0, 3), ['--profile', 'solomap', 'resume']);
    assert.deepEqual(attempts[1].slice(0, 4), ['--no-daemon', '--profile', 'solomap', 'resume']);
    assert.ok(attempts.every(args => args.includes('confirmed-native-session-123')));
    assert.ok(attempts.every(args => args.at(-1).includes('original-binding-nonce')));
    const log = await f.call('read_run_log', { stream: 'stdout' }); const text = Buffer.from(log.bytes, 'base64').toString();
    assert.match(text, /app server did not become ready/); assert.match(text, /retry completed/);
    assert.equal((await f.call('read_run_state')).status.checkpointOutcome, 'partial');
  } finally { await f.close(); }
});

test('Runtime restart preserves a live orphan and its database prompt, then settles it after the consumer dies', async () => {
  const source = "process.stdout.write('child:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const f = await executionFixture(`exec env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`);
  let childPid;
  try {
    const agent = f.startAgent();
    while (!/child:(\d+)/.test(f.stdout().toString())) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    childPid = Number(/child:(\d+)/.exec(f.stdout().toString())[1]);
    const before = await f.call('read_run_execution_plan');
    const died = once(agent, 'exit'); agent.kill('SIGKILL'); await died;
    await f.stopRuntime(); await f.startRuntime();
    await f.call('recover_run_executions');
    assert.equal((await f.call('read_run_execution_plan')).prompt, before.prompt);
    process.kill(childPid, 'SIGTERM');
    while (true) {
      try { const stat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) break; }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await f.stopRuntime(); await f.startRuntime();
    await f.call('recover_run_executions');
    assert.equal(fs.existsSync(path.join(f.root, 'tmp', 'run-inputs')), false);
    const state = await f.call('read_run_state'); assert.equal(state.status.status, 'Failed'); assert.match(state.status.checkpointSummary, /中断/);
    const log = await f.call('read_run_log', { stream: 'stdout' }); assert.equal(Buffer.from(log.bytes, 'base64').toString(), f.stdout().toString());
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await f.close();
  }
});

test('an active child survives database owner restart and commits queued bytes to the same run', async () => {
  const source = "process.stdout.write('before restart\\n');process.stdin.once('data',()=>{process.stdout.write('after restart\\n');process.stdin.pause()})";
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`);
  try {
    const agent = f.startAgent();
    while (!f.stdout().includes(Buffer.from('before restart\n'))) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    await f.stopRuntime();
    const finished = once(agent, 'exit');
    agent.stdin.end('continue\n');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(agent.exitCode, null, 'the runner waits for the same owner instead of losing accepted bytes');
    await f.startRuntime();
    const [code] = await finished;
    assert.equal(code, 0, f.stderr().toString());
    const state = await f.call('read_run_state'); assert.equal(state.runId, f.prepared.runId);
    const log = await f.call('read_run_log', { stream: 'stdout' });
    assert.equal(Buffer.from(log.bytes, 'base64').toString(), 'before restart\nafter restart\n');
  } finally { await f.close(); }
});

test('the packaged interactive runner gives the Agent a real terminal and closes the durable session', async () => {
  const f = await executionFixture("if [ -t 0 ]; then printf 'stdin=tty '; fi; if [ -t 1 ]; then printf 'stdout=tty\\n'; fi", { interactiveSession: true });
  try {
    const agent = f.startAgent(); agent.stdin.end(); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    assert.match(f.stdout().toString(), /stdin=tty stdout=tty/);
    const state = await f.call('read_run_state'); assert.equal(state.status.interactiveSessionClosed, true);
    const log = await f.call('read_run_log', { stream: 'stdout' }); assert.deepEqual(Buffer.from(log.bytes, 'base64'), f.stdout());
  } finally { await f.close(); }
});

test('a replacement packaged runner appends to the committed stream rather than restarting its offsets', async () => {
  const f = await executionFixture("printf 'new bytes'", {}, 'old bytes');
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit');
    assert.equal(code, 0, f.stderr().toString());
    const log = await f.call('read_run_log', { stream: 'stdout' });
    assert.equal(Buffer.from(log.bytes, 'base64').toString(), 'old bytesnew bytes');
  } finally { await f.close(); }
});

test('a missing shell settles the owned run as failed and preserves the launch error', async () => {
  const f = await executionFixture('printf unreachable');
  try {
    const agent = f.startAgent({ ...process.env, PATH: '/solomap-test-missing-shell' }); const [code] = await once(agent, 'exit');
    assert.equal(code, 1);
    const state = await f.call('read_run_state');
    assert.equal(state.status.status, 'Failed');
    assert.match(state.status.checkpointSummary, /ENOENT/);
  } finally { await f.close(); }
});

test('an orphaned live Agent prevents another wrapper from claiming the execution', async () => {
  const source = "process.stdout.write('child:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const f = await executionFixture(`exec env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`);
  let childPid;
  try {
    const agent = f.startAgent();
    while (!/child:(\d+)/.test(f.stdout().toString())) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    childPid = Number(/child:(\d+)/.exec(f.stdout().toString())[1]);
    const owned = await f.call('read_run_state');
    assert.equal(owned.status.agentChildPid, childPid);
    const died = once(agent, 'exit'); agent.kill('SIGKILL'); await died;
    process.kill(childPid, 0);
    await assert.rejects(f.call('claim_run', { expectedRevision: owned.revision, idempotencyKey: 'orphan-takeover' }), /run_owner_alive/);
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await f.close();
  }
});

test('closing the display pipe keeps the accepted Agent running and preserves its subsequent output', async () => {
  const source = "process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write('after display closed\\n');process.stdin.pause()})";
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`);
  try {
    const agent = f.startAgent(); const finished = once(agent, 'exit');
    while (!f.stdout().includes(Buffer.from('ready\n'))) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    agent.stdout.destroy(); agent.stdin.end('continue\n');
    const [code] = await finished; assert.equal(code, 0, f.stderr().toString());
    const state = await f.call('read_run_state'); assert.equal(state.status.checkpointOutcome, 'partial');
    const log = await f.call('read_run_log', { stream: 'stdout' });
    assert.equal(Buffer.from(log.bytes, 'base64').toString(), 'ready\nafter display closed\n');
  } finally { await f.close(); }
});

test('closing a waiting interactive session preserves its settled turn instead of inventing a failed turn', async () => {
  const source = "process.stdout.write('waiting-session-ready\\n');setInterval(()=>{},1000)";
  const f = await executionFixture(`exec env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`, { interactiveSession: true });
  try {
    const agent = f.startAgent(); const finished = once(agent, 'exit');
    while (!f.stdout().includes(Buffer.from('waiting-session-ready'))) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    const state = await f.call('read_run_checkpoint_state');
    const settled = await f.call('checkpoint_run', { generation: state.generation, proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: 'partial', summary: '已交付本轮结果', idempotencyKey: 'first-turn-settled' });
    await f.call('patch_run_state', { generation: settled.generation, expectedRevision: settled.revision, patch: { status: 'Waiting' }, idempotencyKey: 'waiting' });
    agent.kill('SIGTERM'); assert.equal((await finished)[0], 143, f.stderr().toString());
    const closed = await f.call('read_run_state');
    assert.equal(closed.turnId, settled.turnId); assert.equal(closed.status.checkpointOutcome, 'partial');
    assert.equal(closed.status.checkpointSummary, '已交付本轮结果'); assert.equal(closed.status.interactiveSessionClosed, true);
  } finally { await f.close(); }
});

test('a completed command is not executed again when its launch is redelivered', async () => {
  const f = await executionFixture("printf 'executed'");
  try {
    const first = f.startAgent(); assert.equal((await once(first, 'exit'))[0], 0, f.stderr().toString());
    const before = await f.call('read_run_state');
    const second = f.startAgent(); assert.equal((await once(second, 'exit'))[0], 0, f.stderr().toString());
    const after = await f.call('read_run_state'); assert.equal(after.generation, before.generation);
    const log = await f.call('read_run_log', { stream: 'stdout' }); assert.equal(Buffer.from(log.bytes, 'base64').toString(), 'executed');
  } finally { await f.close(); }
});

test('a stop received while preparing log heads prevents the Agent command from starting', async () => {
  const f = await executionFixture("printf 'must-not-launch'");
  const hook = path.join(path.dirname(f.root), 'delay-materialization.cjs');
  fs.writeFileSync(hook, `const api=require(${JSON.stringify(path.resolve(__dirname, '../out/autonomousRuntimeControl.js'))});const original=api.sendRuntimeDataRequest;api.sendRuntimeDataRequest=async function(root,request){if(request.operation==='read_run_log_head'){process.stderr.write('preparing-log-heads\\n');await new Promise(resolve=>setTimeout(resolve,500));}return original(root,request);};`);
  try {
    const agent = f.startAgent({ ...process.env, NODE_OPTIONS: `--require=${hook}` }); const finished = once(agent, 'exit');
    while (!f.stderr().includes(Buffer.from('preparing-log-heads\n'))) { assert.equal(agent.exitCode, null, f.stderr().toString()); await new Promise(resolve => setTimeout(resolve, 10)); }
    agent.kill('SIGTERM');
    const [code] = await finished; assert.equal(code, 143, f.stderr().toString());
    assert.equal(f.stdout().length, 0);
    const state = await f.call('read_run_state'); assert.equal(state.status.status, 'Failed');
    const log = await f.call('read_run_log', { stream: 'stdout' }); assert.equal(log.totalBytes, 0);
  } finally { await f.close(); }
});

test('the shared runner accepts read-only Flow planning and verification results without requiring project edits', async () => {
  for (const role of ['planner', 'verifier']) {
    const result = role === 'planner' ? { goal: '原始目标', scope: ['交付'], successCriteria: ['检查'], plan: ['实施'], verificationPlan: ['验证'] } : { checks: [{ criterion: '目标', status: 'pass' }], H: { pass: true }, I: { pass: true }, J: { pass: true }, recommendedStatus: 'closed' };
    const output = `SOLOMAP_FLOW_JSON_START\n${JSON.stringify(result)}\nSOLOMAP_FLOW_JSON_END`;
    const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(`process.stdout.write(${JSON.stringify(output)})`)}`, { interactiveSession: false }, '', `flow_${role}`);
    try {
      const agent = f.startAgent(); const [code] = await once(agent, 'exit');
      assert.equal(code, 0, f.stderr().toString());
      const state = await f.call('read_run_state'); assert.equal(state.status.status, 'In Progress');
      assert.equal(state.status.checkpointOutcome, 'partial'); assert.equal(f.stdout().toString(), output);
      assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
    } finally { await f.close(); }
  }
});

test('host finalization preserves output and edits after an Agent checkpoint and records the actual exit code', async () => {
  const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
  for (const exitCode of [0, 7]) {
    const finalOutput = '完整最终角色结果🌿\n'.repeat(10000);
    const source = `process.stdout.write('checkpoint前\\n');const cp=require('child_process').spawnSync(process.execPath,[process.env.SOLOMAP_TASK_COMMAND,'complete','--outcome','partial','--summary','角色结果已准备'],{encoding:'utf8'});if(cp.status!==0)throw new Error(cp.stderr);require('fs').writeFileSync('actual-result.txt','checkpoint之后的实际结果');process.stdout.write('完整最终角色结果🌿\\n'.repeat(10000));process.exitCode=${exitCode};`;
    const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`, { interactiveSession: false }, '', 'flow_planner');
    try {
      const agent = f.startAgent(); const [code] = await once(agent, 'exit'); assert.equal(code, exitCode, f.stderr().toString());
      const client = new RunLifecycleClient((operation, input) => f.call(operation, input));
      const reference = runStatusReference(f.projectRoot, 1); const status = await client.readStatus(reference);
      assert.equal((await client.readData(runDataReference(reference, 'output'), status)).toString(), 'checkpoint前\n' + finalOutput);
      assert.equal(status.status, exitCode === 0 ? 'In Progress' : 'Failed'); assert.equal(status.exitCode, exitCode);
      assert.equal(await client.readField(reference, 'changes', status), 'A actual-result.txt');
      assert.equal((await f.call('list_run_states', { projectId: f.prepared.projectId, pendingConsumer: true })).items.length, 1);
      assert.deepEqual(fs.readdirSync(path.join(f.projectRoot, '.solopreneur')), ['project.json']);
    } finally { await f.close(); }
  }
});

test('an Agent checkpoint does not bypass the unattended step deliverable check at host finalization', async () => {
  const source = "const cp=require('child_process').spawnSync(process.execPath,[process.env.SOLOMAP_TASK_COMMAND,'complete','--outcome','partial','--summary','本轮回复已结束'],{encoding:'utf8'});if(cp.status!==0)throw new Error(cp.stderr);process.stdout.write('只有回复，没有项目交付');";
  const f = await executionFixture(`env -u NO_COLOR ${shellQuote(process.execPath)} -e ${shellQuote(source)}`, { interactiveSession: false }, '', 'step');
  try {
    const agent = f.startAgent(); const [code] = await once(agent, 'exit'); assert.equal(code, 125, f.stderr().toString());
    const state = await f.call('read_run_state'); assert.equal(state.status.failureCode, 'no_deliverable_changes');
    assert.equal(state.status.status, 'Failed'); assert.equal(state.status.checkpointOutcome, 'failed');
  } finally { await f.close(); }
});


test('Codex resume latency cannot start a correction after the parent entered a new turn', async () => {
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-late-resume-'));
  const codexHome = path.join(cliRoot, 'native-home');
  const cli = path.join(cliRoot, 'codex'); const sessionId = 'cc70ea64-51ec-41ef-842b-72f62bb8b7b3';
  const source = `const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:0,result:{}});if(m.method==='thread/resume'){fs.writeFileSync('resume-waiting','');const timer=setInterval(()=>{if(fs.existsSync('release-resume')){clearInterval(timer);send({id:1,result:{thread:{id:m.params.threadId}}});}},10);}if(m.method==='turn/start'){fs.writeFileSync('obsolete-correction.txt','started');send({id:2,result:{turn:{id:'native-late'}}});send({method:'turn/completed',params:{threadId:${JSON.stringify(sessionId)},turn:{id:'native-late',status:'completed'}}});}});`;
  fs.writeFileSync(cli, `#!/bin/bash\nexec ${shellQuote(process.execPath)} -e ${shellQuote(source)} -- "$@"\n`, { mode: 0o755 });
  const f = await executionFixture('unused main command', { interactiveSession: true });
  try {
    const parent = await f.call('read_run_checkpoint_state');
    await f.call('checkpoint_run', { generation: parent.generation, proof: parent.proof, expectedRevision: parent.revision, expectedTurnId: parent.turnId, action: 'complete', outcome: 'partial', summary: '原轮完成', idempotencyKey: 'late-parent-complete' });
    const run = await f.call('prepare_run', { root: f.projectRoot, executionLogId: 2, parentExecutionLogId: 1, expectedParentTurnId: parent.turnId, nodeId: '__solo__', runKind: 'agent_review_revision', prompt: '修正原轮', command: 'placeholder', userMessage: '原目标', metadata: { agentLaunch: { schemaVersion: 1, agentCli: cli, selectedModel: '', taskPermissionMode: 'auto', continuation: true, direct: false }, plannedNativeSessionId: sessionId, agentCli: cli, bindingNonce: '2'.repeat(64) }, idempotencyKey: 'late-resume-revision' });
    const seed = await f.call('write_run_binding', { executionLogId: 2, generation: run.generation, expectedHeadRevision: 0, seed: { runId: '2', provider: 'codex', workspaceRoot: f.projectRoot, cliPath: cli, bindingNonce: '2'.repeat(64), createdAt: run.status.startedAt, method: 'provider_callback', contract: 'official_stable', providerContext: { codex: { codexHome } } }, idempotencyKey: 'late-resume-binding' });
    await f.call('write_run_binding', { executionLogId: 2, generation: run.generation, expectedHeadRevision: seed.headRevision, revision: { sessionId, method: 'provider_callback', contract: 'official_stable', state: 'planned' }, idempotencyKey: 'late-resume-planned' });
    const agent = f.startAgent(process.env, 2); const exited = once(agent, 'exit');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(f.projectRoot, 'resume-waiting'))) { assert.equal(agent.exitCode, null, f.stderr().toString()); assert.ok(Date.now() < deadline, 'resume must reach the real protocol boundary'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const latest = await f.call('read_run_checkpoint_state');
    await f.call('checkpoint_run', { generation: latest.generation, proof: latest.proof, expectedRevision: latest.revision, expectedTurnId: latest.turnId, action: 'start', message: '用户新一轮目标', idempotencyKey: 'late-resume-parent-advanced' });
    fs.writeFileSync(path.join(f.projectRoot, 'release-resume'), '');
    const [code] = await exited;
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'obsolete-correction.txt')), false, 'the obsolete protocol turn must never execute');
    assert.notEqual(code, 0, f.stderr().toString());
    assert.equal((await f.call('read_run_state')).status.status, 'Running');
    assert.equal((await f.call('read_run_state', { executionLogId: 2 })).status.status, 'Failed');
  } finally { await f.close(); fs.rmSync(cliRoot, { recursive: true, force: true }); }
});
