const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const global = require('../out/solomapGlobal.js');

for (const kind of ['skill', 'mcp', 'enhancement']) test(`${kind} successful install receipt retries preserve later user choices and write no duplicate business data`, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `solomap-install-replay-${kind}-`));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const id = kind === 'enhancement' ? 'code-structure-assistant' : 'frontend-ui';
  const installed = path.join(root, kind === 'mcp' ? 'mcp/servers' : `${kind === 'skill' ? 'skills' : 'enhancements'}/installed`, id);
  const staging = path.join(root, 'tmp', 'first-install'); fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(installed, { recursive: true });
  const manifest = path.join(staging, 'manifest.json'), lock = path.join(staging, 'lock.json'), health = path.join(staging, 'health.json');
  const resultPath = path.join(staging, 'result.json');
  const manifestBytes = Buffer.from(JSON.stringify({ id, title: '完整安装🌿', version: '1.2.3', description: '全部描述🌿'.repeat(2000), activation: { keywords: ['UI'] } }));
  const lockBytes = Buffer.from('完整来源锁定🌿'.repeat(3000));
  fs.writeFileSync(manifest, manifestBytes); fs.writeFileSync(lock, lockBytes); fs.writeFileSync(health, JSON.stringify({ ok: true, version: '1.2.3' }));
  const result = { ok: true, installedPath: installed, sourceLockJson: lock };
  if (kind === 'skill') {
    result.skillId = id; result.packagePath = path.join(installed, 'package'); fs.mkdirSync(result.packagePath);
    result.entryFile = path.join(result.packagePath, 'SKILL.md'); fs.writeFileSync(result.entryFile, '# 完整技能🌿\n' + '完整正文'.repeat(2000)); result.solomapSkillJson = manifest;
  } else if (kind === 'mcp') {
    result.mcpId = id; result.solomapMcpJson = manifest; result.profilesPath = path.join(staging, 'profiles'); fs.mkdirSync(result.profilesPath);
    fs.writeFileSync(path.join(result.profilesPath, 'codex.json'), JSON.stringify({ full: '完整配置🌿'.repeat(2000) }));
  } else { result.enhancementId = id; result.solomapEnhancementJson = manifest; result.healthJson = health; }
  fs.writeFileSync(resultPath, JSON.stringify(result));
  const validate = () => global[{ skill: 'validateAndRegisterSkillInstall', mcp: 'validateAndRegisterMcpInstall', enhancement: 'validateAndRegisterEnhancementInstall' }[kind]](project, root, resultPath);
  let store, operations, server, observer, dropReply = true;
  const open = async () => {
    store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store);
    server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: `receipt-${kind}`, onCommand: () => ({ status: 'running' }), onData: async request => {
      const response = await operations(request);
      if (dropReply && request.operation === 'patch_capability_registry' && request.input.kind === kind && request.input.entry.id === id) { dropReply = false; throw new Error('fixture_reply_lost_after_commit'); }
      return response;
    } });
    observer = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
  };
  const close = async () => { observer.close(); await server.close(); await operations.close(); store.close(); };
  const counts = () => observer.prepare('SELECT (SELECT count(*) FROM objects) AS objects, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM contents) AS contents, (SELECT count(*) FROM relations) AS relations').get();
  const registration = () => store.readCapabilityRegistry({ kind }).entries.find(item => item.entry.id === id);
  await open();
  try {
    await assert.rejects(validate(), /fixture_reply_lost_after_commit/);
    const first = registration(), originalObject = store.read(first.objectId, first.revision), initialCounts = counts();
    assert.equal(first.revision, 1);
    assert.equal((await validate()).ok, true);
    assert.deepEqual(counts(), initialCounts, 'retry after committed reply loss must create no new revisions, evidence, events or receipts');
    assert.deepEqual(registration(), first);
    for (let i = 0; i < 20; i++) assert.equal((await validate()).ok, true);
    assert.deepEqual(counts(), initialCounts, 'unchanged repeated installation has zero cumulative business writes');
    const evidence = new Map(originalObject.relations.filter(item => item.relation === 'evidence').map(item => {
      const object = store.read(item.target); return [object.data.type, Buffer.from(object.data.content.data, 'base64')];
    }));
    assert.deepEqual(evidence.get('installation:result'), fs.readFileSync(resultPath));
    assert.deepEqual(evidence.get('installation:manifest'), manifestBytes);
    assert.deepEqual(evidence.get('installation:source_lock'), lockBytes);
    assert.equal(typeof first.entry.installedAt, 'string'); assert.equal(typeof first.entry.updatedAt, 'string');
    const disabled = await sendRuntimeDataRequest(root, { operation: 'patch_capability_registry', input: { kind, entry: { ...first.entry, status: 'disabled', enabled: false }, expectedRevision: 1, idempotencyKey: 'later-user-disable' } });
    const afterDisable = registration(), afterDisableCounts = counts(); assert.equal(disabled.revision, 2);
    assert.equal((await validate()).ok, true);
    assert.deepEqual(registration(), afterDisable, 'an old receipt must preserve a later disable'); assert.deepEqual(counts(), afterDisableCounts);
    const changed = await sendRuntimeDataRequest(root, { operation: 'patch_capability_registry', input: { kind, entry: { ...afterDisable.entry, status: 'uninstalled', enabled: false }, expectedRevision: 2, idempotencyKey: 'later-user-uninstall' } });
    const afterChoice = registration(), afterChoiceCounts = counts(); assert.equal(changed.revision, 3);
    await close(); await open();
    assert.equal((await validate()).ok, true);
    assert.deepEqual(registration(), afterChoice, 'an old successful receipt must not revive the newer uninstall after owner restart');
    assert.deepEqual(counts(), afterChoiceCounts);
    fs.writeFileSync(lock, Buffer.from('changed bytes for the same receipt'));
    await assert.rejects(validate(), /idempotency_conflict/);
    assert.deepEqual(registration(), afterChoice); assert.deepEqual(counts(), afterChoiceCounts);
    fs.writeFileSync(lock, lockBytes);
    const secondResult = path.join(root, 'tmp', 'second-install', 'result.json'); fs.mkdirSync(path.dirname(secondResult));
    if (kind === 'mcp') { result.profilesPath = path.join(path.dirname(secondResult), 'profiles'); fs.mkdirSync(result.profilesPath); fs.writeFileSync(path.join(result.profilesPath, 'codex.json'), evidence.get('installation:profile_636f6465782e6a736f6e')); }
    fs.writeFileSync(secondResult, JSON.stringify(result));
    const installNew = () => global[{ skill: 'validateAndRegisterSkillInstall', mcp: 'validateAndRegisterMcpInstall', enhancement: 'validateAndRegisterEnhancementInstall' }[kind]](project, root, secondResult);
    assert.ok((await Promise.all([installNew(), installNew()])).every(value => value.ok));
    assert.equal(registration().revision, 4, 'a genuinely new installation can reinstall, concurrent delivery commits exactly once');
    assert.equal(registration().entry.status, 'installed');
    assert.deepEqual(store.read(first.objectId, 1), originalObject, 'full first installation history and fixed evidence survive reinstall');
    assert.equal(fs.existsSync(path.join(root, kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcp' : 'enhancements', 'registry.json')), false);
    if (process.env.SOLOMAP_462_INSTALL_RECEIPT_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_INSTALL_RECEIPT_EVIDENCE}-${kind}.json`, JSON.stringify({ kind, root, first, originalObject, initialCounts, afterDisable, afterDisableCounts, afterChoice, afterChoiceCounts, reinstalled: registration(), finalCounts: counts(), evidence: Object.fromEntries([...evidence].map(([key, bytes]) => [key, bytes.toString('base64')])) }, null, 2));
  } finally { await close(); }
});
