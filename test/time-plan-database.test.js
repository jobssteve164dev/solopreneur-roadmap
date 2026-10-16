const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { confirmTimePlan, extractTimePlanDraft, readTimePlan, saveTimePlan } = require('../out/timePlan.js');
const { importAnalysisCaches } = require('../out/analysisDatabaseMigration.js');
const { MigrationRecycling } = require('../out/migrationRecycling.js');
const { isRetiredProjectFile } = require('../out/legacyProjectFileMigration.js');

test('the retired project time-plan validator is included in legacy cleanup discovery', () => {
  assert.equal(isRetiredProjectFile('validate-time-plan.cjs'), true);
});

test('time plans are read from database state without creating a project metadata file', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-time-plan-database-'));
  const globalDataPath = path.join(base, '.solomap-global');
  const projectPath = path.join(base, 'project');
  fs.mkdirSync(projectPath);
  const store = new UnifiedDataStore(globalDataPath);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const plan = {
    version: 1,
    status: 'draft',
    generatedAt: '2026-10-16T09:00:00+08:00',
    request: '安排今天的工作',
    items: [{ id: 'ship', title: '完成发布', startAt: '2026-10-16T10:00:00+08:00', durationMinutes: 25, assignee: 'user', prompt: '' }]
  };
  await operations({ operation: 'write_analysis_state', input: {
    root: projectPath,
    namespace: 'time-plan',
    key: 'current',
    expectedRevision: 0,
    value: plan,
    idempotencyKey: 'time-plan-fixture'
  } });

  const result = await readTimePlan(projectPath, globalDataPath, (operation, input) => operations({ operation, input }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.plan, { ...plan, confirmedAt: undefined });
  assert.equal(fs.existsSync(path.join(projectPath, '.solopreneur', 'time-plan.json')), false);
});

test('a legacy time plan is imported once without replacing newer database state', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-time-plan-import-'));
  const globalDataPath = path.join(base, '.solomap-global');
  const projectPath = path.join(base, 'project');
  const metadataPath = path.join(projectPath, '.solopreneur');
  fs.mkdirSync(metadataPath, { recursive: true });
  const plan = {
    version: 1,
    status: 'draft',
    generatedAt: '2026-10-16T09:00:00+08:00',
    request: '迁移旧安排',
    items: [{ id: 'migrate', title: '迁移', startAt: '2026-10-16T11:00:00+08:00', durationMinutes: 25, assignee: 'user', prompt: '' }]
  };
  fs.writeFileSync(path.join(metadataPath, 'time-plan.json'), JSON.stringify(plan));
  const store = new UnifiedDataStore(globalDataPath);
  t.after(() => { store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const project = await store.registerProject({ root: projectPath });

  const result = await importAnalysisCaches(store, globalDataPath, { projectScopes: { [projectPath]: project.projectId }, archiveUnresolved: true });
  assert.equal(result.imported, 1);
  assert.deepEqual(store.readAnalysisState(project.projectId, 'time-plan', 'current').value, plan);
  const recycling = await new MigrationRecycling(store).prepare();
  assert.ok(recycling.files.some(file => file.path === path.join(metadataPath, 'time-plan.json')));
});

test('the final tagged Agent draft is validated, saved, and confirmed in database state', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-time-plan-settlement-'));
  const globalDataPath = path.join(base, '.solomap-global');
  const projectPath = path.join(base, 'project');
  fs.mkdirSync(projectPath);
  const store = new UnifiedDataStore(globalDataPath);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const plan = {
    version: 1,
    status: 'draft',
    generatedAt: '2026-10-16T09:00:00+08:00',
    request: '保存草案',
    items: [{ id: 'review', title: '检查结果', startAt: '2026-10-16T12:00:00+08:00', durationMinutes: 25, assignee: 'agent', prompt: '检查结果并汇报。' }]
  };
  const extracted = extractTimePlanDraft(`过程输出\n<solomap-time-plan>\n${JSON.stringify(plan)}\n</solomap-time-plan>\n完成`);
  assert.equal(extracted.valid, true);
  const operation = (name, input) => operations({ operation: name, input });
  assert.equal((await saveTimePlan(projectPath, globalDataPath, extracted.plan, operation)).valid, true);
  const confirmed = await confirmTimePlan(projectPath, globalDataPath, operation);
  assert.equal(confirmed.valid, true);
  assert.equal(confirmed.plan.status, 'confirmed');
  assert.ok(confirmed.plan.confirmedAt);
  assert.equal(fs.existsSync(path.join(projectPath, '.solopreneur', 'time-plan.json')), false);
});
