const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const control = require('../out/autonomousRuntimeControl.js');

const previousTestSecretStore = process.env.SOLOMAP_TEST_SECRET_STORE;
const testSecretStore = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-telegram-secrets-'));
process.env.SOLOMAP_TEST_SECRET_STORE = testSecretStore;

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const info = fs.lstatSync(target);
      if (info.isDirectory() && !info.isSymbolicLink()) directories.push(target);
      else fs.unlinkSync(target);
    }
  }
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

test.after(() => {
  if (previousTestSecretStore === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE;
  else process.env.SOLOMAP_TEST_SECRET_STORE = previousTestSecretStore;
  cleanupExact(testSecretStore);
});

async function waitFor(check, message, timeout = 7000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function unlinkFixtureFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function removeFixtureDiagnostics(globalRoot) {
  const diagnosticsRoot = path.join(globalRoot, 'diagnostics');
  if (!fs.existsSync(diagnosticsRoot)) return;
  const dayNames = fs.readdirSync(diagnosticsRoot);
  assert.equal(dayNames.length, 1, 'fixture must create diagnostics for only one day');
  const dayRoot = path.join(diagnosticsRoot, dayNames[0]);
  const files = fs.readdirSync(dayRoot).sort();
  assert.ok(files.length <= 4, 'fixture must not leave unclassified diagnostic files');
  assert.ok(files.every(file => /^recent-(?:errors|operations)\.[^.]+\.json$/.test(file)), 'fixture diagnostics must use known names');
  if (files[0]) unlinkFixtureFile(path.join(dayRoot, files[0]));
  if (files[1]) unlinkFixtureFile(path.join(dayRoot, files[1]));
  if (files[2]) unlinkFixtureFile(path.join(dayRoot, files[2]));
  if (files[3]) unlinkFixtureFile(path.join(dayRoot, files[3]));
  fs.rmdirSync(dayRoot);
  fs.rmdirSync(diagnosticsRoot);
}

async function backgroundFixture(t, overrides = {}, intervalMs = 5000, runtimeVersion = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-tg-background-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const projectRoot = path.join(root, 'alpha');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Ship Alpha,,Build,,,,Pending,,\n');
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'Alpha', path: projectRoot }], hiddenProjects: [] }));
  const cli = path.join(root, 'codex');
  const modelInput = path.join(root, 'model-input');
  fs.writeFileSync(cli, '#!/usr/bin/env node\nconst fs=require("fs");let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{fs.appendFileSync('+JSON.stringify(modelInput)+',input+"\\n<<<END>>>\\n");console.log("Alpha 的下一步是 Ship Alpha。")});\n', { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeRoot, 'cognitive-config.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', mode: 'agent_cli', agentCli: cli, model: 'auto' }));
  const configPath = path.join(runtimeRoot, 'telegram-config.json');
  const config = { schemaVersion: 1, enabled: true, botToken: 'fixture-token', chatId: '123456', selectedProjectPath: projectRoot, language: 'zh', bindingGeneration: 0, conversationIds: {}, ...overrides };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const updates = [];
  const sent = [];
  const polls = [];
  const deliveryAttempts = [];
  let deliveryFailures = 0;
  let crashOnNextDelivery = false;
  let heldDeliveryText = '';
  let heldDeliveryRelease = null;
  let childStderr = '';
  const rejectedTexts = new Set();
  let child;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = JSON.parse(body);
      const method = req.url.split('/').at(-1);
      let result = true;
      if (method === 'getUpdates') {
        polls.push(payload);
        result = updates.filter(u => u.update_id >= (payload.offset || 0));
      } else if (method === 'sendMessage') {
        deliveryAttempts.push(payload);
        if (rejectedTexts.has(payload.text)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: invalid message content' }));
          return;
        }
        if (deliveryFailures > 0) {
          deliveryFailures--;
          res.statusCode = 502;
          res.end(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }));
          return;
        }
        if (heldDeliveryText === payload.text) {
          heldDeliveryText = '';
          heldDeliveryRelease = () => {
            if (res.destroyed) return;
            sent.push(payload);
            const heldResult = { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, result: heldResult }));
            heldDeliveryRelease = null;
          };
          return;
        }
        sent.push(payload);
        result = { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text };
        if (crashOnNextDelivery && child?.exitCode === null) {
          crashOnNextDelivery = false;
          child.kill('SIGKILL');
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const preload = path.join(root, 'telegram-boundary.cjs');
  fs.writeFileSync(preload, `const https=require('https'),http=require('http'),Module=require('module');
const load=Module._load;Module._load=function(name,...rest){if(name==='vscode')throw Error('Editor API must not be loaded by background chat');return load.call(this,name,...rest)};
const request=https.request;https.request=function(options,callback){if(options.hostname==='api.telegram.org')return http.request({...options,hostname:'127.0.0.1',port:${server.address().port},agent:undefined},callback);throw Error('Unexpected external request in TG acceptance test')};\n`);
  async function start() {
    if (child && child.exitCode === null && child.signalCode === null) return;
    unlinkFixtureFile(path.join(runtimeRoot, 'control.json'));
    child = cp.spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', globalRoot,
      '--interval-ms', String(intervalMs), ...(runtimeVersion ? ['--runtime-version', runtimeVersion] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.on('data', chunk => { childStderr += String(chunk); });
    await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'control.json')), 'Daemon must start its authenticated endpoint');
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    await control.sendRuntimeControlCommand(globalRoot, 'stop');
    await exited;
  }
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    heldDeliveryRelease?.();
    await new Promise(resolve => server.close(resolve));
    unlinkFixtureFile(path.join(runtimeRoot, 'control.json'));
    unlinkFixtureFile(path.join(runtimeRoot, 'cognitive-config.json'));
    unlinkFixtureFile(path.join(runtimeRoot, 'telegram-config.json'));
    unlinkFixtureFile(path.join(runtimeRoot, 'execution-runtime.json'));
    unlinkFixtureFile(path.join(runtimeRoot, 'owner.json'));
    unlinkFixtureFile(path.join(globalRoot, 'solomap.db-wal'));
    unlinkFixtureFile(path.join(globalRoot, 'solomap.db-shm'));
    unlinkFixtureFile(path.join(globalRoot, 'solomap.db'));
    unlinkFixtureFile(path.join(globalRoot, 'projects.json'));
    removeFixtureDiagnostics(globalRoot);
    unlinkFixtureFile(path.join(projectRoot, '.solopreneur', 'project.json'));
    unlinkFixtureFile(path.join(projectRoot, '.solopreneur', 'roadmap.csv'));
    unlinkFixtureFile(path.join(root, 'source-isolation', 'projects.json'));
    unlinkFixtureFile(path.join(root, 'model-started'));
    unlinkFixtureFile(path.join(root, 'slow-model-started'));
    unlinkFixtureFile(path.join(root, 'release-model'));
    unlinkFixtureFile(modelInput);
    unlinkFixtureFile(cli);
    unlinkFixtureFile(preload);
    const emptyRuntimeDirectories = ['autonomous-executions', 'cognitive-work', 'isolated-workspaces'];
    for (const name of emptyRuntimeDirectories) {
      const directory = path.join(runtimeRoot, name);
      if (!fs.existsSync(directory)) continue;
      assert.deepEqual(fs.readdirSync(directory), []);
      fs.rmdirSync(directory);
    }
    try { fs.rmdirSync(runtimeRoot); }
    catch (error) {
      if (error.code === 'ENOTEMPTY') error.message += `; remaining=${JSON.stringify(fs.readdirSync(runtimeRoot).sort())}`;
      throw error;
    }
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(path.join(projectRoot, '.solopreneur'));
    fs.rmdirSync(projectRoot);
    if (fs.existsSync(path.join(root, 'source-isolation'))) fs.rmdirSync(path.join(root, 'source-isolation'));
    fs.rmdirSync(root);
  });
  const update = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 123456, is_bot: false, first_name: 'Fixture' }, chat: { id: 123456, type: 'private' }, date: Math.floor(Date.now() / 1000), text } });
  return { root, globalRoot, runtimeRoot, projectRoot, cli, modelInput, configPath, config, updates, sent, polls, deliveryAttempts,
    rejectText(text) { rejectedTexts.add(text); }, failDeliveries(count) { deliveryFailures = count; },
    holdDelivery(text) { heldDeliveryText = text; }, releaseHeldDelivery() { heldDeliveryRelease?.(); },
    crashAfterNextDelivery() { crashOnNextDelivery = true; },
    childExited() { return Boolean(child && (child.exitCode !== null || child.signalCode !== null)); }, childStderr() { return childStderr; }, start, stop, update };
}

