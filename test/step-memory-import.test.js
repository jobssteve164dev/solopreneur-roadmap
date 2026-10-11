const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { registerUnifiedMcpTools } = require('../out/unifiedMcp.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-step-memory-import-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const identity = await ops({ operation: 'register_project', input: { root: project } });
  const sourceRoot = path.join(project, '.solopreneur', 'step-memory'); fs.mkdirSync(sourceRoot);
  return { root, project, sourceRoot, identity, store: () => store, call: (operation, input) => ops({ operation, input }),
    async import(key = 'first-import', collection = 'step-memory') {
      const job = await ops({ operation: 'import_project_data', input: { collection, sourceRoot, projectRoot: project, idempotencyKey: key } });
      await ops.waitForMigrations();
      return ops({ operation: 'migration_status', input: { jobId: job.jobId } });
    },
    async wait() { await ops.waitForMigrations(); },
    async reopen() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); },
    async close() { await ops.close(); store.close(); } };
}
const scope = f => ({ root: f.project, nodeId: 'step' });

test('an unknown background collection fails explicitly instead of completing a different importer', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.sourceRoot, 'step.json'), JSON.stringify({ completionCriteria: ['不能误判已迁移'], entries: [] }));
    const job = await f.import('unknown-import', 'step-memroy');
    assert.equal(job.status, 'failed'); assert.match(job.error, /migration_collection_unsupported/);
    assert.equal(await f.call('read_step_memory', scope(f)), null);
  } finally { await f.close(); }
});

test('Runtime startup discovers legacy step memory from the registered project and imports without another registry', async () => {
  const f = await fixture(); const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  try {
    fs.writeFileSync(path.join(f.sourceRoot, 'step.json'), JSON.stringify({ completionCriteria: ['启动后保留原标准'], entries: [{ unknown: '启动后正式可读' }] }));
    const discovery = await enqueueAvailableDataMigrations(f.store(), request => f.call(request.operation, request.input), () => true);
    await f.wait();
    assert.equal(discovery.queued, 1); assert.deepEqual((await f.call('read_step_memory', scope(f))).data.completionCriteria, ['启动后保留原标准']);
    assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
  } finally { await f.close(); }
});

test('the background step-memory importer retains every legacy value and original source through MCP and restart', async () => {
  const f = await fixture();
  const source = { completionCriteria: Array.from({ length: 31 }, (_, i) => `完整用户标准${i}`), lastCompletionEvidence: Array.from({ length: 35 }, (_, i) => `完整完成证据${i}`), customMetadata: { tags: ['不能丢失'], nested: { value: '原元数据' } }, entries: Array.from({ length: 77 }, (_, i) => ({ timestamp: `2026-09-${String(i % 28 + 1).padStart(2, '0')}T12:00:00Z`, status: 'Completed', changedFiles: Array.from({ length: 31 }, (_, j) => `源文件-${i}-${j}.txt`), usefulSignals: '完整关键信号🌿'.repeat(700), completionReason: '完整完成判断'.repeat(300), unknownEntryField: { value: i } })) };
  const bytes = JSON.stringify(source, null, 2) + '\n'; const file = path.join(f.sourceRoot, 'step.json'); fs.writeFileSync(file, bytes);
  try {
    const job = await f.import(); assert.equal(job.status, 'completed');
    const memory = await f.call('read_step_memory', scope(f));
    assert.deepEqual(memory?.data.completionCriteria, source.completionCriteria);
    assert.deepEqual(memory.data.lastCompletionEvidence, source.lastCompletionEvidence);
    assert.deepEqual(memory.data.customMetadata, source.customMetadata);
    assert.deepEqual(memory.data.entries, source.entries, 'historical entries and their unknown fields cannot be clipped or normalized away');
    assert.equal(memory.sources.length, 1); assert.equal(memory.sources[0].entryCount, 77);
    const tools = new Map(); registerUnifiedMcpTools({ registerTool: (name, _contract, handler) => tools.set(name, handler), registerResource() {} }, { scope: f.identity.projectId, call: (operation, input) => f.call(operation, input) });
    const read = await tools.get('solomap_read')({ ref: memory.sources[0].objectId, revision: memory.sources[0].revision });
    assert.equal(read.isError, undefined); assert.equal(JSON.parse(read.content[0].text).data.content, bytes);
    const foreignTools = new Map(); registerUnifiedMcpTools({ registerTool: (name, _contract, handler) => foreignTools.set(name, handler), registerResource() {} }, { scope: 'another-project', call: (operation, input) => f.call(operation, input) });
    assert.equal((await foreignTools.get('solomap_read')({ ref: memory.sources[0].objectId })).isError, true);
    await f.reopen(); assert.deepEqual((await f.call('read_step_memory', scope(f))).data, memory.data);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')).sort(), ['project.json', 'step-memory']);
  } finally { await f.close(); }
});

