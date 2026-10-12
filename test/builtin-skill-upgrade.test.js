const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations, runtimeMcpSource } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const { registerUnifiedMcpTools } = require('../out/unifiedMcp.js');
const global = require('../out/solomapGlobal.js');
const previous = require('./fixtures/solomap-builtin-skills-v0.json');
const memoryId = 'solomap-cross-project-memory';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-builtin-upgrade-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store), server, intercept;
  const open = async () => { server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'builtin-owner', onCommand: () => ({ status: 'running' }), onData: request => intercept ? intercept(request, operations) : operations(request) }); };
  await open();
  const call = (operation, input) => sendRuntimeDataRequest(root, { operation, input });
  const identity = await call('register_project', { root: project });
  return { base, root, project, identity, call, store: () => store, operations: () => operations, intercept: handler => { intercept = handler; },
    async reopen() { await server.close(); await operations.close(); store.close(); store = new UnifiedDataStore(root); operations = createRuntimeDataOperations(store); await open(); },
    async close() { await server.close(); await operations.close(); store.close(); } };
}

function historicalSkill(f, id = memoryId, suffix = '') {
  const old = previous.find(value => value.id === id);
  const entry = `installed/${id}/package/SKILL.md`, file = path.join(f.root, 'skills', entry);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, old.skillMd + suffix);
  return { file, bytes: fs.readFileSync(file), entry: { id, title: old.title, description: old.description, entry,
    packagePath: `installed/${id}/package`, status: 'disabled', defaultCandidate: old.defaultCandidate !== false,
    source: { type: 'builtin', owner: 'solomap' }, activation: { keywords: old.keywords, useWhen: old.useWhen, doNotUseWhen: old.doNotUseWhen },
    risk: { hasScripts: false, hasExecutables: false, usesNetwork: false, writesFiles: 'guidance-only', requiresUserApprovalToRunScripts: true }, installedAt: 'builtin', updatedAt: 'builtin' } };
}

test('the actual newly installed memory skill saves complete captured memory through the shared MCP without old memory files', async () => {
  const f = await fixture(); let source;
  try {
    const registry = await global.readSolomapSkillRegistry(f.project, f.root);
    const memory = registry.skills.find(value => value.id === memoryId);
    const document = fs.readFileSync(path.join(f.root, 'skills', memory.entry), 'utf8');
    const examples = [...document.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    const request = examples.find(value => value.action === 'create' && value.kind === 'memory');
    assert.ok(request, 'the installed skill must provide the actual native memory write protocol');
    assert.equal(request.data.status, 'captured');
    request.idempotencyKey = 'actual-builtin-memory-example'; request.data.title = '本项目完整事实';
    request.data.content = '完整核验事实🌿\n'.repeat(15000);
    source = runtimeMcpSource(f.root, f.identity.projectId);
    const handlers = new Map(); registerUnifiedMcpTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler), registerResource() {} }, source);
    const call = async (name, input) => { const result = await handlers.get(name)(input); assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
    const receipt = await call('solomap_write', request);
    assert.deepEqual(await call('solomap_write', request), receipt);
    const saved = await call('solomap_read', { ref: receipt.objectId, revision: receipt.revision, view: 'full' });
    assert.equal(saved.data.content, request.data.content); assert.equal(saved.projectId, f.identity.projectId); assert.equal(saved.data.status, 'captured');
    await source.close(); source = undefined; await f.reopen();
    const reopened = await f.call('read', { ref: receipt.objectId, revision: receipt.revision }); assert.equal(reopened.data.content, request.data.content);
    const candidates = await global.buildSolomapSkillCandidateInstructions(f.project, f.root, '保存本项目记忆');
    assert.ok(candidates.includes(path.join(f.root, 'skills', memory.entry)));
    for (const old of ['memory', 'learning', 'metrics']) assert.equal(fs.existsSync(path.join(f.root, old)), false);
    assert.equal(fs.existsSync(path.join(f.root, 'skills', 'registry.json')), false);
    if (process.env.SOLOMAP_462_BUILTIN_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_BUILTIN_EVIDENCE}-first.json`, JSON.stringify({ document, request, receipt, saved, reopened, memory, candidates }, null, 2));
  } finally { await source?.close(); await f.close(); }
});

test('canonical historical builtin upgrade preserves disabled choice, old bytes and full evidence across owner restart with zero unchanged writes', async () => {
  const f = await fixture(), old = historicalSkill(f);
  try {
    const original = await f.call('patch_capability_registry', { kind: 'skill', entry: old.entry, expectedRevision: 0, idempotencyKey: 'historical-builtin-registration' });
    const registry = await global.readSolomapSkillRegistry(f.project, f.root), upgraded = registry.skills.find(value => value.id === memoryId);
    assert.notEqual(upgraded.entry, old.entry.entry, 'upgrading a generated historical document must not overwrite the old physical file');
    assert.equal(upgraded.status, 'disabled'); assert.deepEqual(fs.readFileSync(old.file), old.bytes);
    const file = path.join(f.root, 'skills', upgraded.entry), document = fs.readFileSync(file);
    assert.equal(upgraded.source.builtinVersion, hash(document));
    const registration = f.store().readCapabilityRegistry({ kind: 'skill' }).entries.find(value => value.entry.id === memoryId);
    const evidence = f.store().read(registration.objectId).relations.filter(value => value.relation === 'evidence').map(value => f.store().read(value.target));
    assert.ok(evidence.some(value => Buffer.from(value.data.content.data, 'base64').equals(old.bytes)));
    assert.ok(evidence.some(value => Buffer.from(value.data.content.data, 'base64').equals(document)));
    assert.deepEqual(JSON.parse(f.store().read(original.objectId, 1).data.config_content), old.entry);
    assert.equal((await global.selectSolomapSkillCandidates(f.project, f.root, 'memory 记忆')).some(value => value.skill.id === memoryId), false);
    await f.reopen();
    assert.deepEqual((await global.readSolomapSkillRegistry(f.project, f.root)).skills.find(value => value.id === memoryId), upgraded);
    const observer = new DatabaseSync(path.join(f.root, 'solomap.db'), { readOnly: true });
    const counts = () => observer.prepare('SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM requests) AS requests,(SELECT count(*) FROM objects) AS objects,(SELECT count(*) FROM contents) AS contents').get();
    let repetition;
    try {
      const before = counts(), databaseBytesBefore = fs.statSync(path.join(f.root, 'solomap.db')).size;
      const db = f.store().db, prepare = db.prepare; let legacyJobQueries = 0;
      db.prepare = function(sql) { if (sql.includes('migration_jobs')) legacyJobQueries++; return prepare.call(this, sql); };
      const start = performance.now();
      try { for (let i = 0; i < 20; i++) await global.readSolomapSkillRegistry(f.project, f.root); }
      finally { db.prepare = prepare; }
      const after = counts(), databaseBytesAfter = fs.statSync(path.join(f.root, 'solomap.db')).size;
      assert.deepEqual(after, before); assert.equal(legacyJobQueries, 0); assert.equal(databaseBytesAfter, databaseBytesBefore);
      repetition = { count: 20, before, after, databaseBytesBefore, databaseBytesAfter, legacyJobQueries, elapsedMs: performance.now() - start };
    }
    finally { observer.close(); }
    if (process.env.SOLOMAP_462_BUILTIN_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_BUILTIN_EVIDENCE}-upgrade.json`, JSON.stringify({ original, oldEntry: old.entry, oldBytes: old.bytes.toString('base64'), upgraded, document: document.toString('base64'), registration, evidence, repetition }, null, 2));
  } finally { await f.close(); }
});

