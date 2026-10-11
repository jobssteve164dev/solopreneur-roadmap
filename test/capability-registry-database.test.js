const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

// Original host regression 166: capability registration must survive the move
// from file registries without losing activation, permissions or install history.
test('capability registration survives concurrent windows, exact replay and owner restart', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-registry-'));
  const root = path.join(base, 'global');
  let store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  const call = (operation, input = {}) => operations({ operation, input });
  const entry = { id: 'frontend-ui', title: 'Frontend UI', status: 'installed',
    entry: 'installed/frontend-ui/package/SKILL.md', packagePath: 'installed/frontend-ui/package',
    activation: { keywords: ['UI'], useWhen: ['Build a user interface'], manualOnly: false },
    risk: { hasScripts: true, requiresUserApprovalToRunScripts: true },
    source: { repository: 'fixture/frontend-ui', version: '1.2.3' } };
  const input = { kind: 'skill', entry, expectedRevision: 0, idempotencyKey: 'capability-first-install',
    attachments: [{ purpose: 'source_lock', bytes: Buffer.from('完整锁文件🌿'.repeat(10000)).toString('base64'), mimeType: 'application/octet-stream' }] };
  try {
    const empty = await call('read_capability_registry', { kind: 'skill' });
    assert.equal(empty.kind, 'skill'); assert.equal(empty.sourceSequence, 0); assert.deepEqual(empty.entries, []); assert.equal(typeof empty.readEpoch, 'string');
    const [first, replay] = await Promise.all([call('patch_capability_registry', input), call('patch_capability_registry', input)]);
    assert.deepEqual(first, replay);
    const installed = await call('read_capability_registry', { kind: 'skill' });
    assert.equal(installed.entries.length, 1);
    assert.deepEqual(installed.entries[0].entry, entry);
    assert.equal(installed.entries[0].revision, 1);
    const original = store.read(installed.entries[0].objectId, 1);
    assert.equal(original.kind, 'integration');
    assert.equal(original.data.kind, 'skill');
    const attachment = original.relations.find(relation => relation.relation === 'evidence');
    assert.ok(attachment, 'full internal install evidence belongs to the formal integration');
    const evidence = store.read(attachment.target);
    assert.equal(evidence.data.type, 'installation:source_lock');
    assert.equal(Buffer.from(evidence.data.content.data, 'base64').toString(), '完整锁文件🌿'.repeat(10000));
    const saved = await call('patch_capability_registry', { kind: 'skill', entry: { ...entry, status: 'disabled' }, expectedRevision: 1, idempotencyKey: 'capability-disable' });
    await assert.rejects(call('patch_capability_registry', { ...input, entry: { ...entry, title: 'Stale window' }, idempotencyKey: 'capability-stale' }), /revision_conflict/);
    await assert.rejects(call('patch_capability_registry', { ...input, entry: { ...entry, title: 'Changed replay' } }), /idempotency_conflict/);
    await call('patch_capability_registry', { kind: 'skill', entry: { id: 'manual-installer', title: 'Manual installer', status: 'installed', activation: { manualOnly: true } }, expectedRevision: 0, idempotencyKey: 'capability-second-install' });
    await operations.close(); store.close();
    store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store);
    const reopened = await call('read_capability_registry', { kind: 'skill' });
    assert.equal(reopened.entries.length, 2);
    assert.equal(reopened.entries.find(item => item.entry.id === 'frontend-ui').entry.status, 'disabled');
    assert.equal(reopened.entries.find(item => item.entry.id === 'frontend-ui').revision, saved.revision);
    assert.deepEqual(JSON.parse(store.read(first.objectId, 1).data.config_content), entry);
    assert.deepEqual(await call('patch_capability_registry', input), first, 'late retries return the original receipt and never undo a newer status');
    const { DatabaseSync } = require('node:sqlite');
    const observer = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    const occupancy = () => observer.prepare('SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM contents) AS contents').get();
    const before = occupancy();
    for (let i = 0; i < 100; i++) assert.deepEqual(await call('read_capability_registry', { kind: 'skill', knownSequence: reopened.sourceSequence, knownEpoch: reopened.readEpoch }), { kind: 'skill', sourceSequence: reopened.sourceSequence, readEpoch: reopened.readEpoch, unchanged: true });
    assert.deepEqual(occupancy(), before, 'unchanged reads create no events, receipts or metadata writes');
    observer.close();
    assert.equal(fs.existsSync(path.join(root, 'skills', 'registry.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'mcp', 'registry.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'enhancements', 'registry.json')), false);
  } finally { await operations.close(); store.close(); }
});