// Break caught: the real daemon never receives TG messages without a VS Code host.
test('standalone runtime receives, queries projects and replies without an editor, including after restart', async t => {
  const { globalRoot, runtimeRoot, configPath, modelInput, updates, sent, polls, childStderr, start, stop, update } = await backgroundFixture(t);
  await start();
  updates.push(update(100, '当前项目下一步是什么？'));
  try { await waitFor(() => sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'Background TG must deliver an answer with no editor process'); }
  catch (error) { error.message += `; stderr=${childStderr()}`; throw error; }
  const firstPrompt = fs.readFileSync(modelInput, 'utf8');
  const firstChatPrompt = firstPrompt.split('<<<END>>>').filter(value => value.trim()).at(-1);
  assert.match(firstChatPrompt, /SYSTEM:[\s\S]*本轮项目快照[^\n]*"selectedProject":"Alpha"/);
  assert.match(firstChatPrompt, /SYSTEM:[\s\S]*"currentSteps":\[\{"title":"Ship Alpha","status":"Pending"\}\]/);
  assert.doesNotMatch(firstChatPrompt, /USER:[^]*"selectedProject":"Alpha"/);
  assert.ok(polls.length > 0);
  const conversations = await control.sendRuntimeDataRequest(globalRoot, { operation: 'list_intelligence_conversations', input: {} });
  assert.equal(conversations.length, 1);
  assert.equal(fs.existsSync(path.join(globalRoot, 'intelligence-conversations')), false, 'new background history must not create JSON files');
  await control.sendRuntimeControlCommand(globalRoot, 'pause');
  updates.push(update(101, '/status'));
  await waitFor(() => sent.some(m => m.text.includes('Alpha') && m.text.includes('路线图')), 'Pausing autonomous decisions must leave TG available');
  await stop();
  const beforeRestart = sent.length;
  await start();
  updates.push(update(102, '继续刚才的问题'));
  await waitFor(() => sent.length > beforeRestart && sent.at(-1).text === 'Alpha 的下一步是 Ship Alpha。', 'Restart must resume TG conversation');
  assert.equal((await control.sendRuntimeDataRequest(globalRoot, { operation: 'list_intelligence_conversations', input: {} })).length, 1);
  const { conversation } = await control.sendRuntimeDataRequest(globalRoot, { operation: 'read_intelligence_conversation', input: { id: conversations[0].id } });
  assert.equal(conversation.messages.length, 4, 'Acknowledged messages must not be replayed after restart');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  await stop();
});

