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

for (const kind of ['skill', 'mcp']) test(`${kind} successful install receipt retries preserve later user choices and write no duplicate business data`, async t => {
  const childProcess = require('node:child_process'), execute = childProcess.execFileSync;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `solomap-install-replay-${kind}-`));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const id = kind === 'enhancement' ? 'code-structure-assistant' : 'frontend-ui';
  const installed = path.join(root, kind === 'mcp' ? 'mcp/servers' : `${kind === 'skill' ? 'skills' : 'enhancements'}/installed`, id);
  const staging = path.join(root, 'tmp', 'first-install'); fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(installed, { recursive: true });
  const manifest = path.join(staging, 'manifest.json'), lock = path.join(staging, 'lock.json'), health = path.join(staging, 'health.json');
  const resultPath = path.join(staging, 'result.json');
  const npmPrefix = path.join(base, 'npm-prefix'), npmRoot = path.join(npmPrefix, 'lib', 'node_modules');
  const codegraphPackage = path.join(npmRoot, '@colbymchenry', 'codegraph');
  const codegraphBin = path.join(codegraphPackage, 'dist', 'cli.js'), codegraphCommand = path.join(npmPrefix, 'bin', 'codegraph');
  if (kind === 'enhancement') {
    fs.mkdirSync(path.dirname(codegraphBin), { recursive: true }); fs.mkdirSync(path.dirname(codegraphCommand), { recursive: true });
    fs.writeFileSync(path.join(codegraphPackage, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version: '1.2.3', bin: { codegraph: 'dist/cli.js' } }));
    fs.writeFileSync(codegraphBin, '#!/usr/bin/env node\nprocess.stdout.write("codegraph 1.2.3\\n")\n', { mode: 0o755 });
    fs.symlinkSync(codegraphBin, codegraphCommand);
  }
  const manifestBytes = Buffer.from(JSON.stringify({ id, title: '完整安装🌿', version: '1.2.3', description: '全部描述🌿'.repeat(2000), activation: { keywords: ['UI'] }, server: { entry: 'server.js' } }));
  const lockBytes = Buffer.from(JSON.stringify({ source: 'fixture/source', integrity: '完整来源锁定🌿'.repeat(3000) }));
  fs.writeFileSync(manifest, manifestBytes); fs.writeFileSync(lock, lockBytes); fs.writeFileSync(health, JSON.stringify({ ok: true, version: '1.2.3' }));
  const result = { ok: true, installedPath: installed, sourceLockJson: lock };
  if (kind === 'skill') {
    result.skillId = id; result.packagePath = path.join(installed, 'package'); fs.mkdirSync(result.packagePath);
    result.entryFile = path.join(result.packagePath, 'SKILL.md'); fs.writeFileSync(result.entryFile, '# 完整技能🌿\n' + '完整正文'.repeat(2000)); result.solomapSkillJson = manifest;
  } else if (kind === 'mcp') {
    result.mcpId = id; result.packagePath = path.join(installed, 'package'); fs.mkdirSync(result.packagePath); fs.writeFileSync(path.join(result.packagePath, 'server.js'), 'process.stdout.write("ready")\n');
    result.solomapMcpJson = manifest; result.profilesPath = path.join(staging, 'profiles'); fs.mkdirSync(result.profilesPath);
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
  t.after(() => {
    const builtinSkillIds = ['solomap-cross-project-memory', 'solomap-global-execution-guide', 'solomap-project-docs-lifecycle', 'solomap-roadmap-planning'];
    const packageFiles = kind === 'skill' ? [path.join(installed, 'package', 'SKILL.md')]
      : kind === 'mcp' ? [path.join(installed, 'package', 'server.js')] : [];
    const files = [resultPath, manifest, lock, health, path.join(staging, 'profiles', 'codex.json'), path.join(root, 'tmp', 'second-install', 'result.json'), path.join(root, 'tmp', 'second-install', 'manifest.json'), path.join(root, 'tmp', 'second-install', 'lock.json'), path.join(root, 'tmp', 'second-install', 'health.json'), path.join(root, 'tmp', 'second-install', 'profiles', 'codex.json'), ...packageFiles, ...builtinSkillIds.map(skillId => path.join(root, 'skills', 'installed', skillId, 'package', 'SKILL.md')), codegraphCommand, codegraphBin, path.join(codegraphPackage, 'package.json'), path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')];
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    const dirs = [path.join(staging, 'profiles'), staging, path.join(root, 'tmp', 'second-install', 'profiles'), path.join(root, 'tmp', 'second-install'), path.join(installed, 'package'), installed, ...builtinSkillIds.flatMap(skillId => [path.join(root, 'skills', 'installed', skillId, 'package'), path.join(root, 'skills', 'installed', skillId)]), path.join(root, 'skills', 'installed'), path.join(root, 'skills'), path.join(root, 'mcp', 'servers'), path.join(root, 'mcp'), path.join(root, 'enhancements', 'installed'), path.join(root, 'enhancements'), path.join(root, 'tmp'), path.join(root, 'runtime'), path.dirname(codegraphBin), codegraphPackage, path.dirname(codegraphPackage), npmRoot, path.join(npmPrefix, 'lib'), path.join(npmPrefix, 'bin'), npmPrefix, root, project, base];
    for (const dir of dirs) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  await open();
  try {
    if (kind === 'enhancement') childProcess.execFileSync = (file, args, options) => file === 'npm' && args?.join(' ') === 'root -g' ? npmRoot + '\n'
      : file === 'npm' && args?.join(' ') === 'prefix -g' ? npmPrefix + '\n' : execute(file, args, options);
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
    assert.match((await validate()).message, /invalid|无效/);
    assert.deepEqual(registration(), afterChoice); assert.deepEqual(counts(), afterChoiceCounts);
    fs.writeFileSync(lock, lockBytes);
    const secondStage = path.join(root, 'tmp', 'second-install'), secondResult = path.join(secondStage, 'result.json'); fs.mkdirSync(secondStage);
    const secondManifest = path.join(secondStage, 'manifest.json'), secondLock = path.join(secondStage, 'lock.json');
    fs.copyFileSync(manifest, secondManifest); fs.copyFileSync(lock, secondLock); result.sourceLockJson = secondLock;
    result[{ skill: 'solomapSkillJson', mcp: 'solomapMcpJson', enhancement: 'solomapEnhancementJson' }[kind]] = secondManifest;
    if (kind === 'enhancement') { result.healthJson = path.join(secondStage, 'health.json'); fs.copyFileSync(health, result.healthJson); }
    if (kind === 'mcp') { result.profilesPath = path.join(secondStage, 'profiles'); fs.mkdirSync(result.profilesPath); fs.writeFileSync(path.join(result.profilesPath, 'codex.json'), evidence.get('installation:profile_636f6465782e6a736f6e')); }
    fs.writeFileSync(secondResult, JSON.stringify(result));
    const installNew = () => global[{ skill: 'validateAndRegisterSkillInstall', mcp: 'validateAndRegisterMcpInstall', enhancement: 'validateAndRegisterEnhancementInstall' }[kind]](project, root, secondResult);
    assert.ok((await Promise.all([installNew(), installNew()])).every(value => value.ok));
    assert.equal(registration().revision, 4, 'a genuinely new installation can reinstall, concurrent delivery commits exactly once');
    assert.equal(registration().entry.status, 'installed');
    assert.deepEqual(store.read(first.objectId, 1), originalObject, 'full first installation history and fixed evidence survive reinstall');
    assert.equal(fs.existsSync(path.join(root, kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcp' : 'enhancements', 'registry.json')), false);
    if (process.env.SOLOMAP_462_INSTALL_RECEIPT_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_INSTALL_RECEIPT_EVIDENCE}-${kind}.json`, JSON.stringify({ kind, root, first, originalObject, initialCounts, afterDisable, afterDisableCounts, afterChoice, afterChoiceCounts, reinstalled: registration(), finalCounts: counts(), evidence: Object.fromEntries([...evidence].map(([key, bytes]) => [key, bytes.toString('base64')])) }, null, 2));
  } finally { childProcess.execFileSync = execute; await close(); }
});