test('capability kinds keep independent identities and failed attachments roll back the whole install', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-negative-'));
  const store = new UnifiedDataStore(path.join(base, 'global')), operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  try {
    const skill = await call('patch_capability_registry', { kind: 'skill', entry: { id: 'shared-id', title: 'Skill', status: 'installed' }, expectedRevision: 0, idempotencyKey: 'shared-skill' });
    const mcp = await call('patch_capability_registry', { kind: 'mcp', entry: { id: 'shared-id', title: 'MCP', status: 'installed', permissions: { tools: ['issues.list'], writeAccess: false }, risk: { requiresExplicitEnable: true } }, expectedRevision: 0, idempotencyKey: 'shared-mcp' });
    assert.notEqual(skill.objectId, mcp.objectId);
    await assert.rejects(call('patch_capability_registry', { kind: 'enhancement', entry: { id: 'invalid', status: 'installed' }, expectedRevision: 0, idempotencyKey: 'invalid-attachment', attachments: [{ purpose: 'health', bytes: 'not-base64!' }] }), /capability_attachment_invalid/);
    assert.deepEqual((await call('read_capability_registry', { kind: 'enhancement' })).entries, []);
    await assert.rejects(call('read_capability_registry', { kind: 'unknown' }), /capability_kind_invalid/);
    await assert.rejects(call('patch_capability_registry', { kind: 'skill', entry: { id: '../escape', status: 'installed' }, expectedRevision: 0, idempotencyKey: 'path-escape' }), /capability_identity_invalid/);
    fs.mkdirSync(path.join(base, 'project'));
    const session = await call('open_mcp_session', { projectId: (await store.registerProject({ root: path.join(base, 'project') })).projectId });
    await assert.rejects(operations({ operation: 'write', sessionToken: session.sessionToken, input: { action: 'patch', kind: 'integration', objectId: mcp.objectId, scope: null, expectedRevision: 1, idempotencyKey: 'agent-enables-mcp', data: { status: 'installed' } } }), /denied|authorization|scope/);
  } finally { await operations.close(); store.close(); }
});