test('standalone smart kernel still calls Pi for a new project without roadmap.csv', async t => {
  const fixture = await backgroundFixture(t);
  unlinkFixtureFile(path.join(fixture.projectRoot, '.solopreneur', 'roadmap.csv'));
  await fixture.start();
  fixture.updates.push(fixture.update(103, '你好'));
  await waitFor(() => fixture.sent.some(message => message.text === 'Alpha 的下一步是 Ship Alpha。'), 'A project without roadmap.csv must still reach Pi');
  const prompt = fs.readFileSync(fixture.modelInput, 'utf8');
  const chatPrompt = prompt.split('<<<END>>>').filter(value => value.trim()).at(-1);
  assert.match(chatPrompt, /SYSTEM:[\s\S]*本轮项目快照[^\n]*"selectedProject":"Alpha"/);
  assert.match(chatPrompt, /SYSTEM:[\s\S]*"currentSteps":\[\]/);
  assert.doesNotMatch(chatPrompt, /USER:[^]*"selectedProject":"Alpha"/);
  await fixture.stop();
});

test('a compatible release with recorded old-host drain routes Telegram through the Runtime-owned native Harness', async t => {
  const fixture = await backgroundFixture(t, {}, 5000, '0.0.606');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { runtimeBuildId } = require('../out/runtimeBuildIdentity.js');
  const currentBuild = runtimeBuildId(path.resolve(__dirname, '..'));
  const seeded = new UnifiedDataStore(fixture.globalRoot);
  seeded.registerPiCompatibilityRelease('0.0.605', 'compatibility-release-605', 'runtime-605');
  seeded.recordPiCompatibilityDrain({ runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'compatibility-release-605',
    replacementVersion: '0.0.606', replacementBuildId: currentBuild });
  seeded.close();
  await fixture.start();
  fixture.updates.push(fixture.update(104, '原生执行测试'));
  try { await waitFor(() => fixture.sent.some(message => message.text === 'Alpha 的下一步是 Ship Alpha。'), 'Native Harness must deliver the Telegram answer', 12_000); }
  catch (error) {
    await fixture.stop();
    const failed = UnifiedDataStore.open(fixture.globalRoot);
    try {
      error.message += `; stderr=${fixture.childStderr()}; sent=${JSON.stringify(fixture.sent)}; operations=${JSON.stringify(failed.rows('SELECT operation_id,status FROM pi_conversation_operations'))}; diagnostics=${JSON.stringify(failed.rows('SELECT kind,payload_json FROM diagnostic_events ORDER BY sequence DESC LIMIT 10'))}`;
    } finally { failed.close(); }
    throw error;
  }
  await fixture.stop();
  const verified = UnifiedDataStore.open(fixture.globalRoot);
  try {
    assert.equal(verified.rows("SELECT COUNT(*) AS count FROM pi_conversation_operations WHERE status='settled'")[0].count, 1);
    assert.equal(verified.rows('SELECT COUNT(*) AS count FROM pi_legacy_conversation_operations')[0].count, 0);
  } finally { verified.close(); }
});

test('Runtime-owned native Harness lets Telegram recover from an MCP tool error before replying', async t => {
  const fixture = await backgroundFixture(t, {}, 5000, '0.0.606');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { runtimeBuildId } = require('../out/runtimeBuildIdentity.js');
  const currentBuild = runtimeBuildId(path.resolve(__dirname, '..'));
  const seeded = new UnifiedDataStore(fixture.globalRoot);
  seeded.registerPiCompatibilityRelease('0.0.605', 'compatibility-release-605', 'runtime-605');
  seeded.recordPiCompatibilityDrain({ runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'compatibility-release-605',
    replacementVersion: '0.0.606', replacementBuildId: currentBuild });
  seeded.close();
  const recoveredReply = '暂时读不到详细记录，但我可以继续帮你判断下一步。';
  fs.writeFileSync(fixture.cli, `#!/usr/bin/env node
const fs=require('fs'),counter=${JSON.stringify(fixture.modelInput)};let input='';process.stdin.on('data',bytes=>input+=bytes);process.stdin.on('end',()=>{
  if(!input.includes('你是 SoloMap 的智能内核')){console.log('background cycle');return;}
  const attempts=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(attempts+1));
  console.log(input.includes('"isError":true')?${JSON.stringify(recoveredReply)}:attempts>=2?'工具错误未进入恢复上下文':JSON.stringify({toolCall:{name:'set_time_schedule',arguments:{title:'过期安排',scheduleKind:'once',scheduledAt:'2020-01-01T00:00:00Z',assignee:'user'}}}));
});
`, { mode: 0o700 });

  await fixture.start();
  fixture.updates.push(fixture.update(105, '工具失败时也要继续回答'));
  try { await waitFor(() => fixture.sent.some(message => message.text === recoveredReply),
    'Native Harness must return the tool failure to the model before Telegram receives a reply', 12_000); }
  catch (error) {
    await fixture.stop();
    const failed = UnifiedDataStore.open(fixture.globalRoot);
    try {
      error.message += `; stderr=${fixture.childStderr()}; sent=${JSON.stringify(fixture.sent)}; operations=${JSON.stringify(failed.rows('SELECT operation_id,status,terminal_content_id,settlement_content_id FROM pi_conversation_operations'))}; tools=${JSON.stringify(failed.rows('SELECT invocation_id,tool_name,status FROM pi_tool_invocations'))}; diagnostics=${JSON.stringify(failed.rows('SELECT kind,payload_json FROM diagnostic_events ORDER BY sequence DESC LIMIT 12'))}`;
    } finally { failed.close(); }
    throw error;
  }
  await fixture.stop();
  const verified = UnifiedDataStore.open(fixture.globalRoot);
  try {
    assert.equal(verified.rows("SELECT COUNT(*) AS count FROM pi_conversation_operations WHERE status='settled'")[0].count, 1);
    assert.equal(verified.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count, 1);
    assert.equal(verified.rows("SELECT COUNT(*) AS count FROM pi_tool_invocations WHERE status='admitted'")[0].count, 1,
      'a failed tool call stays incomplete rather than manufacturing a successful mutation');
    assert.equal(verified.readHostSettings({ namespace: 'extension', ownerScope: 'global' }).items.some(item => item.key === 'automationTasks'), false);
    assert.equal(verified.rows('SELECT COUNT(*) AS count FROM scheduled_occurrences')[0].count, 0,
      'recovery must not create the rejected schedule');
    const toolStages = verified.rows("SELECT payload_json FROM diagnostic_events WHERE kind='operation' AND scope='mcp.set_time_schedule' ORDER BY sequence")
      .map(row => JSON.parse(String(row.payload_json)).status);
    assert.deepEqual(toolStages, ['start', 'error'], 'the one underlying MCP call must be observed as one failed attempt');
    assert.equal(Number(fs.readFileSync(fixture.modelInput, 'utf8')), 2, 'one failed tool call requires exactly one model recovery turn');
    assert.equal(fixture.sent.some(message => String(message.text).includes('智能内核暂时无法回答')), false);
  } finally { verified.close(); }
});