test('pending historical capability import cannot seed an enabled builtin over the old disabled choice', async () => {
  const f = await fixture(), old = historicalSkill(f), registryFile = path.join(f.root, 'skills', 'registry.json');
  const bytes = Buffer.from(JSON.stringify({ version: 1, skills: [old.entry] })); fs.writeFileSync(registryFile, bytes);
  try {
    const before = await global.readSolomapSkillRegistry(f.project, f.root);
    assert.equal(before.skills.some(value => value.id === memoryId), false, 'no generated default may precede the historical user choice');
    const job = await f.call('import_project_data', { collection: 'capabilities', sourceRoot: f.root, idempotencyKey: 'actual-historical-builtin-import' });
    await f.operations().waitForMigrations();
    const result = await f.call('migration_status', { jobId: job.jobId }); assert.equal(result.status, 'completed', JSON.stringify(result));
    const after = await global.readSolomapSkillRegistry(f.project, f.root), memory = after.skills.find(value => value.id === memoryId);
    assert.equal(memory.status, 'disabled'); assert.notEqual(memory.entry, old.entry.entry);
    assert.equal(after.skills.length, 4); assert.deepEqual(fs.readFileSync(registryFile), bytes); assert.deepEqual(fs.readFileSync(old.file), old.bytes);
    await f.reopen(); assert.equal((await global.readSolomapSkillRegistry(f.project, f.root)).skills.find(value => value.id === memoryId).status, 'disabled');
  } finally { await f.close(); }
});

test('a user-edited builtin document and its disabled registration remain unchanged during default provisioning', async () => {
  const f = await fixture(), old = historicalSkill(f, memoryId, '\n## 用户正式规则\n保留这份用户自定义说明。\n');
  try {
    await f.call('patch_capability_registry', { kind: 'skill', entry: old.entry, expectedRevision: 0, idempotencyKey: 'user-custom-builtin' });
    await global.readSolomapSkillRegistry(f.project, f.root);
    const actual = f.store().readCapabilityRegistry({ kind: 'skill' }).entries.find(value => value.entry.id === memoryId);
    assert.equal(actual.revision, 1); assert.deepEqual(actual.entry, old.entry); assert.deepEqual(fs.readFileSync(old.file), old.bytes);
  } finally { await f.close(); }
});