test('production capability candidates read database registrations without writing registry mirrors', async () => {
  const global = require('../out/solomapGlobal.js');
  const transport = require('../out/autonomousRuntimeControl.js');
  const original = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-candidates-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = async (resolvedRoot, request) => {
    assert.equal(path.resolve(resolvedRoot), root, 'all production dependencies must remain inside this isolated owner');
    return operations(request);
  };
  try {
    await global.writeSolomapSkillRegistry(project, root, { version: 1, updatedAt: '', skills: [
      { id: 'frontend-ui', title: 'Frontend UI', status: 'installed', entry: 'installed/frontend-ui/package/SKILL.md', activation: { keywords: ['UI'] } },
      { id: 'manual-only', title: 'Manual only', status: 'installed', activation: { keywords: ['UI'], manualOnly: true } }
    ] });
    assert.equal((await operations({ operation: 'read_capability_registry', input: { kind: 'skill' } })).entries.some(item => item.entry.id === 'frontend-ui'), true);
    const skills = await global.buildSolomapSkillCandidateInstructions(project, root, 'Build UI');
    assert.match(skills, /Frontend UI/); assert.doesNotMatch(skills, /Manual only/);
    await global.writeSolomapMcpRegistry(project, root, { version: 1, updatedAt: '', connectors: [
      { id: 'github-readonly', title: 'GitHub Readonly', status: 'installed', activation: { keywords: ['GitHub'] }, permissions: { tools: ['issues.list'], writeAccess: false }, risk: { level: 'low' } },
      { id: 'email-sender', title: 'Email Sender', status: 'installed', activation: { keywords: ['GitHub'] }, risk: { level: 'high', requiresExplicitEnable: true } }
    ] });
    const mcp = await global.buildSolomapMcpCandidateInstructions(project, root, 'Read GitHub Issue');
    assert.match(mcp, /GitHub Readonly/); assert.match(mcp, /issues\.list/); assert.doesNotMatch(mcp, /Email Sender/);
    await global.writeSolomapEnhancementRegistry(project, root, { version: 1, updatedAt: '', enhancements: [
      { id: 'command-output-optimizer', title: 'Command Output Optimizer', status: 'installed', enabled: true, version: '1.2.3', health: { ok: true }, adapter: { type: 'command_rewrite' }, activation: { keywords: ['token'] }, risk: { level: 'low' } }
    ] });
    const enabled = await global.buildSolomapEnhancementCandidateInstructions(project, root, 'Reduce token', { 'command-output-optimizer': true });
    assert.match(enabled, /Command Output Optimizer/);
    assert.doesNotMatch(await global.buildSolomapEnhancementCandidateInstructions(project, root, 'Reduce token', {}), /Command Output Optimizer/);
    for (const kind of ['skills', 'mcp', 'enhancements']) assert.equal(fs.existsSync(path.join(root, kind, 'registry.json')), false);
    const before = (await operations({ operation: 'read_capability_registry', input: { kind: 'skill' } })).sourceSequence;
    for (let i = 0; i < 20; i++) await global.buildSolomapSkillCandidateInstructions(project, root, 'Build UI');
    assert.equal((await operations({ operation: 'read_capability_registry', input: { kind: 'skill' } })).sourceSequence, before);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'installed', 'solomap-global-execution-guide', 'solomap.skill.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'installed', 'solomap-global-execution-guide', 'source.lock.json')), false);
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('validated skill installations retain complete receipt and lock evidence in the database', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const original = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-install-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolvedRoot, request) => { assert.equal(resolvedRoot, root); return operations(request); };
  try {
    const installed = path.join(root, 'skills', 'installed', 'frontend-ui'), packagePath = path.join(installed, 'package');
    fs.mkdirSync(packagePath, { recursive: true });
    const entryFile = path.join(packagePath, 'SKILL.md'); fs.writeFileSync(entryFile, '# Frontend UI\n完整技能正文🌿');
    const staging = path.join(root, 'tmp', 'skill-installs', 'fixture'); fs.mkdirSync(staging, { recursive: true });
    const manifest = path.join(staging, 'manifest.json'), lock = path.join(staging, 'source.lock.json'), result = path.join(staging, 'result.json');
    const manifestBytes = Buffer.from(JSON.stringify({ title: 'Frontend UI', description: '完整说明🌿'.repeat(2000), activation: { keywords: ['UI'] }, source: { version: '1.2.3' }, risk: { hasScripts: true } }));
    const lockBytes = Buffer.from(JSON.stringify({ version: '1.2.3', files: Array.from({ length: 3000 }, (_, i) => ({ name: `asset-${i}`, integrity: `exact-${i}` })) }));
    fs.writeFileSync(manifest, manifestBytes); fs.writeFileSync(lock, lockBytes);
    const receiptBytes = Buffer.from(JSON.stringify({ ok: true, skillId: 'frontend-ui', installedPath: installed, packagePath, entryFile, solomapSkillJson: manifest, sourceLockJson: lock })); fs.writeFileSync(result, receiptBytes);
    assert.equal((await global.validateAndRegisterSkillInstall(project, root, result)).ok, true);
    const registered = (await operations({ operation: 'read_capability_registry', input: { kind: 'skill' } })).entries.find(item => item.entry.id === 'frontend-ui');
    assert.ok(registered);
    const object = store.read(registered.objectId);
    const captured = new Map(object.relations.filter(relation => relation.relation === 'evidence').map(relation => {
      const evidence = store.read(relation.target); return [evidence.data.type, Buffer.from(evidence.data.content.data, 'base64')];
    }));
    assert.deepEqual(captured.get('installation:result'), receiptBytes);
    assert.deepEqual(captured.get('installation:manifest'), manifestBytes);
    assert.deepEqual(captured.get('installation:source_lock'), lockBytes);
    assert.deepEqual(captured.get('installation:entry_document'), fs.readFileSync(entryFile));
    assert.equal(fs.existsSync(path.join(installed, 'solomap.skill.json')), false);
    assert.equal(fs.existsSync(path.join(installed, 'source.lock.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'registry.json')), false);
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('enhancement uninstall returns its committed result and cannot be revived by a probe', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const original = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-uninstall-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolvedRoot, request) => { assert.equal(resolvedRoot, root); return operations(request); };
  try {
    await global.writeSolomapEnhancementRegistry(project, root, { version: 1, updatedAt: '', enhancements: [{ id: 'code-structure-assistant', title: 'Code Structure Assistant', status: 'installed', enabled: true, version: '1.2.3', health: { ok: true } }] });
    const result = path.join(base, 'uninstall-result.json'); fs.writeFileSync(result, JSON.stringify({ ok: true, enhancementId: 'code-structure-assistant', remainingItems: [], health: { ok: true, message: 'Removed' } }));
    assert.equal((await global.validateAndRegisterEnhancementUninstall(project, root, result)).ok, true);
    const current = (await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(item => item.id === 'code-structure-assistant');
    assert.equal(current.status, 'uninstalled'); assert.equal(current.enabled, false);
    assert.equal((await global.setSolomapEnhancementEnabled(project, root, 'code-structure-assistant', true)).ok, false);
    assert.equal((await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(item => item.id === 'code-structure-assistant').status, 'uninstalled');
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('startup instructions consume formal context and awaited promotion results', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const original = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-startup-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolvedRoot, request) => { assert.equal(resolvedRoot, root); return operations(request); };
  try {
    await store.registerProject({ root: project });
    const prompt = await global.buildSolomapStartupPackInstructions({ workspaceRoot: project, globalDataPath: root, runKind: 'step', contextText: 'Build UI', learningSummaryContext: '完整学习总结🌿', learningRetrievalContext: '固定经验来源🌿', executionExperienceContext: '真实执行经验🌿' });
    assert.match(prompt, /solomap_context/);
    assert.match(prompt, /完整学习总结🌿/); assert.match(prompt, /固定经验来源🌿/); assert.match(prompt, /真实执行经验🌿/);
    assert.doesNotMatch(prompt, /\[object Promise\]|memory\/profile\.md|memory\/projects\/|memory\/active\/current-session\.md/);
    assert.match(prompt, /solomap_read/);
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('enhancement probes preserve formal versions without recreating file authority', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const childProcess = require('node:child_process');
  const original = transport.sendRuntimeDataRequest, execute = childProcess.execFileSync;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-probe-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'), bin = path.join(base, 'bin');
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const executable = path.join(bin, 'codegraph'); fs.writeFileSync(executable, '#!/bin/bash\nprintf "ready\\n"\n', { mode: 0o755 });
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolvedRoot, request) => { assert.equal(resolvedRoot, root); return operations(request); };
  // Control only discovery of the external executable. The production probe's
  // command, interpreter, exit status, registry operation and state stay real.
  childProcess.execFileSync = (file, args, options) => {
    if (file === 'bash' && args?.[0] === '-lc' && args[1].includes('command -v codegraph')) return execute('/bin/bash', ['--noprofile', '--norc', '-c', args[1]], { ...options, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    return execute(file, args, options);
  };
  try {
    await global.writeSolomapEnhancementRegistry(project, root, { version: 1, updatedAt: '', enhancements: [{ id: 'code-structure-assistant', title: 'Code Structure Assistant', status: 'installed', enabled: true, version: '1.2.3', source: { commit: 'exact-source' }, health: { ok: true, version: '1.2.3', message: 'Installed' } }] });
    assert.equal((await global.checkAndRegisterEnhancement(project, root, 'code-structure-assistant')).ok, true);
    const installed = (await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(item => item.id === 'code-structure-assistant');
    assert.equal(installed.version, '1.2.3'); assert.equal(installed.enabled, true); assert.equal(installed.source.commit, 'exact-source');
    for (const file of ['registry.json', 'installed/code-structure-assistant/health.json', 'installed/code-structure-assistant/solomap.enhancement.json', 'installed/code-structure-assistant/source.lock.json']) assert.equal(fs.existsSync(path.join(root, 'enhancements', file)), false, file);
    assert.equal((await global.uninstallSolomapEnhancement(project, root, 'code-structure-assistant')).ok, true);
    assert.equal((await global.checkAndRegisterEnhancement(project, root, 'code-structure-assistant')).ok, false);
    const removed = (await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(item => item.id === 'code-structure-assistant');
    assert.equal(removed.status, 'uninstalled'); assert.equal(removed.enabled, false); assert.equal(removed.version, '1.2.3');
  } finally { childProcess.execFileSync = execute; transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('MCP and enhancement installs keep full internal evidence alongside their formal status', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const original = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-install-evidence-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolvedRoot, request) => { assert.equal(resolvedRoot, root); return operations(request); };
  try {
    const mcp = path.join(root, 'mcp', 'servers', 'github-readonly'), packagePath = path.join(mcp, 'package'), profiles = path.join(mcp, 'profiles');
    fs.mkdirSync(packagePath, { recursive: true }); fs.mkdirSync(profiles);
    fs.writeFileSync(path.join(packagePath, 'server.js'), 'console.log("fixture package");\n');
    const staging = path.join(root, 'tmp', 'installs', 'fixture'); fs.mkdirSync(staging, { recursive: true });
    const write = (name, value) => { const file = path.join(staging, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
    const manifest = write('mcp-manifest.json', { id: 'github-readonly', title: 'GitHub Readonly', status: 'installed', activation: { keywords: ['GitHub'] }, permissions: { tools: ['issues.list'], writeAccess: false }, risk: { level: 'low' } });
    const lock = write('mcp-lock.json', { source: 'fixture/mcp', version: '2.3.4', integrity: '完整锁内容🌿'.repeat(10000) });
    const result = write('mcp-result.json', { ok: true, mcpId: 'github-readonly', installedPath: mcp, packagePath, solomapMcpJson: manifest, sourceLockJson: lock, profilesPath: profiles });
    assert.equal((await global.validateAndRegisterMcpInstall(project, root, result)).ok, true);
    const enhancement = path.join(root, 'enhancements', 'installed', 'code-structure-assistant'); fs.mkdirSync(enhancement, { recursive: true });
    fs.writeFileSync(path.join(enhancement, 'adapter.js'), 'module.exports = { fixture: true };\n');
    const enhancementManifest = write('enhancement-manifest.json', { id: 'code-structure-assistant', title: 'Code Structure Assistant', version: '3.4.5', source: { version: '3.4.5' } });
    const enhancementLock = write('enhancement-lock.json', { source: 'fixture/codegraph', version: '3.4.5', integrity: '完整来源🌿'.repeat(10000) });
    const health = write('enhancement-health.json', { ok: true, version: '3.4.5', message: 'Controlled fixture verified' });
    const enhancementResult = write('enhancement-result.json', { ok: true, enhancementId: 'code-structure-assistant', installedPath: enhancement, solomapEnhancementJson: enhancementManifest, sourceLockJson: enhancementLock, healthJson: health });
    assert.equal((await global.validateAndRegisterEnhancementInstall(project, root, enhancementResult)).ok, true);
    for (const [kind, id, files] of [
      ['mcp', 'github-readonly', { result, manifest, source_lock: lock }],
      ['enhancement', 'code-structure-assistant', { result: enhancementResult, manifest: enhancementManifest, source_lock: enhancementLock, health }]
    ]) {
      const registered = (await operations({ operation: 'read_capability_registry', input: { kind } })).entries.find(item => item.entry.id === id);
      const object = store.read(registered.objectId);
      const captured = new Map(object.relations.filter(relation => relation.relation === 'evidence').map(relation => {
        const evidence = store.read(relation.target); return [evidence.data.type, Buffer.from(evidence.data.content.data, 'base64')];
      }));
      for (const [purpose, file] of Object.entries(files)) assert.ok(captured.get(`installation:${purpose}`)?.equals(fs.readFileSync(file)), `complete ${kind} ${purpose} evidence must survive`);
    }
    assert.match(await global.buildSolomapMcpCandidateInstructions(project, root, 'Read GitHub Issue'), /GitHub Readonly/);
    assert.equal((await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(item => item.id === 'code-structure-assistant').version, '3.4.5');
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('reordered unchanged capability metadata creates no writes through the production registry', async () => {
  const registry = require('../out/capabilityRegistry.js'), transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-unchanged-'));
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolved, request) => { assert.equal(resolved, root); return operations(request); };
  const entry = { id: 'unchanged', title: 'Existing choice', status: 'installed', activation: { keywords: ['UI'], manualOnly: false } };
  try {
    await registry.writeCapabilityEntries(root, 'skill', [entry]);
    const first = await registry.refreshCapabilityRegistry(root, 'skill');
    for (let i = 0; i < 20; i++) await registry.writeCapabilityEntries(root, 'skill', [{ activation: { manualOnly: false, keywords: ['UI'] }, status: 'installed', title: 'Existing choice', id: 'unchanged' }]);
    const after = await registry.refreshCapabilityRegistry(root, 'skill');
    assert.equal(after.sourceSequence, first.sourceSequence);
    assert.equal(after.entries[0].revision, first.entries[0].revision);
  } finally { transport.sendRuntimeDataRequest = previous; await operations.close(); store.close(); }
});

test('capability cache follows a replacement database and rejects a late former owner response', async () => {
  const registry = require('../out/capabilityRegistry.js'), transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-replacement-'));
  const root = path.join(base, 'root'), replacement = path.join(base, 'restored');
  const oldStore = new UnifiedDataStore(root), newStore = new UnifiedDataStore(replacement);
  const oldOps = createRuntimeDataOperations(oldStore), newOps = createRuntimeDataOperations(newStore);
  const write = (ops, title) => ops({ operation: 'patch_capability_registry', input: { kind: 'mcp', entry: { id: 'connector', title, status: 'installed' }, expectedRevision: 0, idempotencyKey: 'fixture-install' } });
  let active = oldOps, blocked, release;
  transport.sendRuntimeDataRequest = async (resolved, request) => {
    assert.equal(resolved, root);
    const result = await active(request);
    if (blocked) { blocked = false; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  try {
    await write(oldOps, 'Former database'); await write(newOps, 'Replacement database');
    await registry.refreshCapabilityRegistry(root, 'mcp');
    blocked = true;
    const late = registry.refreshCapabilityRegistry(root, 'mcp');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    active = newOps;
    assert.equal((await registry.refreshCapabilityRegistry(root, 'mcp')).entries[0].entry.title, 'Replacement database');
    release(); await late;
    assert.equal(registry.capabilitySnapshot(root, 'mcp').entries[0].entry.title, 'Replacement database');
  } finally { if (release) release(); transport.sendRuntimeDataRequest = previous; await oldOps.close(); await newOps.close(); oldStore.close(); newStore.close(); }
});

test('first initialization and learning completion use the database without memory or metric files', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-first-memory-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  let store, operations;
  transport.sendRuntimeDataRequest = (resolved, request) => {
    assert.equal(resolved, root);
    if (!store) { store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store); }
    return operations(request);
  };
  const node = { id: '2', title: 'Improve roadmap', stage: '反馈与规模化', description: 'Use feedback', agentPrompt: 'Review signals', status: 'In Progress' };
  const output = '完整学习来源🌿\n'.repeat(10000);
  try {
    global.ensureSolomapMemoryStore(project, root);
    assert.equal(fs.existsSync(path.join(root, 'memory')), false, 'first use must not generate a competing memory authority');
    assert.match(global.buildSoloMapSystemMemoryPrompt(project, root), /solomap_context/);
    assert.doesNotMatch(global.buildSoloMapSystemMemoryPrompt(project, root), /_example\.md|memory\/profile\.md|learning\/candidates/);
    await global.recordSolomapLearningCycle(project, root, node, 'Completed', 'M docs/learning-loop.md', 'M docs/learning-loop.md', output, 1234, '2026-05-31T00:00:00.000Z');
    const first = await operations({ operation: 'read_learning_overview', input: {} });
    assert.equal(first.eventCount, 1); assert.equal(first.candidateCount, 0);
    await global.recordSolomapLearningCycle(project, root, node, 'Completed', 'M docs/learning-loop.md', 'M docs/learning-loop.md', output, 1234, '2026-05-31T00:00:00.000Z');
    assert.equal((await operations({ operation: 'read_learning_overview', input: {} })).eventCount, 1);
    const projectId = (await store.registerProject({ root: project })).projectId;
    const events = store.search({ scope: projectId, kinds: ['learning_event'], query: '', limit: 20 }).items;
    const event = store.read(events[0].objectId), source = store.read(event.data.source_object_id);
    const payload = JSON.parse(source.data.content);
    assert.equal(payload.outputTail, output); assert.equal(payload.runDurationMs, 1234); assert.equal(payload.node.stage, '反馈与规模化');
    assert.match(await global.buildSolomapLearningContext(project, root), /统一学习账本事件：1/);
    for (const directory of ['memory', 'metrics', 'learning']) assert.equal(fs.existsSync(path.join(root, directory)), false, directory);
  } finally { transport.sendRuntimeDataRequest = previous; if (operations) await operations.close(); store?.close(); }
});

test('startup migration preserves historical capability choices, full metadata and native edits', async () => {
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-history-')), '.solomap-global');
  const entries = {
    skill: { id: 'solomap-cross-project-memory', title: 'User disabled builtin', status: 'disabled', activation: { manualOnly: true }, entry: 'installed/solomap-cross-project-memory/package/SKILL.md' },
    mcp: { id: 'existing-server', title: 'Existing server', status: 'installed', source: { commit: 'exact-commit' }, permissions: { tools: ['issues.list'], writeAccess: false } },
    enhancement: { id: 'code-structure-assistant', title: 'Existing enhancement', status: 'uninstalled', enabled: false, version: '1.2.3', health: { ok: true, version: '1.2.3' } }
  };
  const locations = { skill: ['skills', 'installed', 'skills'], mcp: ['mcp', 'servers', 'connectors'], enhancement: ['enhancements', 'installed', 'enhancements'] };
  const originals = new Map();
  for (const [kind, entry] of Object.entries(entries)) {
    const [directory, installed, field] = locations[kind], base = path.join(root, directory), packageRoot = path.join(base, installed, entry.id);
    fs.mkdirSync(packageRoot, { recursive: true });
    const files = {
      [path.join(base, 'registry.json')]: JSON.stringify({ version: 1, updatedAt: '', [field]: [entry] }),
      [path.join(packageRoot, `solomap.${kind}.json`)]: JSON.stringify(entry),
      [path.join(packageRoot, 'source.lock.json')]: JSON.stringify({ commit: 'exact-commit', body: '完整历史锁🌿'.repeat(10000) })
    };
    if (kind === 'skill') { fs.mkdirSync(path.join(packageRoot, 'package')); files[path.join(packageRoot, 'package', 'SKILL.md')] = '# User retained instruction\n完整文档🌿\n'; }
    if (kind === 'enhancement') files[path.join(packageRoot, 'health.json')] = JSON.stringify(entry.health);
    for (const [file, bytes] of Object.entries(files)) { fs.writeFileSync(file, bytes); originals.set(file, Buffer.from(bytes)); }
  }
  let store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  try {
    await enqueueAvailableDataMigrations(store, operations, () => true); await operations.waitForMigrations();
    for (const [kind, entry] of Object.entries(entries)) {
      const current = await operations({ operation: 'read_capability_registry', input: { kind } });
      assert.equal(current.entries.length, 1, `${kind} history must appear through the formal registry`);
      assert.deepEqual(current.entries[0].entry, entry);
    }
    for (const [file, bytes] of originals) {
      const source = store.readMigrationSource(`capabilities:${root}`, path.relative(root, file).split(path.sep).join('/'));
      assert.ok(source.bytes.equals(bytes), 'all historical metadata and instruction bytes are retained');
      assert.ok(fs.readFileSync(file).equals(bytes), 'migration preserves the physical historical source');
    }
    const connector = store.readCapabilityRegistry({ kind: 'mcp' }).entries[0];
    store.patchCapabilityRegistry({ kind: 'mcp', entry: { ...connector.entry, status: 'disabled' }, expectedRevision: connector.revision, idempotencyKey: 'user-disabled-after-import' });
    await enqueueAvailableDataMigrations(store, operations, () => true, true); await operations.waitForMigrations();
    assert.equal(store.readCapabilityRegistry({ kind: 'mcp' }).entries[0].entry.status, 'disabled', 'unchanged migration cannot undo a native user action');
    const registryFile = path.join(root, 'mcp', 'registry.json');
    fs.writeFileSync(registryFile, JSON.stringify({ version: 1, updatedAt: '', connectors: [{ ...entries.mcp, title: 'Changed historical source' }] }));
    await enqueueAvailableDataMigrations(store, operations, () => true, true); await operations.waitForMigrations();
    assert.equal(store.readCapabilityRegistry({ kind: 'mcp' }).entries[0].entry.status, 'disabled');
    assert.ok(store.pendingMigrationJobs().length === 0);
    const overview = await operations({ operation: 'migration_overview', input: {} });
    assert.ok(overview.jobs.some(job => job.status === 'completed_with_conflicts'), 'source/database conflict must remain visible');
    await operations.close(); store.close(); store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store);
    assert.equal(store.readCapabilityRegistry({ kind: 'mcp' }).entries[0].entry.status, 'disabled');
    assert.equal(store.readCapabilityRegistry({ kind: 'enhancement' }).entries[0].entry.status, 'uninstalled');
  } finally { await operations.close(); store.close(); }
});

test('a late enhancement toggle cannot revive another window uninstall', async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-enhancement-choice-race-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  let reads = 0, paused, resume;
  transport.sendRuntimeDataRequest = async (resolved, request) => {
    assert.equal(resolved, root);
    if (request.operation === 'read_capability_registry' && request.input.kind === 'enhancement' && ++reads === 2) {
      paused(); await new Promise(resolve => { resume = resolve; });
    }
    return operations(request);
  };
  try {
    await operations({ operation: 'patch_capability_registry', input: { kind: 'enhancement', entry: { id: 'code-structure-assistant', title: 'Existing enhancement', status: 'installed', enabled: false, version: '1.2.3', health: { ok: true, version: '1.2.3' } }, expectedRevision: 0, idempotencyKey: 'race-initial' } });
    const gate = new Promise(resolve => { paused = resolve; });
    const late = global.setSolomapEnhancementEnabled(project, root, 'code-structure-assistant', true);
    await gate;
    assert.equal((await global.uninstallSolomapEnhancement(project, root, 'code-structure-assistant')).ok, true);
    resume();
    await assert.rejects(late, /revision_conflict/);
    const final = (await global.readSolomapEnhancementRegistry(project, root)).enhancements.find(entry => entry.id === 'code-structure-assistant');
    assert.equal(final.status, 'uninstalled'); assert.equal(final.enabled, false);
  } finally { if (resume) resume(); transport.sendRuntimeDataRequest = previous; await operations.close(); store.close(); }
});

for (const kind of ['skill', 'mcp', 'enhancement']) test(`the generated ${kind} installer stages internal metadata and registers its complete result`, async () => {
  const global = require('../out/solomapGlobal.js'), transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `solomap-generated-${kind}-install-`));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const run = path.join(root, 'tmp', `${kind}-installs`, 'one-install'); fs.mkdirSync(run, { recursive: true });
  const resultPath = path.join(run, 'result.json');
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  transport.sendRuntimeDataRequest = (resolved, request) => { assert.equal(resolved, root); return operations(request); };
  try {
    const prompt = kind === 'skill' ? global.buildSkillInstallPrompt('fixture/package', project, root, resultPath)
      : kind === 'mcp' ? global.buildMcpInstallPrompt('fixture/server', project, root, resultPath)
      : global.buildEnhancementInstallPrompt('code-structure-assistant', project, root, resultPath);
    const match = prompt.match(/结果 JSON (?:schema|格式)：\n(\{[\s\S]*?\n\})/);
    assert.ok(match, 'the installer receives a complete executable result schema');
    const result = JSON.parse(match[1]);
    const manifestField = { skill: 'solomapSkillJson', mcp: 'solomapMcpJson', enhancement: 'solomapEnhancementJson' }[kind];
    for (const field of [manifestField, 'sourceLockJson', ...(kind === 'enhancement' ? ['healthJson'] : []), ...(kind === 'mcp' ? ['profilesPath'] : [])]) {
      assert.equal(path.dirname(path.resolve(path.dirname(root), result[field])), run, `${field} belongs to this temporary install`);
    }
    const id = result.skillId || result.mcpId || result.enhancementId;
    const manifest = { id, title: `Generated ${kind} package`, status: 'installed', version: '1.2.3', activation: { keywords: ['fixture'] }, source: { repository: 'fixture/repo', version: '1.2.3' }, risk: { requiresExplicitEnable: false } };
    result.metadata.version = '1.2.3';
    const lock = Buffer.from('完整安装来源与锁定版本🌿'.repeat(3000));
    const installer = path.join(run, 'controlled-installer.cjs');
    fs.writeFileSync(installer, `const fs = require('node:fs'), path = require('node:path');
      const result = ${JSON.stringify(result)}, manifest = ${JSON.stringify(manifest)};
      const resolve = value => path.resolve(${JSON.stringify(path.dirname(root))}, value);
      fs.mkdirSync(resolve(result.installedPath), { recursive: true });
      if (result.packagePath) fs.mkdirSync(resolve(result.packagePath), { recursive: true });
      if (result.entryFile) fs.writeFileSync(resolve(result.entryFile), '# Generated skill\\n');
      fs.writeFileSync(resolve(result[${JSON.stringify(manifestField)}]), JSON.stringify(manifest));
      fs.writeFileSync(resolve(result.sourceLockJson), Buffer.from(${JSON.stringify(lock.toString('base64'))}, 'base64'));
      if (result.healthJson) fs.writeFileSync(resolve(result.healthJson), JSON.stringify({ ok: true, version: '1.2.3' }));
      if (result.profilesPath) { fs.mkdirSync(resolve(result.profilesPath)); fs.writeFileSync(path.join(resolve(result.profilesPath), 'codex.json'), ${JSON.stringify(JSON.stringify({ full: '完整配置建议🌿'.repeat(3000) }))}); }
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));`);
    require('node:child_process').execFileSync(process.execPath, [installer], { cwd: run });
    const validated = kind === 'skill' ? await global.validateAndRegisterSkillInstall(project, root, resultPath)
      : kind === 'mcp' ? await global.validateAndRegisterMcpInstall(project, root, resultPath)
      : await global.validateAndRegisterEnhancementInstall(project, root, resultPath);
    assert.equal(validated.ok, true, validated.message);
    const registration = store.readCapabilityRegistry({ kind }).entries.find(item => item.entry.id === id);
    assert.ok(registration);
    const evidence = store.read(registration.objectId).relations.filter(item => item.relation === 'evidence').map(item => store.read(item.target));
    assert.ok(evidence.some(item => item.data.type === 'installation:source_lock' && Buffer.from(item.data.content.data, 'base64').equals(lock)));
    if (kind === 'mcp') assert.ok(evidence.some(item => JSON.stringify(item.data.type).includes('profile') && Buffer.from(item.data.content.data, 'base64').toString() === fs.readFileSync(path.join(result.profilesPath, 'codex.json'), 'utf8')), 'complete generated profile is database evidence');
    assert.equal(fs.existsSync(path.join(global.resolveSkillResultPath(root, result.installedPath), path.basename(result[manifestField]))), false);
    assert.equal(fs.existsSync(path.join(root, 'maintenance', 'runs')), false);
    assert.equal(fs.existsSync(path.join(root, { skill: 'skills', mcp: 'mcp', enhancement: 'enhancements' }[kind], 'registry.json')), false);
  } finally { transport.sendRuntimeDataRequest = previous; await operations.close(); store.close(); }
});

test('install evidence rejects a path switched to a symlink before reading outside bytes', () => {
  const { captureInstallationFiles } = require('../out/capabilityRegistry.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-install-evidence-race-'));
  const root = path.join(base, 'owned'), outside = path.join(base, 'outside-secret'); fs.mkdirSync(root);
  const file = path.join(root, 'receipt.json'), secret = Buffer.from('unrelated private bytes');
  fs.writeFileSync(outside, secret); fs.writeFileSync(file, Buffer.from([0, 255, 128, 1]));
  const lstat = fs.lstatSync, read = fs.readFileSync;
  let switched = false, outsideReads = 0;
  fs.lstatSync = function (candidate, ...args) {
    const result = lstat.call(fs, candidate, ...args);
    if (candidate === file && !switched) {
      switched = true; fs.renameSync(file, path.join(root, 'original-receipt.json')); fs.symlinkSync(outside, file);
    }
    return result;
  };
  fs.readFileSync = function (candidate, ...args) {
    const result = read.call(fs, candidate, ...args);
    if (Buffer.isBuffer(result) && result.equals(secret)) outsideReads++;
    return result;
  };
  try {
    assert.throws(() => captureInstallationFiles(root, { result: file }));
    assert.equal(switched, true);
    assert.equal(outsideReads, 0, 'rejection must occur before unrelated private content is read');
  } finally { fs.lstatSync = lstat; fs.readFileSync = read; }
  assert.ok(Buffer.from(captureInstallationFiles(root, { result: path.join(root, 'original-receipt.json') })[0].bytes, 'base64').equals(Buffer.from([0, 255, 128, 1])));
});