test('a new data root takes over a live Telegram daemon when the old root has no editor host', async t => {
  const oldRoot = await backgroundFixture(t, {}, 1000);
  const newRoot = await backgroundFixture(t, {}, 1000);
  const { refreshTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  await oldRoot.start();
  await waitFor(() => oldRoot.polls.length > 0, 'Old root must initially own the Telegram poller');
  await newRoot.start();
  await waitFor(async () => !(await refreshTelegramRuntimeConfig(oldRoot.globalRoot)).enabled, 'A live old daemon without an editor host must receive the transfer request');
  await waitFor(() => newRoot.polls.length > 0, 'The new root must acquire the poller after the old root releases it');
  const oldPolls = oldRoot.polls.length;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(oldRoot.polls.length, oldPolls, 'The old root must stop polling after transfer');
  await newRoot.stop(); await oldRoot.stop();
});

test('a new data root waits for an accepted slow reply to be delivered before takeover', async t => {
  const oldRoot = await backgroundFixture(t, {}, 1000);
  const newRoot = await backgroundFixture(t, {}, 1000);
  const { refreshTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  const marker = path.join(oldRoot.root, 'slow-model-started');
  const released = path.join(oldRoot.root, 'release-model');
  fs.writeFileSync(oldRoot.cli, '#!/usr/bin/env node\nconst fs=require("fs");process.stdin.resume();process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(marker)+',"started");const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(released)+')){clearInterval(timer);console.log("接管前完成的慢回复")}},25)});\n', { mode: 0o700 });
  await oldRoot.start();
  await waitFor(() => oldRoot.polls.length > 0, 'Old root must initially own the Telegram poller');
  oldRoot.updates.push(oldRoot.update(151, '慢回复后再接管'));
  await waitFor(() => fs.existsSync(marker), 'Old root must accept the message before takeover starts');
  await newRoot.start();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(newRoot.polls.length, 0, 'New root must not poll while accepted work is still running');
  fs.writeFileSync(released, 'release');
  await waitFor(() => oldRoot.sent.filter(message => message.text === '接管前完成的慢回复').length === 1, 'Old owner must deliver its accepted reply before releasing the token lease');
  await waitFor(async () => !(await refreshTelegramRuntimeConfig(oldRoot.globalRoot)).enabled, 'Old root must disable only after its accepted reply is delivered');
  await waitFor(() => newRoot.polls.length > 0, 'New root must acquire the poller after the reply is settled');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(oldRoot.sent.filter(message => message.text === '接管前完成的慢回复').length, 1);
  assert.equal(newRoot.sent.filter(message => message.text === '接管前完成的慢回复').length, 0);
  assert.equal((await control.sendRuntimeDataRequest(oldRoot.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } })).items.length, 0);
  await newRoot.stop(); await oldRoot.stop();
});