test('concurrent first provisioning records one complete builtin revision for both windows', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([global.readSolomapSkillRegistry(f.project, f.root), global.readSolomapSkillRegistry(f.project, f.root)]);
    assert.deepEqual(a, b); assert.equal(a.skills.length, 4);
    const registry = f.store().readCapabilityRegistry({ kind: 'skill' });
    for (const item of registry.entries) {
      assert.equal(item.revision, 1);
      const document = fs.readFileSync(path.join(f.root, 'skills', item.entry.entry));
      assert.equal(hash(document), item.entry.source.builtinVersion);
      const evidence = f.store().read(item.objectId).relations.filter(value => value.relation === 'evidence').map(value => f.store().read(value.target));
      assert.equal(evidence.length, 1); assert.ok(Buffer.from(evidence[0].data.content.data, 'base64').equals(document));
    }
    await f.reopen(); assert.deepEqual((await global.readSolomapSkillRegistry(f.project, f.root)).skills, a.skills);
  } finally { await f.close(); }
});

test('a concurrent uninstall wins over a paused builtin upgrade and remains uninstalled after owner restart', async () => {
  const f = await fixture(), old = historicalSkill(f); let release;
  try {
    await f.call('patch_capability_registry', { kind: 'skill', entry: old.entry, expectedRevision: 0, idempotencyKey: 'before-uninstall' });
    let arrived; const gate = new Promise(resolve => { arrived = resolve; });
    const hold = new Promise(resolve => { release = resolve; }); let paused = false;
    f.intercept(async (request, operations) => {
      if (!paused && request.operation === 'patch_capability_registry' && request.input.entry?.id === memoryId && request.input.idempotencyKey.startsWith('builtin-skill:')) {
        paused = true; arrived(); await hold;
      }
      return operations(request);
    });
    const upgrade = global.readSolomapSkillRegistry(f.project, f.root); await gate;
    const uninstall = await f.call('patch_capability_registry', { kind: 'skill', entry: { ...old.entry, status: 'uninstalled', enabled: false }, expectedRevision: 1, idempotencyKey: 'actual-concurrent-uninstall' });
    release(); const result = await upgrade;
    assert.equal(result.skills.some(value => value.id === memoryId), false);
    const record = f.store().readCapabilityRegistry({ kind: 'skill' }).entries.find(value => value.entry.id === memoryId);
    assert.equal(record.revision, uninstall.revision); assert.equal(record.entry.status, 'uninstalled');
    assert.deepEqual(fs.readFileSync(old.file), old.bytes);
    await f.reopen(); assert.equal((await global.readSolomapSkillRegistry(f.project, f.root)).skills.some(value => value.id === memoryId), false);
    assert.equal(f.store().readCapabilityRegistry({ kind: 'skill' }).entries.find(value => value.entry.id === memoryId).revision, 2);
    if (process.env.SOLOMAP_462_BUILTIN_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_BUILTIN_EVIDENCE}-concurrent-uninstall.json`, JSON.stringify({ uninstall, record, result, oldBytes: old.bytes.toString('base64') }, null, 2));
  } finally { release?.(); await f.close(); }
});

test('an upgrade committed before a lost reply is recovered by rereading and does not duplicate history', async () => {
  const f = await fixture(), old = historicalSkill(f); let dropped = false;
  try {
    await f.call('patch_capability_registry', { kind: 'skill', entry: old.entry, expectedRevision: 0, idempotencyKey: 'before-lost-upgrade-reply' });
    f.intercept(async (request, operations) => {
      const result = await operations(request);
      if (!dropped && request.operation === 'patch_capability_registry' && request.input.entry?.id === memoryId && request.input.idempotencyKey.startsWith('builtin-skill:')) { dropped = true; throw new Error('simulated_committed_reply_loss'); }
      return result;
    });
    await assert.rejects(global.readSolomapSkillRegistry(f.project, f.root), /simulated_committed_reply_loss/);
    const recovered = await global.readSolomapSkillRegistry(f.project, f.root);
    assert.equal(recovered.skills.find(value => value.id === memoryId).status, 'disabled');
    await f.reopen(); await global.readSolomapSkillRegistry(f.project, f.root);
    const record = f.store().readCapabilityRegistry({ kind: 'skill' }).entries.find(value => value.entry.id === memoryId);
    assert.equal(record.revision, 2); assert.notEqual(record.entry.entry, old.entry.entry);
    const evidence = f.store().read(record.objectId).relations.filter(value => value.relation === 'evidence'); assert.equal(evidence.length, 2);
  } finally { await f.close(); }
});