test('historical criteria replace initialization defaults while a newer explicit user edit is preserved', async () => {
  for (const edited of [false, true]) {
    const f = await fixture();
    try {
      await f.call('write_step_memory', { ...scope(f), expectedRevision: 0, origin: 'default', patch: { completionCriteria: ['初始化默认标准'] }, idempotencyKey: 'default' });
      if (edited) await f.call('write_step_memory', { ...scope(f), expectedRevision: 1, patch: { completionCriteria: ['用户最新标准'] }, idempotencyKey: 'user-edited' });
      fs.writeFileSync(path.join(f.sourceRoot, 'step.json'), JSON.stringify({ completionCriteria: ['用户历史自定义标准'], otherMetadata: '完整历史值', entries: [] }));
      await f.import(); const memory = await f.call('read_step_memory', { ...scope(f), includeEntries: false });
      assert.deepEqual(memory.data.completionCriteria, [edited ? '用户最新标准' : '用户历史自定义标准']);
      assert.equal(memory.data.otherMetadata, '完整历史值');
      assert.ok((await f.call('read', { ref: memory.sources[0].objectId })).data.content.includes('用户历史自定义标准'));
    } finally { await f.close(); }
  }
});

test('a changed legacy source creates a new pinned snapshot and an unchanged import adds no revisions', async () => {
  const f = await fixture(); const file = path.join(f.sourceRoot, 'step.json');
  try {
    const original = { completionCriteria: ['原历史标准'], entries: [{ unknown: '原交接全文' }] }; fs.writeFileSync(file, JSON.stringify(original));
    await f.import(); const before = await f.call('read_step_memory', scope(f));
    await f.import('unchanged-import'); assert.equal((await f.call('read_step_memory', scope(f))).revision, before.revision);
    fs.writeFileSync(file, JSON.stringify({ completionCriteria: ['后改历史标准'], entries: [...original.entries, { unknown: '新的完整交接' }] }));
    await f.import('changed-import');
    const historical = await f.call('read_step_memory', { ...scope(f), revision: before.revision });
    const current = await f.call('read_step_memory', scope(f));
    assert.deepEqual(historical.data.entries, original.entries); assert.deepEqual(historical.data.completionCriteria, original.completionCriteria);
    assert.equal(current.data.entries.length, 2); assert.deepEqual(current.data.completionCriteria, ['后改历史标准']);
    assert.notEqual(current.sources[0].objectId, historical.sources[0].objectId);
    assert.equal((await f.call('read', { ref: historical.sources[0].objectId, revision: historical.sources[0].revision })).data.content, JSON.stringify(original));
  } finally { await f.close(); }
});

test('legacy Markdown handoffs keep every section and complete signals with their exact source', async () => {
  const f = await fixture();
  const signal = '需要保留的完整信号🌿'.repeat(800); const reason = '完整完成原因'.repeat(200);
  const bytes = '# 环节交接总结\n\n' + Array.from({ length: 15 }, (_, i) => `## 2026-09-${String(i + 1).padStart(2, '0')}T12:00:00Z · Completed\n\n### 本轮文件变化\n${Array.from({ length: 25 }, (_, j) => `M file-${i}-${j}.txt`).join('\n')}\n\n### 本轮关键信号\n${signal}\n\n### 完成判断\n${reason}\n\n### 用户其他记录\n未知章节也必须保留-${i}`).join('\n\n---\n\n') + '\n';
  fs.writeFileSync(path.join(f.sourceRoot, 'step.md'), bytes);
  try {
    await f.import(); const memory = await f.call('read_step_memory', scope(f));
    assert.equal(memory?.data.entries.length, 15); assert.equal(memory.data.entries[0].changedFiles.length, 25);
    assert.equal(memory.data.entries[0].usefulSignals, signal); assert.equal(memory.data.entries[0].completionReason, reason);
    assert.ok(memory.data.entries[0].raw.includes('未知章节也必须保留-0'));
    assert.equal((await f.call('read', { ref: memory.sources[0].objectId })).data.content, bytes);
  } finally { await f.close(); }
});