test('a new data root waits for an in-flight Telegram send to settle before takeover', async t => {
  const oldRoot = await backgroundFixture(t, {}, 1000);
  const newRoot = await backgroundFixture(t, {}, 1000);
  const { queueTelegramBackgroundNotification, refreshTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  await oldRoot.start();
  await waitFor(() => oldRoot.polls.length > 0, 'Old root must initially own the Telegram poller');
  oldRoot.holdDelivery('接管前完成发送');
  await queueTelegramBackgroundNotification(oldRoot.globalRoot, '接管前完成发送', undefined, 'handoff-in-flight-send');
  await waitFor(() => oldRoot.deliveryAttempts.some(message => message.text === '接管前完成发送'), 'Old owner must start the Telegram send');
  await newRoot.start();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(newRoot.polls.length, 0, 'New root must wait while the old send is in flight');
  assert.equal((await refreshTelegramRuntimeConfig(oldRoot.globalRoot)).enabled, true, 'Old root must retain its channel until the send settles');
  oldRoot.releaseHeldDelivery();
  await waitFor(() => oldRoot.sent.filter(message => message.text === '接管前完成发送').length === 1, 'The old owner must finish the in-flight send');
  await waitFor(async () => !(await refreshTelegramRuntimeConfig(oldRoot.globalRoot)).enabled, 'Old root must disable after delivery settles');
  await waitFor(() => newRoot.polls.length > 0, 'New root must acquire the poller after delivery settles');
  assert.equal((await control.sendRuntimeDataRequest(oldRoot.globalRoot, { operation: 'read_notification', input: { intentId: 'handoff-in-flight-send' } })).state, 'delivered');
  await newRoot.stop(); await oldRoot.stop();
});

test('a superseded editor root sync cannot copy newer Telegram settings into the old root', async t => {
  const oldRoot = await backgroundFixture(t, { botToken: 'old-root-token', chatId: '111' }, 600000);
  const newRoot = await backgroundFixture(t, { botToken: 'new-root-token', chatId: '222' }, 600000);
  const { createTelegramBackgroundConnection } = require('../out/telegramBackgroundConnection.js');
  const { refreshTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  await oldRoot.start(); await newRoot.start();
  const before = await refreshTelegramRuntimeConfig(oldRoot.globalRoot);
  let releaseOldSettings;
  const oldSettingsRequested = new Promise(resolve => { releaseOldSettings = resolve; });
  let markOldSettingsRequested;
  const oldSettingsStarted = new Promise(resolve => { markOldSettingsRequested = resolve; });
  const connection = createTelegramBackgroundConnection({
    host: { getSettings: () => ({ telegramEnabled: false, telegramBotToken: '', telegramChatId: '' }), async authorizeChat() { return false; }, async bindChat() {}, async executeCommand() {} },
    async loadSettings(root) {
      if (root === oldRoot.globalRoot) {
        markOldSettingsRequested();
        await oldSettingsRequested;
        return { telegramEnabled: true, telegramBotToken: 'new-root-token', telegramChatId: '222' };
      }
      return { telegramEnabled: true, telegramBotToken: 'new-root-token', telegramChatId: '222' };
    },
    async bindChat() {}, async ensureRuntime() {}
  });
  t.after(() => connection.dispose());
  const stale = connection.sync(oldRoot.globalRoot, oldRoot.projectRoot, 'zh');
  await oldSettingsStarted;
  const current = connection.sync(newRoot.globalRoot, newRoot.projectRoot, 'zh');
  releaseOldSettings();
  await Promise.all([stale, current]);
  const after = await refreshTelegramRuntimeConfig(oldRoot.globalRoot);
  assert.deepEqual({ enabled: after.enabled, botToken: after.botToken, chatId: after.chatId, bindingGeneration: after.bindingGeneration, replyGeneration: after.replyGeneration, conversationIds: after.conversationIds, offset: after.offset },
    { enabled: before.enabled, botToken: before.botToken, chatId: before.chatId, bindingGeneration: before.bindingGeneration, replyGeneration: before.replyGeneration, conversationIds: before.conversationIds, offset: before.offset });
  const selected = await refreshTelegramRuntimeConfig(newRoot.globalRoot);
  assert.equal(selected.botToken, 'new-root-token'); assert.equal(selected.chatId, '222'); assert.equal(selected.enabled, true);
  await oldRoot.stop(); await newRoot.stop();
});

test('a waiting data root cannot send its independently queued notification before it owns the token lease', async t => {
  const owner = await backgroundFixture(t, {}, 1000);
  const waiting = await backgroundFixture(t, {}, 1000);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  const { countTelegramHostPresence, registerTelegramHostPresence, releaseTelegramHostPresence } = require('../out/telegramHostPresence.js');
  const { readProcessBirthMarker } = require('../out/processIdentity.js');
  const presence = { hostId: '11111111-2222-4333-8444-555555555555', pid: process.pid, birth: readProcessBirthMarker(process.pid), updatedAt: new Date().toISOString() };
  await registerTelegramHostPresence(owner.globalRoot, presence);
  try {
    assert.equal(countTelegramHostPresence(owner.globalRoot), 1);
    await owner.start();
    await waitFor(() => owner.polls.length > 0, 'Owner root must hold the Telegram token lease');
    await waiting.start();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(countTelegramHostPresence(owner.globalRoot), 1);
    assert.equal(waiting.polls.length, 0, 'Waiting root must not poll while the token lease is owned');
    const intent = 'cross-root-owner-only';
    await queueTelegramBackgroundNotification(owner.globalRoot, '跨根只发送一次', undefined, intent);
    await queueTelegramBackgroundNotification(waiting.globalRoot, '跨根只发送一次', undefined, intent);
    try { await waitFor(() => owner.sent.filter(message => message.text === '跨根只发送一次').length === 1, 'Lease owner must deliver its notification'); }
    catch (error) {
      const ownerPending = await control.sendRuntimeDataRequest(owner.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } });
      const waitingPending = await control.sendRuntimeDataRequest(waiting.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } });
      error.message += `; ownerAttempts=${JSON.stringify(owner.deliveryAttempts)}; waitingAttempts=${JSON.stringify(waiting.deliveryAttempts)}; ownerPending=${JSON.stringify(ownerPending)}; waitingPending=${JSON.stringify(waitingPending)}; ownerStderr=${owner.childStderr()}; waitingStderr=${waiting.childStderr()}`;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(waiting.deliveryAttempts.filter(message => message.text === '跨根只发送一次').length, 0, 'Waiting root must not attempt outbox delivery without the token lease');
  } finally {
    await releaseTelegramHostPresence(owner.globalRoot, presence.hostId);
    await waiting.stop(); await owner.stop();
  }
});

