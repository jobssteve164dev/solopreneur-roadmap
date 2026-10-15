const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

function prepareCodegraphFixture(base, version) {
  const prefix = path.join(base, 'npm-prefix'), npmRoot = path.join(prefix, 'lib', 'node_modules');
  const packagePath = path.join(npmRoot, '@colbymchenry', 'codegraph'), binTarget = path.join(packagePath, 'dist', 'cli.js');
  const commandPath = path.join(prefix, 'bin', 'codegraph');
  fs.mkdirSync(path.dirname(binTarget), { recursive: true }); fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version, bin: { codegraph: 'dist/cli.js' } }));
  fs.writeFileSync(binTarget, `#!/usr/bin/env node\nprocess.stdout.write("codegraph ${version}\\n")\n`, { mode: 0o755 });
  fs.symlinkSync(binTarget, commandPath);
  return (file, args, options, execute) => file === 'npm' && args?.join(' ') === 'root -g' ? npmRoot + '\n'
    : file === 'npm' && args?.join(' ') === 'prefix -g' ? prefix + '\n' : execute(file, args, options);
}

test('legacy capability registry keeps a valid external skill registration without treating its entry path as managed package bytes', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-external-'));
  const root = path.join(base, 'global'), external = path.join(base, 'external', 'SKILL.md');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true }); fs.mkdirSync(path.dirname(external));
  fs.writeFileSync(external, '# External skill\n完整技能正文');
  fs.writeFileSync(path.join(root, 'skills', 'registry.json'), JSON.stringify({ skills: [{
    id: 'external-skill', title: 'External skill', status: 'installed', entry: '../../external/SKILL.md', packagePath: '../../external'
  }] }));
  const store = new UnifiedDataStore(root);
  try {
    const result = await require('../out/capabilityDatabaseMigration.js').importCapabilityDirectory(store, root, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    const registered = store.readCapabilityRegistry({ kind: 'skill' }).entries[0];
    assert.equal(registered.entry.id, 'external-skill');
    assert.equal(store.read(registered.objectId).relations.some(relation => store.read(relation.target).data.type === 'installation:entry_document'), false);
    assert.equal(store.readMigrationSource(`capabilities:${root}`, 'skills/registry.json').stage, 'imported');
  } finally { store.close(); }
});

test('a terminal capability registry conflict is retained as exact evidence and becomes recyclable', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-archive-'));
  const root = path.join(base, 'global'), file = path.join(root, 'skills', 'registry.json');
  const bytes = Buffer.from(JSON.stringify({ skills: [{ id: '../invalid', title: 'retired' }] }));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  const store = new UnifiedDataStore(root);
  try {
    const result = await require('../out/capabilityDatabaseMigration.js').importCapabilityDirectory(store, root, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.archivedSources.length, 1);
    const evidence = store.read(result.archivedSources[0].evidenceRef.split('/').at(-1));
    assert.deepEqual(Buffer.from(evidence.data.content.data, 'base64'), bytes);
    const plan = await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare();
    assert.ok(plan.files.some(item => item.path === file));
  } finally { store.close(); }
});

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
    for (const kind of ['skills', 'mcp']) assert.equal(fs.existsSync(path.join(root, kind, 'registry.json')), false);
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
    assert.doesNotMatch(prompt, /solomap_migration_start/);
    assert.match(prompt, /完整学习总结🌿/); assert.match(prompt, /固定经验来源🌿/); assert.match(prompt, /真实执行经验🌿/);
    assert.doesNotMatch(prompt, /\[object Promise\]|memory\/profile\.md|memory\/projects\/|memory\/active\/current-session\.md/);
    assert.match(prompt, /solomap_read/);
    await assert.doesNotReject(global.buildSolomapStartupPackInstructions({ workspaceRoot: project, globalDataPath: root, contextText: 'Legacy caller' }));
  } finally { transport.sendRuntimeDataRequest = original; await operations.close(); store.close(); }
});

test('MCP installs keep full internal evidence alongside their formal status', async () => {
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
    const manifest = write('mcp-manifest.json', { id: 'github-readonly', title: 'GitHub Readonly', status: 'installed', server: { command: 'node', args: ['server.js'] }, activation: { keywords: ['GitHub'] }, permissions: { tools: ['issues.list'], writeAccess: false }, risk: { level: 'low' } });
    const lock = write('mcp-lock.json', { source: 'fixture/mcp', version: '2.3.4', integrity: '完整锁内容🌿'.repeat(10000) });
    const result = write('mcp-result.json', { ok: true, mcpId: 'github-readonly', installedPath: mcp, packagePath, solomapMcpJson: manifest, sourceLockJson: lock, profilesPath: profiles });
    assert.equal((await global.validateAndRegisterMcpInstall(project, root, result)).ok, true);
    for (const [kind, id, files] of [['mcp', 'github-readonly', { result, manifest, source_lock: lock }]]) {
      const registered = (await operations({ operation: 'read_capability_registry', input: { kind } })).entries.find(item => item.entry.id === id);
      const object = store.read(registered.objectId);
      const captured = new Map(object.relations.filter(relation => relation.relation === 'evidence').map(relation => {
        const evidence = store.read(relation.target); return [evidence.data.type, Buffer.from(evidence.data.content.data, 'base64')];
      }));
      for (const [purpose, file] of Object.entries(files)) assert.ok(captured.get(`installation:${purpose}`)?.equals(fs.readFileSync(file)), `complete ${kind} ${purpose} evidence must survive`);
    }
    assert.match(await global.buildSolomapMcpCandidateInstructions(project, root, 'Read GitHub Issue'), /GitHub Readonly/);
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
    assert.equal(overview.jobs.at(-1).status, 'completed', 'a terminal source/database difference is retained as evidence instead of blocking migration');
    assert.equal(store.readMigrationSource(`capabilities:${root}`, 'mcp/registry.json').stage, 'imported');
    assert.ok((await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare()).files.some(item => item.path === registryFile));
    await operations.close(); store.close(); store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store);
    assert.equal(store.readCapabilityRegistry({ kind: 'mcp' }).entries[0].entry.status, 'disabled');
    assert.equal(store.readCapabilityRegistry({ kind: 'enhancement' }).entries[0].entry.status, 'uninstalled');
  } finally { await operations.close(); store.close(); }
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