test('a new source version removes only fields that source still owns while preserving later user changes', async () => {
  const f = await fixture(); const file = path.join(f.sourceRoot, 'step.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ completionCriteria: ['原标准'], removedField: '原来源字段', editedField: '旧值', entries: [] }));
    await f.import(); const original = await f.call('read_step_memory', scope(f));
    await f.call('write_step_memory', { ...scope(f), expectedRevision: original.revision, patch: { editedField: '用户后改值' }, idempotencyKey: 'preserve-user-edit' });
    fs.writeFileSync(file, JSON.stringify({ addedField: '新来源字段', entries: [] }));
    await f.import('source-field-removal'); const current = await f.call('read_step_memory', scope(f));
    assert.equal(Object.hasOwn(current.data, 'completionCriteria'), false); assert.equal(Object.hasOwn(current.data, 'removedField'), false);
    assert.equal(current.data.editedField, '用户后改值'); assert.equal(current.data.addedField, '新来源字段');
    assert.equal((await f.call('read_step_memory', { ...scope(f), revision: original.revision })).data.removedField, '原来源字段');
  } finally { await f.close(); }
});

test('reverting a corrupt source to its accepted bytes restores the imported status without duplicating the step snapshot', async () => {
  const f = await fixture(); const file = path.join(f.sourceRoot, 'step.json');
  const bytes = JSON.stringify({ completionCriteria: ['已接受的完整标准'], entries: [{ raw: '正式交接' }] });
  try {
    fs.writeFileSync(file, bytes); await f.import(); const original = await f.call('read_step_memory', scope(f));
    fs.writeFileSync(file, '{invalid json'); const broken = await f.import('corrupt-source'); assert.equal(broken.status, 'completed_with_conflicts');
    assert.equal(f.store().readMigrationSource(`step-memory:${f.identity.projectId}`, 'step.json').bytes.toString(), '{invalid json');
    fs.writeFileSync(file, bytes); await f.import('source-reverted'); const current = await f.call('read_step_memory', scope(f));
    assert.equal(current.revision, original.revision); assert.equal(current.sources[0].objectId, original.sources[0].objectId);
    assert.equal(f.store().readMigrationSource(`step-memory:${f.identity.projectId}`, 'step.json').stage, 'imported');
  } finally { await f.close(); }
});

test('a symlink is reported as an unresolved source instead of claiming that every legacy file was imported', async () => {
  const f = await fixture(); const foreign = path.join(path.dirname(f.project), 'private-original.json');
  fs.writeFileSync(foreign, JSON.stringify({ completionCriteria: ['外部私有字段'], entries: [] })); fs.symlinkSync(foreign, path.join(f.sourceRoot, 'foreign.json'));
  try {
    const job = await f.import(); assert.equal(job.status, 'completed_with_conflicts');
    assert.equal(job.progress.conflicts.length, 1); assert.match(job.progress.conflicts[0].error, /migration_source_invalid/);
    assert.equal(await f.call('read_step_memory', { root: f.project, nodeId: 'foreign' }), null);
    assert.equal(fs.readFileSync(foreign, 'utf8'), JSON.stringify({ completionCriteria: ['外部私有字段'], entries: [] }));
  } finally { await f.close(); }
});

test('the importer refuses to attribute another project source directory to this project', async () => {
  const f = await fixture(); const foreign = path.join(path.dirname(f.project), 'other-project', '.solopreneur', 'step-memory'); fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'foreign.json'), JSON.stringify({ completionCriteria: ['另一项目的私有标准'], entries: [] }));
  try {
    const queued = await f.call('import_project_data', { collection: 'step-memory', sourceRoot: foreign, projectRoot: f.project, idempotencyKey: 'wrong-project-source' }); await f.wait();
    const job = await f.call('migration_status', { jobId: queued.jobId }); assert.equal(job.status, 'failed'); assert.match(job.error, /migration_source_scope_mismatch/);
    assert.equal(await f.call('read_step_memory', { root: f.project, nodeId: 'foreign' }), null);
  } finally { await f.close(); }
});