// Break caught: a transient send failure loses the completed answer or notifications still depend on the editor.
test('background delivery retries the completed answer and sends queued notifications without an editor', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  fixture.failDeliveries(1);
  await fixture.start();
  fixture.updates.push(fixture.update(300, '当前项目下一步是什么？'));
  await waitFor(() => fixture.sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'A temporary transport failure must not discard the answer');
  assert.equal(fixture.deliveryAttempts.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 2);
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  await queueTelegramBackgroundNotification(fixture.globalRoot, '任务完成');
  await waitFor(() => fixture.sent.some(m => m.text === '任务完成'), 'Queued task notifications must be sent by the daemon');
  await waitFor(async () => (await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } })).items.length === 0, 'Successfully sent deliveries must be acknowledged');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'telegram-outbox')), false);
  await fixture.stop();
});

// Break caught: reconnecting or closing the editor accidentally starts/stops TG polling.
test('editor binding, reconnect and disconnect preserve one background channel and reject revoked accounts', async t => {
  const fixture = await backgroundFixture(t, { chatId: '' });
  const { createTelegramBackgroundConnection } = require('../out/telegramBackgroundConnection.js');
  const { readTelegramRuntimeConfig, refreshTelegramRuntimeConfig, persistTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  let settings = { telegramEnabled: true, telegramBotToken: 'fixture-token', telegramChatId: '' };
  let staleHostReads = 0;
  const commands = [];
  let connection;
  const options = {
    host: {
      getSettings: () => { staleHostReads += 1; return { telegramEnabled: false, telegramBotToken: 'stale-token', telegramChatId: 'stale-chat' }; },
      async authorizeChat(_username, chatId) { assert.equal(chatId, '123456'); return true; },
      async bindChat() {},
      async executeCommand(command, ...args) { commands.push({ command, args }); return command === 'solopreneur.internalStopAgent'; }
    },
    loadSettings: async () => settings,
    async bindChat(chatId) { settings.telegramChatId = chatId; await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh'); },
    async ensureRuntime() { await fixture.start(); }
  };
  connection = createTelegramBackgroundConnection(options);
  t.after(() => connection.dispose());
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  assert.equal(staleHostReads, 0, 'editor synchronization must use the refreshed database projection instead of a stale host snapshot');
  fixture.updates.push(fixture.update(200, '绑定'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('绑定成功')), 'First message must still require and complete editor approval');
  assert.equal((await refreshTelegramRuntimeConfig(fixture.globalRoot)).chatId, '123456');
  fixture.updates.push(fixture.update(201, '/stop'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('成功终止')), 'Existing editor commands must reach their original handler');
  assert.deepEqual(commands, [{ command: 'solopreneur.internalStopAgent', args: [] }]);
  connection.dispose();
  connection = createTelegramBackgroundConnection(options);
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  connection.dispose();
  fixture.updates.push(fixture.update(202, '当前项目下一步是什么？'));
  await waitFor(() => fixture.sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'Closing editor after reconnect must leave background TG available');
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  await persistTelegramRuntimeConfig(fixture.globalRoot, { chatId: '', conversationIds: {} });
  await new Promise(resolve => setTimeout(resolve, 1100));
  fixture.updates.push(fixture.update(203, '解除绑定后不应回答'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('执行结果未能确认')), 'An unavailable approval path must not replay or silently acknowledge the authorization action');
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  await fixture.stop();
});

// Break caught: one permanently invalid message prevents every later delivery.
test('permanent delivery errors retain failed evidence and allow later messages through', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  fixture.rejectText('不可投递的内容');
  await fixture.start();
  await queueTelegramBackgroundNotification(fixture.globalRoot, '不可投递的内容', undefined, 'permanent-failure');
  await new Promise(resolve => setTimeout(resolve, 2));
  await queueTelegramBackgroundNotification(fixture.globalRoot, '后续正常消息');
  await waitFor(() => fixture.sent.some(m => m.text === '后续正常消息'), 'Permanent content failure must not block subsequent replies');
  const failed = await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'read_notification', input: { intentId: 'permanent-failure' } });
  assert.equal(failed.state, 'failed'); assert.equal(failed.payload.text, '不可投递的内容');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'telegram-failed')), false);
  await fixture.stop();
});

// Break caught: disable/re-enable between synchronization ticks admits a revoked pending reply.
test('quickly disabling and re-enabling invalidates pending replies while preserving chat identity', async t => {
  const fixture = await backgroundFixture(t);
  const { persistTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  await fixture.start();
  const previous = await new IntelligenceConversationStore(fixture.globalRoot, async () => '已有回复').send('已有消息');
  const marker = path.join(fixture.root, 'model-started');
  fs.writeFileSync(fixture.cli, '#!/usr/bin/env node\nconst fs=require("fs");let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(marker)+',"started");setTimeout(()=>console.log("迟到的回复"),500)});\n', { mode: 0o700 });
  await persistTelegramRuntimeConfig(fixture.globalRoot, { conversationIds: { '123456': previous.id } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  fixture.updates.push(fixture.update(400, '延迟回答'));
  await waitFor(() => fs.existsSync(marker), 'Model request must be pending before revocation');
  await persistTelegramRuntimeConfig(fixture.globalRoot, { enabled: false });
  await persistTelegramRuntimeConfig(fixture.globalRoot, { enabled: true });
  await waitFor(() => fixture.polls.some(p => p.offset === 401), 'Revoked input must settle');
  assert.equal(fixture.sent.filter(m => m.text === '迟到的回复').length, 0);
  fixture.updates.push(fixture.update(401, '新的消息'));
  await waitFor(() => fixture.sent.some(m => m.text === '迟到的回复'), 'New messages after re-enable must still receive replies');
  assert.equal(fixture.sent.filter(m => m.text === '迟到的回复').length, 1, 'Revoked and newly accepted requests must not both reply');
  const conversations = await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'list_intelligence_conversations', input: {} });
  assert.deepEqual(conversations.map(value => value.id), [previous.id], 'Enable changes must preserve established chat identity');
  await fixture.stop();
});

// Break caught: revocation also has to invalidate previously queued deliveries.
test('disabled channel invalidates queued replies and bad HTML is delivered as plain text', async t => {
  const fixture = await backgroundFixture(t, {}, 1000);
  const { queueTelegramBackgroundNotification, persistTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  await fixture.start();
  await queueTelegramBackgroundNotification(fixture.globalRoot, '撤销前排队的回复');
  await persistTelegramRuntimeConfig(fixture.globalRoot, { enabled: false });
  await persistTelegramRuntimeConfig(fixture.globalRoot, { enabled: true });
  fixture.rejectText('<b>任务完成</b>');
  const htmlDelivery = await queueTelegramBackgroundNotification(fixture.globalRoot, '<b>任务完成</b>', 'HTML');
  try { await waitFor(() => fixture.sent.some(m => m.text === '任务完成'), 'Invalid HTML must be retried as readable plain text'); }
  catch (error) { const pending = await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } }); const state = await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'read_notification', input: { intentId: htmlDelivery.intentId } }); error.message += `; attempts=${JSON.stringify(fixture.deliveryAttempts)}; pending=${JSON.stringify(pending)}; state=${JSON.stringify(state)}; stderr=${fixture.childStderr()}`; throw error; }
  assert.equal(fixture.sent.some(m => m.text === '撤销前排队的回复'), false);
  assert.equal(fixture.sent.find(m => m.text === '任务完成').parse_mode, undefined);
  await fixture.stop();
});

// Break caught: waiting for a model reply prevents receiving an urgent stop command.
test('a pending chat does not block stop commands and survives a background restart', async t => {
  const fixture = await backgroundFixture(t);
  const { createTelegramBackgroundConnection } = require('../out/telegramBackgroundConnection.js');
  const marker = path.join(fixture.root, 'slow-model-started');
  const released = path.join(fixture.root, 'release-model');
  fs.writeFileSync(fixture.cli, '#!/usr/bin/env node\nconst fs=require("fs");process.stdin.resume();process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(marker)+',"started");const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(released)+')){clearInterval(timer);console.log("慢聊天完成")}},25)});\n', { mode: 0o700 });
  const commands = [];
  const connection = createTelegramBackgroundConnection({
    host: { getSettings: () => ({ telegramEnabled: true, telegramBotToken: 'fixture-token', telegramChatId: '123456' }),
      async authorizeChat() { return false; }, async bindChat() {},
      async executeCommand(command) { commands.push(command); return true; } },
    async bindChat() {}, async ensureRuntime() { await fixture.start(); }
  });
  t.after(() => connection.dispose());
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  fixture.updates.push(fixture.update(500, '慢聊天'));
  await waitFor(() => fs.existsSync(marker), 'Chat model must be pending');
  fixture.updates.push(fixture.update(501, '/stop'));
  await waitFor(() => commands.includes('solopreneur.internalStopAgent'), 'Urgent stop must reach editor before the chat completes');
  assert.equal(fixture.sent.some(m => m.text === '慢聊天完成'), false);
  await fixture.stop();
  connection.dispose();
  fs.writeFileSync(released, 'release');
  const beforeRestart = fixture.sent.length;
  await fixture.start();
  await waitFor(() => fixture.sent.slice(beforeRestart).some(m => m.text === '慢聊天完成'), 'Accepted pending chat must survive daemon restart');
  await waitFor(async () => {
    const current = await require('../out/telegramRuntimeConfig.js').refreshTelegramRuntimeConfig(fixture.globalRoot);
    return (await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'claim_inbox_messages', input: { channel: 'telegram', generation: current.replyGeneration, owner: { id: 'acceptance-check', pid: process.pid, birth: 'acceptance-check' }, limit: 100 } })).items.length === 0;
  }, 'Finished chat must leave no pending input');
  await fixture.stop();
});

// Break caught: a committed completion effect can replay after a daemon restart and create a second notification.
test('the actual daemon sends one formal notification across duplicate effects and a restart without outbox files', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  await fixture.start();
  const intentId = 'run-effect:actual-notification-once';
  const first = await queueTelegramBackgroundNotification(fixture.globalRoot, '原轮正式通知🌿', 'HTML', intentId);
  const duplicate = await queueTelegramBackgroundNotification(fixture.globalRoot, '原轮正式通知🌿', 'HTML', intentId);
  assert.equal(first.id, duplicate.id);
  await waitFor(() => fixture.sent.some(message => message.text === '原轮正式通知🌿'), 'The daemon must read and deliver the formal database outbox');
  await fixture.stop();
  await fixture.start();
  const replay = await queueTelegramBackgroundNotification(fixture.globalRoot, '原轮正式通知🌿', 'HTML', intentId);
  assert.equal(replay.id, first.id); assert.equal(replay.state, 'delivered');
  assert.equal(fixture.sent.filter(message => message.text === '原轮正式通知🌿').length, 1);
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'telegram-outbox')), false);
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'telegram-failed')), false);
  assert.equal((await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } })).items.length, 0);
  await fixture.stop();
});

test('a daemon crash after Telegram accepts a message never resends the unknown delivery after restart', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  await fixture.start();
  fixture.crashAfterNextDelivery();
  const queued = await queueTelegramBackgroundNotification(fixture.globalRoot, '确认窗口只发送一次', undefined, 'run-effect:confirmation-window');
  await waitFor(() => fixture.sent.filter(message => message.text === '确认窗口只发送一次').length === 1, 'Telegram must accept the first delivery before the daemon crash');
  await waitFor(() => (fixture.deliveryAttempts.filter(message => message.text === '确认窗口只发送一次').length === 1), 'Only one transport attempt may reach Telegram');
  await waitFor(() => fixture.childExited(), 'The daemon must exit inside the delivery confirmation window');
  await fixture.start();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(fixture.sent.filter(message => message.text === '确认窗口只发送一次').length, 1);
  assert.equal(fixture.deliveryAttempts.filter(message => message.text === '确认窗口只发送一次').length, 1);
  assert.equal((await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'read_notification', input: { intentId: 'run-effect:confirmation-window' } })).state, 'delivery_unknown');
  assert.equal((await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'list_notification_deliveries', input: { channel: 'telegram' } })).items.length, 0);
  assert.equal(queued.id.length > 0, true);
  await fixture.stop();
});

test('an inbox replay reuses the first committed reply after a crash before acknowledgement', async t => {
  const fixture = await backgroundFixture(t);
  await fixture.start();
  fixture.crashAfterNextDelivery();
  fixture.updates.push(fixture.update(452, '崩溃后不得改写答复'));
  await waitFor(() => fixture.sent.filter(message => message.text === 'Alpha 的下一步是 Ship Alpha。').length === 1, 'The first model answer must reach Telegram before the crash');
  await waitFor(() => fixture.childExited(), 'The daemon must crash before the inbox acknowledgement is guaranteed');
  fs.writeFileSync(fixture.cli, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log("第二次模型输出不应发送"));\n', { mode: 0o700 });
  await fixture.start();
  await waitFor(async () => {
    const current = await require('../out/telegramRuntimeConfig.js').refreshTelegramRuntimeConfig(fixture.globalRoot);
    const pending = await control.sendRuntimeDataRequest(fixture.globalRoot, { operation: 'claim_inbox_messages', input: { channel: 'telegram', generation: current.replyGeneration, owner: { id: 'replay-check', pid: process.pid, birth: 'replay-check' }, limit: 100 } });
    return pending.items.length === 0;
  }, 'The replayed inbox message must finish acknowledgement');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fixture.sent.filter(message => message.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  assert.equal(fixture.sent.some(message => message.text === '第二次模型输出不应发送'), false);
  assert.equal(fixture.sent.some(message => String(message.text).includes('智能内核暂时无法回答')), false);
  await fixture.stop();
});


test('background Telegram status and actual MCP chat consume a committed project rename after source isolation', async t => {
  const f = await backgroundFixture(t, {}, 600000);
  await f.start();
  const initial = await control.sendRuntimeDataRequest(f.globalRoot, { operation: 'initialize_project_registry', input: {} });
  const name = '数据库即时新名称';
  await control.sendRuntimeDataRequest(f.globalRoot, { operation: 'patch_project_registry', input: { expectedRevision: initial.revision, projectPatches: [{ path: f.projectRoot, fields: { name } }], idempotencyKey: 'telegram-rename-without-next-cycle' } });
  const isolation = path.join(f.root, 'source-isolation'); fs.mkdirSync(isolation);
  const original = fs.readFileSync(path.join(f.globalRoot, 'projects.json'));
  fs.renameSync(path.join(f.globalRoot, 'projects.json'), path.join(isolation, 'projects.json'));
  fs.writeFileSync(f.cli, `#!/usr/bin/env node
let input='';process.stdin.on('data', bytes => input += bytes);process.stdin.on('end', () => console.log(input.includes(${JSON.stringify(JSON.stringify({ name }).slice(1, -1))}) ? ${JSON.stringify(name + ' 的下一步是 Ship Alpha。')} : JSON.stringify({ toolCall: { name: 'get_current_project' } })));
`, { mode: 0o700 });
  f.updates.push(f.update(20001, '/status'));
  await waitFor(() => f.sent.some(message => message.text.includes(name) && message.text.includes('路线图')), 'status must read the database rename without waiting ten minutes for another decision cycle');
  f.updates.push(f.update(20002, '当前项目下一步是什么？'));
  await waitFor(() => f.sent.some(message => message.text === name + ' 的下一步是 Ship Alpha。'), 'the actual intelligence MCP tool must see the committed project metadata');
  const conversations = await control.sendRuntimeDataRequest(f.globalRoot, { operation: 'list_intelligence_conversations', input: {} });
  assert.equal(conversations.length, 1);
  assert.equal(fs.existsSync(path.join(f.globalRoot, 'projects.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(isolation, 'projects.json')), original);
  await f.stop();
});
