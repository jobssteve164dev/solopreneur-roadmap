const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { persistTelegramRuntimeConfig, refreshTelegramRuntimeConfig, telegramBotTokenSecretRef } = require('../out/telegramRuntimeConfig.js');
const { importLegacyRuntimeState } = require('../out/runtimeStateMigration.js');
const { serializeRoadmapNodes } = require('../out/db/csvStore.js');
const { DiskDatabase } = require('../out/db/diskDatabase.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const inventory = directory => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      if (fs.lstatSync(target).isDirectory()) { directories.push(target); inventory(target); }
      else files.push(target);
    }
  };
  inventory(root);
  files.forEach(file => fs.unlinkSync(file));
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

function canonicalJson(value) {
  return Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']' : value && typeof value === 'object'
    ? '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}' : JSON.stringify(value);
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package7-roadmap-'));
  const dataRoot = path.join(base, '.solomap-global');
  const project = path.join(base, 'project');
  const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  const csvPath = path.join(solopreneur, 'roadmap.csv');
  fs.writeFileSync(csvPath, [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,第一步,完整说明,实施,,codex,执行第一步,Pending,2026-01-01T00:00:00.000Z,',
    '2,第二步,保留关系,交付,1,codex,执行第二步,Pending,2026-01-02T00:00:00.000Z,'
  ].join('\n'));
  const store = new UnifiedDataStore(dataRoot);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => {
    try { await operations.close(); }
    finally {
      try { store.close(); }
      finally { cleanupExact(base); }
    }
  });
  return { base, dataRoot, project, csvPath, store, operations, call: (operation, input = {}) => operations({ operation, input }) };
}

test('roadmap CSV is accepted into the unified database and remains readable when the file is unavailable', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  assert.equal(accepted.nodes.length, 2);
  assert.equal(accepted.nodes[1].dependencies, '1');
  assert.match(accepted.acceptedHash, /^[a-f0-9]{64}$/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM roadmap_nodes')[0].count, 2);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM roadmap_dependencies')[0].count, 1);
  const isolated = path.join(f.base, 'roadmap-isolated.csv');
  fs.renameSync(f.csvPath, isolated);
  const read = await f.call('read_roadmap', { root: f.project });
  assert.deepEqual(read.nodes, accepted.nodes);
  fs.renameSync(isolated, f.csvPath);
});

test('roadmap acceptance rejects unknown, missing and duplicate CSV columns before persisting', async t => {
  const f = fixture(t), original = fs.readFileSync(f.csvPath, 'utf8'), [header, ...rows] = original.split('\n');
  for (const invalidHeader of [
    `${header},custom`,
    header.split(',').filter(column => column !== 'description').join(','),
    `${header},title`
  ]) {
    fs.writeFileSync(f.csvPath, [invalidHeader, ...rows].join('\n'));
    await assert.rejects(f.call('accept_roadmap_csv', { root: f.project }), /roadmap_csv_invalid:header/);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM roadmap_nodes')[0].count, 0);
  }
  fs.writeFileSync(f.csvPath, original);
  assert.equal((await f.call('accept_roadmap_csv', { root: f.project })).nodes.length, 2);
});

test('project registration and roadmap acceptance reject control-path symlinks before any write', async t => {
  const f = fixture(t), roadmap = fs.readFileSync(f.csvPath);
  const stores = [];
  const openStore = name => {
    const store = new UnifiedDataStore(path.join(f.base, `${name}-data`));
    stores.push(store);
    return store;
  };
  t.after(() => stores.forEach(store => store.close()));

  const controlRoot = path.join(f.base, 'linked-control-project'), outsideControl = path.join(f.base, 'outside-control-register');
  fs.mkdirSync(controlRoot, { recursive: true }); fs.mkdirSync(outsideControl, { recursive: true });
  fs.writeFileSync(path.join(outsideControl, 'roadmap.csv'), roadmap);
  fs.symlinkSync(outsideControl, path.join(controlRoot, '.solopreneur'), process.platform === 'win32' ? 'junction' : 'dir');
  const controlStore = openStore('linked-control');
  await assert.rejects(controlStore.registerProject({ root: controlRoot }), /project_control_path_invalid/);
  assert.equal(fs.existsSync(path.join(outsideControl, 'project.json')), false);
  assert.equal(controlStore.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 0);

  const identityRoot = path.join(f.base, 'linked-identity-project'), identityControl = path.join(identityRoot, '.solopreneur');
  const outsideIdentity = path.join(f.base, 'outside-project.json'), identityBody = JSON.stringify({ schemaVersion: 1, projectId: crypto.randomUUID() }) + '\n';
  fs.mkdirSync(identityControl, { recursive: true }); fs.writeFileSync(path.join(identityControl, 'roadmap.csv'), roadmap); fs.writeFileSync(outsideIdentity, identityBody);
  fs.symlinkSync(outsideIdentity, path.join(identityControl, 'project.json'), 'file');
  const identityStore = openStore('linked-identity');
  await assert.rejects(identityStore.registerProject({ root: identityRoot }), /project_identity_invalid/);
  assert.equal(fs.readFileSync(outsideIdentity, 'utf8'), identityBody);
  assert.equal(identityStore.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 0);

  const roadmapRoot = path.join(f.base, 'linked-roadmap-project'), roadmapControl = path.join(roadmapRoot, '.solopreneur');
  const outsideRoadmap = path.join(f.base, 'outside-roadmap.csv');
  fs.mkdirSync(roadmapControl, { recursive: true }); fs.writeFileSync(outsideRoadmap, roadmap); fs.symlinkSync(outsideRoadmap, path.join(roadmapControl, 'roadmap.csv'), 'file');
  const roadmapStore = openStore('linked-roadmap');
  await assert.rejects(roadmapStore.acceptRoadmapCsv({ root: roadmapRoot }), /roadmap_csv_invalid/);
  assert.equal(fs.existsSync(path.join(roadmapControl, 'project.json')), false);
  assert.equal(roadmapStore.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 0);
});

test('project identity writers keep a pinned control directory at the final write boundary', async t => {
  const f = fixture(t), root = path.join(f.base, 'identity-race-project'), control = path.join(root, '.solopreneur');
  const moved = path.join(root, '.solopreneur-original'), outside = path.join(f.base, 'identity-race-outside');
  fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const store = new UnifiedDataStore(path.join(f.base, 'identity-race-data')); t.after(() => store.close());
  const writeFile = fs.writeFileSync;
  let swapped = false;
  fs.writeFileSync = (target, ...args) => {
    if (!swapped && typeof target === 'number') {
      swapped = true; fs.renameSync(control, moved); fs.symlinkSync(outside, control, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return writeFile(target, ...args);
  };
  try { await assert.rejects(store.registerProject({ root }), /project_control_path_invalid|export_destination_symlink/); }
  finally { fs.writeFileSync = writeFile; }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(moved), []);
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 0);
});

test('database roadmap updates project the exact committed revision and reject a stale competing writer', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const nodes = accepted.nodes.map(node => node.id === '2' ? { ...node, title: '数据库已提交的新标题', status: 'In Progress' } : node);
  const updated = await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes, idempotencyKey: 'package7-roadmap-update' });
  assert.equal(updated.pending, false);
  assert.equal((await f.call('read_roadmap', { root: f.project })).nodes[1].title, '数据库已提交的新标题');
  assert.match(fs.readFileSync(f.csvPath, 'utf8'), /数据库已提交的新标题/);
  await assert.rejects(f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes, idempotencyKey: 'package7-stale-update' }), /revision_conflict/);
  assert.equal((await f.call('read_roadmap', { root: f.project })).nodes[1].title, '数据库已提交的新标题');
  assert.deepEqual(await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes, idempotencyKey: 'package7-roadmap-update' }), updated);
});

test('a Git-edited CSV is accepted without allowing an older pending projection to overwrite it', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const external = fs.readFileSync(f.csvPath, 'utf8').replace('第二步', 'Git 拉取后的标题');
  fs.writeFileSync(f.csvPath, external);
  const adopted = await f.call('accept_roadmap_csv', { root: f.project });
  assert.ok(adopted.revision > accepted.revision);
  assert.equal(adopted.nodes[1].title, 'Git 拉取后的标题');
  await assert.rejects(f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes, idempotencyKey: 'older-window' }), /revision_conflict/);
  assert.equal(fs.readFileSync(f.csvPath, 'utf8'), external);
});

test('an actual Git checkout is accepted as the next roadmap revision', async t => {
  const f = fixture(t);
  cp.execFileSync('git', ['init', '-q'], { cwd: f.project });
  cp.execFileSync('git', ['config', 'user.email', 'package7@example.invalid'], { cwd: f.project });
  cp.execFileSync('git', ['config', 'user.name', 'Package Seven'], { cwd: f.project });
  cp.execFileSync('git', ['add', '.solopreneur/roadmap.csv'], { cwd: f.project });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd: f.project });
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  fs.writeFileSync(f.csvPath, fs.readFileSync(f.csvPath, 'utf8').replace('保留关系', 'Git checkout 内容'));
  cp.execFileSync('git', ['commit', '-qam', 'incoming roadmap'], { cwd: f.project });
  const incoming = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.project, encoding: 'utf8' }).trim();
  cp.execFileSync('git', ['checkout', '-q', 'HEAD^', '--', '.solopreneur/roadmap.csv'], { cwd: f.project });
  assert.equal((await f.call('accept_roadmap_csv', { root: f.project })).acceptedHash, accepted.acceptedHash);
  cp.execFileSync('git', ['checkout', '-q', incoming, '--', '.solopreneur/roadmap.csv'], { cwd: f.project });
  const checkedOut = await f.call('accept_roadmap_csv', { root: f.project });
  assert.ok(checkedOut.revision > accepted.revision);
  assert.equal(checkedOut.nodes[1].description, 'Git checkout 内容');
});

test('non-overlapping Git and database edits merge by field and the pending projection recovers', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('simulated_projection_interruption'); };
  const pendingNodes = accepted.nodes.map(node => node.id === '2' ? { ...node, title: '数据库标题' } : node);
  const pending = await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: pendingNodes, idempotencyKey: 'merge-pending' });
  assert.equal(pending.pending, true);
  f.store.deliverRoadmapProjection = deliver;
  const external = fs.readFileSync(f.csvPath, 'utf8').replace('完整说明', 'Git 更新的说明');
  fs.writeFileSync(f.csvPath, external);
  const merged = await f.call('accept_roadmap_csv', { root: f.project });
  assert.equal(merged.pending, false);
  assert.equal(merged.nodes[0].description, 'Git 更新的说明');
  assert.equal(merged.nodes[1].title, '数据库标题');
  assert.match(fs.readFileSync(f.csvPath, 'utf8'), /Git 更新的说明/);
  assert.match(fs.readFileSync(f.csvPath, 'utf8'), /数据库标题/);
  assert.equal((await f.store.recoverOutbox()).pending.length, 0);
});

test('a file field edit keeps a database reorder while divergent reorders conflict', async t => {
  const f = fixture(t);
  fs.appendFileSync(f.csvPath, '\n3,第三步,顺序基线,交付,,codex,执行第三步,Pending,2026-01-03T00:00:00.000Z,');
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-reorder'); };
  await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: [accepted.nodes[1], accepted.nodes[0], accepted.nodes[2]], idempotencyKey: 'database-reorder' });
  f.store.deliverRoadmapProjection = deliver;
  fs.writeFileSync(f.csvPath, fs.readFileSync(f.csvPath, 'utf8').replace('顺序基线', '文件字段更新'));
  const merged = await f.call('accept_roadmap_csv', { root: f.project });
  assert.deepEqual(merged.nodes.map(node => node.id), ['2', '1', '3']);
  assert.equal(merged.nodes[2].description, '文件字段更新');

  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-divergent-reorder'); };
  await f.call('update_roadmap', { root: f.project, expectedRevision: merged.revision, nodes: [merged.nodes[1], merged.nodes[0], merged.nodes[2]], idempotencyKey: 'second-database-reorder' });
  f.store.deliverRoadmapProjection = deliver;
  fs.writeFileSync(f.csvPath, serializeRoadmapNodes([merged.nodes[2], merged.nodes[0], merged.nodes[1]]));
  await assert.rejects(f.call('accept_roadmap_csv', { root: f.project }), /roadmap_projection_conflict:__order__/);
});

test('overlapping Git and database edits retain both revisions and require a semantic choice', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('simulated_projection_interruption'); };
  const pendingNodes = accepted.nodes.map(node => node.id === '2' ? { ...node, title: '数据库冲突标题' } : node);
  await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: pendingNodes, idempotencyKey: 'conflict-pending' });
  f.store.deliverRoadmapProjection = deliver;
  const external = fs.readFileSync(f.csvPath, 'utf8').replace('第二步', 'Git 冲突标题');
  fs.writeFileSync(f.csvPath, external);
  await assert.rejects(f.call('accept_roadmap_csv', { root: f.project }), /roadmap_projection_conflict:2\.title/);
  assert.equal(fs.readFileSync(f.csvPath, 'utf8'), external);
  const retained = await f.call('read_roadmap', { root: f.project });
  assert.equal(retained.pending, true);
  assert.equal(retained.nodes[1].title, '数据库冲突标题');
  const resolved = await f.call('resolve_roadmap_conflict', { root: f.project, choice: 'file', expectedRevision: retained.revision, idempotencyKey: 'resolve-file' });
  assert.equal(resolved.pending, false);
  assert.equal(resolved.nodes[1].title, 'Git 冲突标题');
  assert.deepEqual(await f.call('resolve_roadmap_conflict', { root: f.project, choice: 'file', expectedRevision: retained.revision, idempotencyKey: 'resolve-file' }), resolved);
  await assert.rejects(f.call('resolve_roadmap_conflict', { root: f.project, choice: 'database', expectedRevision: retained.revision, idempotencyKey: 'resolve-file' }), /idempotency_conflict/);
});

test('a Git write at the projection replacement boundary is preserved as a conflict', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const rename = fs.renameSync, external = fs.readFileSync(f.csvPath, 'utf8').replace('第二步', 'GIT-LATE');
  fs.renameSync = (source, destination) => {
    if (source === f.csvPath && destination.includes('.solomap-') && destination.endsWith('.displaced')) fs.writeFileSync(f.csvPath, external);
    return rename(source, destination);
  };
  try {
    const result = await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes.map(node => node.id === '2' ? { ...node, title: 'DATABASE' } : node), idempotencyKey: 'late-git-write' });
    assert.equal(result.pending, true);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.csvPath, 'utf8'), external);
  assert.match(f.store.rows('SELECT last_error FROM roadmap_file_states')[0].last_error, /roadmap_projection_conflict/);
});

test('a database-committed roadmap projection is delivered after the data owner restarts', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package7-restart-'));
  const dataRoot = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  const csvPath = path.join(project, '.solopreneur', 'roadmap.csv');
  fs.writeFileSync(csvPath, 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,初始,,实施,,codex,,Pending,,');
  let store = new UnifiedDataStore(dataRoot), operations = createRuntimeDataOperations(store);
  t.after(async () => { try { await operations.close(); } catch {} try { store.close(); } catch {} cleanupExact(base); });
  const call = (operation, input = {}) => operations({ operation, input });
  const accepted = await call('accept_roadmap_csv', { root: project });
  store.deliverRoadmapProjection = async () => { throw new Error('simulated_owner_exit'); };
  const pending = await call('update_roadmap', { root: project, expectedRevision: accepted.revision, nodes: [{ ...accepted.nodes[0], title: '重启后投影' }], idempotencyKey: 'restart-projection' });
  assert.equal(pending.pending, true);
  await operations.close(); store.close();
  store = UnifiedDataStore.open(dataRoot); operations = createRuntimeDataOperations(store);
  const recovered = await store.recoverOutbox();
  assert.equal(recovered.pending.length, 0);
  assert.match(fs.readFileSync(csvPath, 'utf8'), /重启后投影/);
  assert.equal((await call('read_roadmap', { root: project })).pending, false);
});

test('the accepted file hash is the actual CSV bytes and unchanged acceptance does not grow the WAL', async t => {
  const f = fixture(t);
  const first = await f.call('accept_roadmap_csv', { root: f.project });
  assert.equal(first.acceptedHash, crypto.createHash('sha256').update(fs.readFileSync(f.csvPath)).digest('hex'));
  const walPath = path.join(f.dataRoot, 'solomap.db-wal');
  const before = fs.readFileSync(walPath);
  const second = await f.call('accept_roadmap_csv', { root: f.project });
  assert.deepEqual(second, first);
  assert.deepEqual(fs.readFileSync(walPath), before);
});

test('a consistent full backup restores into a new data root with its identity and large content intact', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0xa5);
  const asset = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'package7-large-asset', data: {
    name: 'large.bin', origin: 'package7', content: { encoding: 'base64', data: bytes.toString('base64'), mimeType: 'application/octet-stream' }
  } });
  const destination = path.join(f.dataRoot, 'exports', 'complete.db');
  const firstBackup = await f.call('backup', { destination, idempotencyKey: 'complete-backup' });
  const newest = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'post-backup-asset', data: {
    name: 'newest.txt', origin: 'package7', content: 'LATEST_BACKUP_MARKER'
  } });
  const latestBackup = await f.call('backup', { destination, idempotencyKey: 'latest-backup' });
  assert.notEqual(latestBackup.sha256, firstBackup.sha256);
  assert.deepEqual(await f.call('backup', { destination, idempotencyKey: 'latest-backup' }), latestBackup);
  const restoredRoot = path.join(f.base, 'restored', '.solomap-global');
  const restored = await f.call('restore_backup', { source: destination, destinationRoot: restoredRoot, idempotencyKey: 'restore-complete' });
  assert.equal(restored.databaseId, f.store.databaseId);
  const reopened = UnifiedDataStore.open(restoredRoot, f.store.databaseId);
  try {
    assert.deepEqual(Buffer.from(reopened.read(asset.objectId).data.content.data, 'base64'), bytes);
    assert.equal(reopened.read(newest.objectId).data.content, 'LATEST_BACKUP_MARKER');
    assert.deepEqual((await reopened.readRoadmap({ root: f.project })).nodes, accepted.nodes);
  } finally { reopened.close(); }
  assert.deepEqual(await f.call('restore_backup', { source: destination, destinationRoot: restoredRoot, idempotencyKey: 'restore-complete' }), restored);
});

test('concurrent backup replays coalesce and distinct requests serialize on one destination', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const destination = path.join(f.dataRoot, 'exports', 'concurrent-backup.db');
  const same = await Promise.all([
    f.store.backup({ destination, idempotencyKey: 'concurrent-same' }),
    f.store.backup({ destination, idempotencyKey: 'concurrent-same' })
  ]);
  assert.deepEqual(same[0], same[1]);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'), same[0].sha256);

  const distinct = await Promise.all([
    f.store.backup({ destination, idempotencyKey: 'concurrent-first' }),
    f.store.backup({ destination, idempotencyKey: 'concurrent-second' })
  ]);
  const finalHash = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  assert.equal(distinct[1].sha256, finalHash);
  assert.equal(fs.readdirSync(path.dirname(destination)).some(name => name.includes('.solomap-backup-') || name.endsWith('.delivery')), false);
});

test('a failed backup leaves no destination or temporary file and the same request can retry', async t => {
  const f = fixture(t), destination = path.join(f.dataRoot, 'exports', 'retry.db');
  const backup = f.store.db.backup.bind(f.store.db);
  f.store.db.backup = async () => { throw new Error('injected_backup_failure'); };
  await assert.rejects(f.call('backup', { destination, idempotencyKey: 'retry-backup' }), /injected_backup_failure/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.existsSync(path.dirname(destination)) ? fs.readdirSync(path.dirname(destination)) : [], []);
  f.store.db.backup = backup;
  const result = await f.call('backup', { destination, idempotencyKey: 'retry-backup' });
  assert.equal(fs.existsSync(destination), true);
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'));
});

test('backup and restore keep their physical target directory across asynchronous copy boundaries', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const backupParent = path.join(f.base, 'backup-race'), backupMoved = path.join(f.base, 'backup-race-original'), backupOutside = path.join(f.base, 'backup-race-outside');
  fs.mkdirSync(backupParent); fs.mkdirSync(backupOutside);
  const destination = path.join(backupParent, 'snapshot.db'), backup = f.store.db.backup.bind(f.store.db);
  let backupSwapped = false;
  f.store.db.backup = async target => {
    backupSwapped = true; fs.renameSync(backupParent, backupMoved); fs.symlinkSync(backupOutside, backupParent, process.platform === 'win32' ? 'junction' : 'dir');
    return backup(target);
  };
  try { await assert.rejects(f.store.backup({ destination, idempotencyKey: 'backup-parent-race' }), /backup_destination_invalid|export_destination_symlink/); }
  finally { f.store.db.backup = backup; }
  assert.equal(backupSwapped, true); assert.deepEqual(fs.readdirSync(backupOutside), []); assert.deepEqual(fs.readdirSync(backupMoved), []);
  assert.equal(f.store.rows("SELECT status FROM requests WHERE idempotency_key='database-backup:backup-parent-race'")[0].status, 'pending');

  const safeBackup = path.join(f.dataRoot, 'exports', 'restore-race-source.db');
  await f.store.backup({ destination: safeBackup, idempotencyKey: 'restore-race-source' });
  const restoreRoot = path.join(f.base, 'restore-race'), restoreMoved = path.join(f.base, 'restore-race-original'), restoreOutside = path.join(f.base, 'restore-race-outside');
  fs.mkdirSync(restoreRoot); fs.mkdirSync(restoreOutside);
  const copyFile = fs.copyFileSync;
  let restoreSwapped = false;
  fs.copyFileSync = (source, target, ...args) => {
    if (!restoreSwapped && String(target).includes('.solomap-restore-')) {
      restoreSwapped = true; fs.renameSync(restoreRoot, restoreMoved); fs.symlinkSync(restoreOutside, restoreRoot, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return copyFile(source, target, ...args);
  };
  try { assert.throws(() => f.store.restoreBackup({ source: safeBackup, destinationRoot: restoreRoot, idempotencyKey: 'restore-parent-race' }), /restore_target_invalid|export_destination_symlink/); }
  finally { fs.copyFileSync = copyFile; }
  assert.equal(restoreSwapped, true); assert.deepEqual(fs.readdirSync(restoreOutside), []); assert.deepEqual(fs.readdirSync(restoreMoved), []);
  assert.equal(f.store.rows("SELECT status FROM requests WHERE idempotency_key='database-restore:restore-parent-race'")[0].status, 'pending');
});

test('backup rejects the active database and its live sidecars before touching them', async t => {
  const f = fixture(t), before = f.store.databaseId;
  for (const destination of [path.join(f.dataRoot, 'solomap.db'), path.join(f.dataRoot, 'solomap.db-wal'), path.join(f.dataRoot, 'solomap.db-shm')]) {
    await assert.rejects(f.call('backup', { destination, idempotencyKey: `active-${path.basename(destination)}` }), /backup_destination_active_database/);
  }
  assert.equal(f.store.databaseId, before);
  assert.equal(f.store.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
});

test('backup never replaces another opened data root with the same database identity', async t => {
  const f = fixture(t), seed = path.join(f.dataRoot, 'exports', 'active-target-seed.db');
  await f.call('backup', { destination: seed, idempotencyKey: 'active-target-seed' });
  const targetRoot = path.join(f.base, 'opened-target');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.copyFileSync(seed, path.join(targetRoot, 'solomap.db'));
  const target = UnifiedDataStore.open(targetRoot, f.store.databaseId);
  t.after(() => target.close());
  await assert.rejects(f.call('backup', { destination: path.join(targetRoot, 'solomap.db'), idempotencyKey: 'must-not-overwrite-open-target' }), /backup_destination_active_database/);
  assert.equal(target.databaseId, f.store.databaseId);
  assert.equal(f.store.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
  assert.equal(target.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
});

test('restore inspection never deletes WAL created by a writer during the check', async t => {
  const f = fixture(t), backup = path.join(f.dataRoot, 'exports', 'inspection-race.db');
  await f.call('backup', { destination: backup, idempotencyKey: 'inspection-race-backup' });
  const exec = DiskDatabase.prototype.exec; let writer, injected = false;
  DiskDatabase.prototype.exec = function(sql) {
    if (!injected && this.filePath === backup && sql === 'PRAGMA integrity_check') {
      injected = true; writer = new DiskDatabase(backup);
      writer.run("INSERT INTO database_meta(key,value) VALUES('inspection_race_marker','preserved')");
    }
    return exec.apply(this, arguments);
  };
  try {
    assert.throws(() => f.store.restoreBackup({ source: backup, destinationRoot: path.join(f.base, 'inspection-race-target'), idempotencyKey: 'inspection-race-restore' }), /backup_source_active/);
    assert.equal(writer.exec("SELECT value FROM database_meta WHERE key='inspection_race_marker'")[0].values[0][0], 'preserved');
    assert.equal(fs.existsSync(`${backup}-wal`), true);
  } finally {
    DiskDatabase.prototype.exec = exec;
    writer?.close();
  }
});

test('restore replaces only its deterministic partial staging file and atomically publishes a verified database', async t => {
  const f = fixture(t), backup = path.join(f.dataRoot, 'exports', 'restore-source.db');
  await f.call('backup', { destination: backup, idempotencyKey: 'restore-source' });
  const root = path.join(f.base, 'atomic-restore'), key = 'atomic-retry', requestKey = `database-restore:${key}`;
  fs.mkdirSync(root, { recursive: true });
  const stage = path.join(root, `solomap.db.solomap-restore-${crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 24)}`);
  fs.writeFileSync(stage, Buffer.from('PARTIAL_CRASH_COPY'));
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
  const inputHash = crypto.createHash('sha256').update(canonicalJson({ source: path.resolve(backup), sourceHash, destinationRoot: path.resolve(root) })).digest('hex');
  f.store.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [f.store.actorId, requestKey, crypto.randomUUID(), inputHash, 'pending']);
  const result = await f.call('restore_backup', { source: backup, destinationRoot: root, idempotencyKey: key });
  assert.equal(fs.existsSync(stage), false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(result.destination)).digest('hex'), result.sha256);
  await assert.rejects(f.call('restore_backup', { source: backup, destinationRoot: path.join(f.base, 'other-restore'), idempotencyKey: key }), /idempotency_conflict/);
});

test('restore refuses a prepopulated target even when its database bytes are exact', async t => {
  const f = fixture(t), backup = path.join(f.dataRoot, 'exports', 'nonempty-restore-source.db');
  await f.call('backup', { destination: backup, idempotencyKey: 'nonempty-restore-source' });
  for (const kind of ['exact-only', 'sibling', 'wal', 'runtime']) {
    const root = path.join(f.base, `nonempty-${kind}`); fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(backup, path.join(root, 'solomap.db'));
    if (kind === 'sibling') fs.writeFileSync(path.join(root, 'keep.txt'), 'KEEP');
    if (kind === 'wal') fs.writeFileSync(path.join(root, 'solomap.db-wal'), 'STALE');
    if (kind === 'runtime') { fs.mkdirSync(path.join(root, 'runtime')); fs.writeFileSync(path.join(root, 'runtime', 'control.json'), '{}'); }
    await assert.rejects(f.call('restore_backup', { source: backup, destinationRoot: root, idempotencyKey: `nonempty-${kind}` }), /restore_target_not_empty/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'solomap.db')), fs.readFileSync(backup));
    if (kind === 'sibling') assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'KEEP');
  }
});

test('moving a project preserves its stable identity while a live physical clone is rejected', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const clone = path.join(f.base, 'clone'); fs.mkdirSync(path.join(clone, '.solopreneur'), { recursive: true });
  fs.copyFileSync(path.join(f.project, '.solopreneur', 'project.json'), path.join(clone, '.solopreneur', 'project.json'));
  fs.copyFileSync(f.csvPath, path.join(clone, '.solopreneur', 'roadmap.csv'));
  await assert.rejects(f.call('register_project', { root: clone }), /project_clone_identity_conflict/);
  const moved = path.join(f.base, 'moved-project');
  fs.renameSync(f.project, moved);
  const registered = await f.call('register_project', { root: moved });
  assert.equal(registered.projectId, accepted.projectId);
  assert.equal(f.store.rows("SELECT COUNT(*) AS count FROM project_locations WHERE project_id=? AND status='active'", [accepted.projectId])[0].count, 1);
  assert.equal(f.store.rows("SELECT COUNT(*) AS count FROM project_locations WHERE project_id=? AND status='moved'", [accepted.projectId])[0].count, 1);
});

test('a moved project delivers its pending database roadmap before accepting the moved CSV', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-before-project-move'); };
  const pending = await f.call('update_roadmap', {
    root: f.project,
    expectedRevision: accepted.revision,
    nodes: accepted.nodes.map(node => node.id === '1' ? { ...node, title: 'DB_COMMITTED_BEFORE_MOVE' } : node),
    idempotencyKey: 'pending-before-project-move'
  });
  assert.equal(pending.pending, true);
  f.store.deliverRoadmapProjection = deliver;
  const moved = path.join(f.base, 'moved-with-pending-roadmap');
  fs.renameSync(f.project, moved);
  const recovered = await f.store.acceptRoadmapCsv({ root: moved });
  assert.equal(recovered.pending, false);
  assert.equal(recovered.nodes[0].title, 'DB_COMMITTED_BEFORE_MOVE');
  assert.match(fs.readFileSync(path.join(moved, '.solopreneur', 'roadmap.csv'), 'utf8'), /DB_COMMITTED_BEFORE_MOVE/);
});

test('concurrent moved and cloned registrations leave one active location and retain the pending roadmap', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-before-concurrent-move'); };
  await f.call('update_roadmap', {
    root: f.project,
    expectedRevision: accepted.revision,
    nodes: accepted.nodes.map(node => node.id === '1' ? { ...node, title: 'DB_PENDING_CONCURRENT_MOVE' } : node),
    idempotencyKey: 'pending-before-concurrent-move'
  });
  f.store.deliverRoadmapProjection = deliver;
  const moved = path.join(f.base, 'concurrent-moved-project'), clone = path.join(f.base, 'concurrent-clone-project');
  fs.renameSync(f.project, moved);
  fs.cpSync(moved, clone, { recursive: true });
  const attempts = await Promise.allSettled([f.store.registerProject({ root: moved }), f.store.registerProject({ root: clone })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String(attempts.find(result => result.status === 'rejected').reason), /project_clone_identity_conflict/);
  const active = f.store.rows("SELECT root_path FROM project_locations WHERE project_id=? AND status='active'", [accepted.projectId]);
  assert.equal(active.length, 1);
  const recovered = await f.store.acceptRoadmapCsv({ root: String(active[0].root_path) });
  assert.equal(recovered.pending, false);
  assert.equal(recovered.nodes[0].title, 'DB_PENDING_CONCURRENT_MOVE');
});

test('Telegram token rotation refreshes the initiating host cache once across the Runtime boundary', async t => {
  const f = fixture(t), previousSecretStore = process.env.SOLOMAP_TEST_SECRET_STORE;
  const secretStore = path.join(f.base, 'telegram-secret-store');
  process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  t.after(() => {
    if (previousSecretStore === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE;
    else process.env.SOLOMAP_TEST_SECRET_STORE = previousSecretStore;
  });
  const remoteOperation = async request => {
    if (request.operation !== 'install_runtime_secret') return f.operations(request);
    assert.equal(request.input.secretRef, telegramBotTokenSecretRef);
    fs.mkdirSync(secretStore, { recursive: true });
    const identity = crypto.createHash('sha256').update(f.dataRoot).digest('hex');
    fs.writeFileSync(path.join(secretStore, `${identity}.secret`), String(request.input.value), { mode: 0o600 });
    return { installed: true };
  };
  const first = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'first-token', chatId: '123' }, remoteOperation, 'telegram-first-token');
  const rotated = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'second-token', chatId: '123' }, remoteOperation, 'telegram-second-token');
  assert.equal(rotated.botToken, 'second-token');
  assert.equal(rotated.bindingGeneration, first.bindingGeneration + 1);
  assert.equal(rotated.replyGeneration, first.replyGeneration + 1);
  const repeated = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'second-token', chatId: '123' }, remoteOperation, 'telegram-second-token-repeat');
  assert.equal(repeated.botToken, 'second-token');
  assert.equal(repeated.bindingGeneration, rotated.bindingGeneration);
  assert.equal(repeated.replyGeneration, rotated.replyGeneration);
});

test('Telegram token rotation preserves its generation reset across a concurrent settings revision', async t => {
  const f = fixture(t), previousSecretStore = process.env.SOLOMAP_TEST_SECRET_STORE;
  const secretStore = path.join(f.base, 'telegram-conflict-secret-store');
  process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  t.after(() => {
    if (previousSecretStore === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE;
    else process.env.SOLOMAP_TEST_SECRET_STORE = previousSecretStore;
  });
  let injectConflict = false;
  const remoteOperation = async request => {
    if (request.operation === 'install_runtime_secret') {
      fs.mkdirSync(secretStore, { recursive: true });
      const identity = crypto.createHash('sha256').update(f.dataRoot).digest('hex');
      fs.writeFileSync(path.join(secretStore, `${identity}.secret`), String(request.input.value), { mode: 0o600 });
      return { installed: true };
    }
    if (injectConflict && request.operation === 'patch_host_settings') {
      injectConflict = false;
      const settings = await f.operations({ operation: 'read_host_settings', input: { namespace: 'telegram', ownerScope: 'global' } });
      const offset = settings.items.find(item => item.key === 'offset');
      await f.operations({ operation: 'patch_host_settings', input: { namespace: 'telegram', ownerScope: 'global', patches: [{ key: 'offset', expectedRevision: offset.revision, value: 99 }], idempotencyKey: 'concurrent-telegram-offset' } });
    }
    return f.operations(request);
  };
  const first = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'conflict-old-token', chatId: '123', conversationIds: { '123': 'old-conversation' }, offset: 44 }, remoteOperation, 'telegram-conflict-initial');
  injectConflict = true;
  const rotated = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'conflict-new-token', chatId: '123' }, remoteOperation, 'telegram-conflict-rotation');
  assert.equal(rotated.botToken, 'conflict-new-token');
  assert.equal(rotated.bindingGeneration, first.bindingGeneration + 1);
  assert.equal(rotated.replyGeneration, first.replyGeneration + 1);
  assert.equal(rotated.offset, 0);
  assert.deepEqual(rotated.conversationIds, {});
});

test('concurrent saves of the same new Telegram token advance its generation only once', async t => {
  const f = fixture(t), previousSecretStore = process.env.SOLOMAP_TEST_SECRET_STORE;
  const secretStore = path.join(f.base, 'telegram-same-token-secret-store');
  process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  t.after(() => {
    if (previousSecretStore === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE;
    else process.env.SOLOMAP_TEST_SECRET_STORE = previousSecretStore;
  });
  const remoteOperation = async request => {
    if (request.operation !== 'install_runtime_secret') return f.operations(request);
    fs.mkdirSync(secretStore, { recursive: true });
    const identity = crypto.createHash('sha256').update(f.dataRoot).digest('hex');
    fs.writeFileSync(path.join(secretStore, `${identity}.secret`), String(request.input.value), { mode: 0o600 });
    return { installed: true };
  };
  const first = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'same-token-old', chatId: '123', conversationIds: { '123': 'old' }, offset: 44 }, remoteOperation, 'same-token-initial');
  await Promise.all([
    persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'same-token-new', chatId: '123' }, remoteOperation, 'same-token-a'),
    persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'same-token-new', chatId: '123' }, remoteOperation, 'same-token-b')
  ]);
  const saved = await refreshTelegramRuntimeConfig(f.dataRoot, remoteOperation);
  assert.equal(saved.bindingGeneration, first.bindingGeneration + 1);
  assert.equal(saved.replyGeneration, first.replyGeneration + 1);
  assert.equal(saved.offset, 0);
  assert.deepEqual(saved.conversationIds, {});
});

test('a Telegram token retries its generation reset after secret install succeeds but database commit fails', async t => {
  const f = fixture(t), previousSecretStore = process.env.SOLOMAP_TEST_SECRET_STORE;
  const secretStore = path.join(f.base, 'telegram-split-secret-store');
  process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  t.after(() => {
    if (previousSecretStore === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE;
    else process.env.SOLOMAP_TEST_SECRET_STORE = previousSecretStore;
  });
  let failDatabasePatch = false;
  const remoteOperation = async request => {
    if (request.operation === 'install_runtime_secret') {
      fs.mkdirSync(secretStore, { recursive: true });
      const identity = crypto.createHash('sha256').update(f.dataRoot).digest('hex');
      fs.writeFileSync(path.join(secretStore, `${identity}.secret`), String(request.input.value), { mode: 0o600 });
      return { installed: true };
    }
    if (failDatabasePatch && request.operation === 'patch_host_settings') {
      failDatabasePatch = false;
      throw new Error('simulated_database_unavailable');
    }
    return f.operations(request);
  };
  const first = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: 'split-old-token', chatId: '123', conversationIds: { '123': 'old' }, offset: 44 }, remoteOperation, 'split-initial');
  failDatabasePatch = true;
  await assert.rejects(persistTelegramRuntimeConfig(f.dataRoot, { botToken: 'split-new-token' }, remoteOperation, 'split-failed'), /simulated_database_unavailable/);
  const recovered = await persistTelegramRuntimeConfig(f.dataRoot, { botToken: 'split-new-token' }, remoteOperation, 'split-retry');
  assert.equal(recovered.bindingGeneration, first.bindingGeneration + 1);
  assert.equal(recovered.replyGeneration, first.replyGeneration + 1);
  assert.equal(recovered.offset, 0);
  assert.deepEqual(recovered.conversationIds, {});
});

test('a moved project is not blocked when its old path is reused by a different project', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const moved = path.join(f.base, 'moved-with-reused-origin');
  fs.renameSync(f.project, moved);
  const replacementId = crypto.randomUUID();
  fs.mkdirSync(path.join(f.project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.solopreneur', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: replacementId }) + '\n');
  fs.writeFileSync(path.join(f.project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,替代项目,,,,codex,,Pending,,');
  const movedRegistration = await f.call('register_project', { root: moved });
  const replacementRegistration = await f.call('register_project', { root: f.project });
  assert.equal(movedRegistration.projectId, accepted.projectId);
  assert.equal(replacementRegistration.projectId, replacementId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(moved, '.solopreneur', 'project.json'))).projectId, accepted.projectId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.project, '.solopreneur', 'project.json'))).projectId, replacementId);
});

test('project export replays its first fixed archive bytes and rejects a changed intent for the same key', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const destination = path.join(f.dataRoot, 'exports', 'fixed.json');
  const first = await f.call('export_project', { root: f.project, destination, idempotencyKey: 'fixed-export' });
  const firstBytes = fs.readFileSync(destination);
  f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'after-fixed-export', data: { name: 'later.txt', origin: 'package7', content: 'LATER_EXPORT_CONTENT' } });
  fs.unlinkSync(destination);
  assert.deepEqual(await f.call('export_project', { root: f.project, destination, idempotencyKey: 'fixed-export' }), first);
  assert.deepEqual(fs.readFileSync(destination), firstBytes);
  await assert.rejects(f.call('export_project', { root: f.project, destination: path.join(f.dataRoot, 'exports', 'other.json'), idempotencyKey: 'fixed-export' }), /idempotency_conflict/);
  const secondDestination = path.join(f.dataRoot, 'exports', 'latest.json');
  const second = await f.call('export_project', { root: f.project, destination: secondDestination, idempotencyKey: 'latest-export' });
  assert.notEqual(second.sha256, first.sha256);
  const envelope = JSON.parse(fs.readFileSync(secondDestination, 'utf8'));
  const asset = envelope.archive.tables.find(table => table.name === 'assets').rows.find(row => row.name === 'later.txt');
  const content = envelope.archive.tables.find(table => table.name === 'contents').rows.find(row => row.id === asset.content_id);
  assert.equal(Buffer.from(content.data.bytes, 'base64').toString('utf8'), 'LATER_EXPORT_CONTENT');
});

test('project export pins its physical parent when the requested path is replaced at the write boundary', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const parent = path.join(f.dataRoot, 'race-export'), moved = path.join(f.dataRoot, 'race-export-original');
  const outside = path.join(f.base, 'race-export-outside'), destination = path.join(parent, 'project.json');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(parent, { recursive: true });
  const writeFile = fs.writeFileSync;
  let swapped = false;
  fs.writeFileSync = (target, ...args) => {
    if (!swapped && typeof target === 'number') {
      swapped = true;
      fs.renameSync(parent, moved);
      fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return writeFile(target, ...args);
  };
  try {
    await assert.rejects(f.store.exportProject({ root: f.project, destination, idempotencyKey: 'parent-swap-export' }), /project_export_destination_invalid|export_destination_symlink/);
  } finally { fs.writeFileSync = writeFile; }
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(outside, 'project.json')), false);
  assert.equal(fs.existsSync(path.join(moved, 'project.json')), false);
});

test('a single-project archive restores complete revisions, relations and large bytes without secrets or foreign project data', async t => {
  const f = fixture(t);
  const accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const original = Buffer.from('old-project-asset');
  const latest = Buffer.alloc(1024 * 1024 + 29, 0x6b);
  const asset = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'portable-asset-create', data: {
    name: 'portable.bin', origin: 'package7', content: { encoding: 'base64', data: original.toString('base64'), mimeType: 'application/octet-stream' }
  } });
  const updated = f.store.write({ kind: 'asset', action: 'patch', scope: accepted.projectId, objectId: asset.objectId, expectedRevision: asset.revision, idempotencyKey: 'portable-asset-update', data: {
    name: 'portable.bin', origin: 'package7', content: { encoding: 'base64', data: latest.toString('base64'), mimeType: 'application/octet-stream' }
  } });
  const evidence = f.store.write({ kind: 'evidence', action: 'create', scope: accepted.projectId, idempotencyKey: 'portable-evidence', data: {
    type: 'package7', source_actor_id: f.store.rows('SELECT id FROM actors ORDER BY rowid LIMIT 1')[0].id,
    observed_at: Date.now(), content: 'project-history-marker'
  } });
  f.store.link({ source: updated.objectId, relation: 'evidence', target: evidence.objectId, expectedRevision: updated.revision, idempotencyKey: 'portable-link' });

  const foreignRoot = path.join(f.base, 'foreign');
  fs.mkdirSync(path.join(foreignRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(foreignRoot, '.solopreneur', 'roadmap.csv'), fs.readFileSync(f.csvPath));
  const foreign = await f.call('accept_roadmap_csv', { root: foreignRoot });
  f.store.write({ kind: 'asset', action: 'create', scope: foreign.projectId, idempotencyKey: 'foreign-asset', data: {
    name: 'foreign.txt', origin: 'package7', content: 'FOREIGN_PROJECT_PRIVATE_MARKER'
  } });
  f.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', patches: [{ key: 'botToken', expectedRevision: 0, value: 'SECRET_TOKEN_MUST_NOT_EXPORT' }], idempotencyKey: 'portable-secret' });

  const archive = path.join(f.dataRoot, 'exports', 'project.solomap-project.json');
  const exported = await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'portable-export' });
  assert.equal(exported.projectId, accepted.projectId);
  const archiveBytes = fs.readFileSync(archive);
  assert.equal(crypto.createHash('sha256').update(archiveBytes).digest('hex'), exported.sha256);
  assert.doesNotMatch(archiveBytes.toString('utf8'), /FOREIGN_PROJECT_PRIVATE_MARKER|SECRET_TOKEN_MUST_NOT_EXPORT/);

  const importedDataRoot = path.join(f.base, 'imported-data');
  const importedProject = path.join(f.base, 'imported-project');
  const importedStore = new UnifiedDataStore(importedDataRoot);
  const importedOperations = createRuntimeDataOperations(importedStore);
  t.after(async () => { await importedOperations.close(); importedStore.close(); });
  const restored = await importedOperations({ operation: 'import_project', input: { source: archive, root: importedProject, idempotencyKey: 'replay-import' } });
  assert.equal(restored.projectId, accepted.projectId);
  assert.deepEqual((await importedOperations({ operation: 'read_roadmap', input: { root: importedProject } })).nodes, accepted.nodes);
  assert.deepEqual(Buffer.from(importedStore.read(asset.objectId, 1).data.content.data, 'base64'), original);
  assert.deepEqual(Buffer.from(importedStore.read(asset.objectId).data.content.data, 'base64'), latest);
  assert.deepEqual(importedStore.rows('SELECT relation,target_id FROM relations WHERE source_id=?', [asset.objectId]).map(row => ({ ...row })), [{ relation: 'evidence', target_id: evidence.objectId }]);
  assert.equal(importedStore.search({ scope: accepted.projectId, query: 'project-history-marker' }).items.length, 1);
  assert.equal(importedStore.search({ scope: accepted.projectId, query: 'FOREIGN_PROJECT_PRIVATE_MARKER' }).items.length, 0);
  assert.equal(importedStore.rows("SELECT COUNT(*) AS count FROM settings WHERE namespace='telegram'")[0].count, 0);
  assert.deepEqual(await importedOperations({ operation: 'import_project', input: { source: archive, root: importedProject, idempotencyKey: 'replay-import' } }), restored);
  const later = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'portable-later-asset', data: { name: 'later.txt', origin: 'package7', content: 'NEW_ARCHIVE_ONLY' } });
  const newerArchive = path.join(f.dataRoot, 'exports', 'project-v2.solomap-project.json');
  await f.call('export_project', { root: f.project, destination: newerArchive, idempotencyKey: 'portable-export-v2' });
  await assert.rejects(importedOperations({ operation: 'import_project', input: { source: newerArchive, root: importedProject, idempotencyKey: 'different-import' } }), /project_import_identity_exists/);
  assert.throws(() => importedStore.read(later.objectId), /object_missing/);
});

test('a self-hashed archive cannot inject a second project', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const archivePath = path.join(f.dataRoot, 'exports', 'valid.json');
  await f.call('export_project', { root: f.project, destination: archivePath, idempotencyKey: 'scope-export' });
  const envelope = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const projectTable = envelope.archive.tables.find(table => table.name === 'projects');
  const objectTable = envelope.archive.tables.find(table => table.name === 'objects');
  projectTable.rows.push({ ...projectTable.rows[0], id: '00000000-0000-4000-8000-000000000099', name: 'FOREIGN_INJECTED' });
  objectTable.rows.push({ ...objectTable.rows.find(row => row.id === envelope.archive.projectId), id: '00000000-0000-4000-8000-000000000099' });
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
    ? '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}' : JSON.stringify(value);
  envelope.sha256 = crypto.createHash('sha256').update(canonical(envelope.archive)).digest('hex');
  const injected = path.join(f.dataRoot, 'exports', 'injected.json'); fs.writeFileSync(injected, canonical(envelope));
  const target = new UnifiedDataStore(path.join(f.base, 'scope-target'));
  t.after(() => target.close());
  await assert.rejects(target.importProject({ source: injected, root: path.join(f.base, 'scope-project'), idempotencyKey: 'injected-import' }), /project_archive_scope_invalid/);
  assert.equal(target.rows("SELECT COUNT(*) AS count FROM projects WHERE name='FOREIGN_INJECTED'")[0].count, 0);
});

test('a plain text UUID cannot make unrelated content reachable in a self-hashed archive', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const archivePath = path.join(f.dataRoot, 'exports', 'plain-reference-valid.json');
  await f.call('export_project', { root: f.project, destination: archivePath, idempotencyKey: 'plain-reference-export' });
  const envelope = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const contentTable = envelope.archive.tables.find(table => table.name === 'contents');
  const injectedId = crypto.randomUUID(), marker = Buffer.from('UNRELATED_CONTENT_INJECTION');
  contentTable.rows.push({ ...contentTable.rows[0], id: injectedId, sha256: crypto.createHash('sha256').update(marker).digest('hex'), byte_length: marker.length,
    stored_byte_length: marker.length, encoding: 'utf8', mime_type: 'text/plain', data: { bytes: marker.toString('base64') }, chunk_index_json: null });
  envelope.archive.tables.find(table => table.name === 'projects').rows[0].name = injectedId;
  envelope.sha256 = crypto.createHash('sha256').update(canonicalJson(envelope.archive)).digest('hex');
  const injectedPath = path.join(f.dataRoot, 'exports', 'plain-reference-injected.json');
  fs.writeFileSync(injectedPath, canonicalJson(envelope));
  const target = new UnifiedDataStore(path.join(f.base, 'plain-reference-target'));
  t.after(() => target.close());
  await assert.rejects(target.importProject({ source: injectedPath, root: path.join(f.base, 'plain-reference-project'), idempotencyKey: 'plain-reference-import' }), /project_archive_unreachable_row:contents/);
});

test('ordinary project JSON cannot pull another project content into its archive', async t => {
  const f = fixture(t), first = await f.call('accept_roadmap_csv', { root: f.project });
  const foreignRoot = path.join(f.base, 'foreign-content-project'); fs.mkdirSync(path.join(foreignRoot, '.solopreneur'), { recursive: true });
  fs.copyFileSync(f.csvPath, path.join(foreignRoot, '.solopreneur', 'roadmap.csv'));
  const foreign = await f.call('accept_roadmap_csv', { root: foreignRoot });
  const foreignAsset = f.store.write({ kind: 'asset', action: 'create', scope: foreign.projectId, idempotencyKey: 'foreign-secret-asset', data: { name: 'secret.txt', origin: 'foreign', content: 'FOREIGN_SECRET_BYTES' } });
  const foreignContentId = String(f.store.rows('SELECT content_id FROM assets WHERE id=?', [foreignAsset.objectId])[0].content_id);
  f.store.write({ kind: 'asset', action: 'create', scope: first.projectId, idempotencyKey: 'ordinary-json-reference', data: { name: 'ordinary.json', origin: 'first', content: JSON.stringify({ contentId: foreignContentId }) } });
  const archive = path.join(f.dataRoot, 'exports', 'no-cross-project-content.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'no-cross-project-content' });
  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8'));
  assert.equal(envelope.archive.tables.find(table => table.name === 'contents').rows.some(row => row.id === foreignContentId), false);
  assert.doesNotMatch(fs.readFileSync(archive, 'utf8'), /FOREIGN_SECRET_BYTES/);
});

test('a self-hashed archive cannot hide bytes in an extra content chunk', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'chunk-validation-asset', data: { name: 'large.bin', origin: 'package7', content: { encoding: 'base64', data: Buffer.alloc(1024 * 1024 + 3, 0x71).toString('base64'), mimeType: 'application/octet-stream' } } });
  const archive = path.join(f.dataRoot, 'exports', 'chunk-valid.json'); await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'chunk-validation-export' });
  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8')), contents = envelope.archive.tables.find(table => table.name === 'contents').rows;
  const chunks = envelope.archive.tables.find(table => table.name === 'content_chunks').rows, injected = structuredClone(chunks[0]);
  injected.content_id = contents.find(row => !String(row.encoding).startsWith('chunked:')).id; injected.ordinal = 0; injected.data = { bytes: Buffer.from('HIDDEN').toString('base64') };
  chunks.push(injected); envelope.sha256 = crypto.createHash('sha256').update(canonicalJson(envelope.archive)).digest('hex');
  const source = path.join(f.dataRoot, 'exports', 'chunk-injected.json'); fs.writeFileSync(source, canonicalJson(envelope));
  const target = new UnifiedDataStore(path.join(f.base, 'chunk-target')); t.after(() => target.close());
  await assert.rejects(target.importProject({ source, root: path.join(f.base, 'chunk-project'), idempotencyKey: 'chunk-import' }), /project_archive_content_invalid/);
});

test('a self-hashed archive cannot turn a portable roadmap projection into another side effect', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-portable-effect'); };
  await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes.map(node => node.id === '1' ? { ...node, title: '待投影' } : node), idempotencyKey: 'portable-effect-pending' });
  f.store.deliverRoadmapProjection = deliver;
  const archive = path.join(f.dataRoot, 'exports', 'effect-valid.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'effect-export' });
  const valid = JSON.parse(fs.readFileSync(archive, 'utf8'));
  const mutations = [
    row => { row.channel = 'file_export'; },
    row => { row.state = 'delivered'; },
    row => { row.destination_ref = `solomap://project/${accepted.projectId}/../outside`; }
  ];
  for (let index = 0; index < mutations.length; index++) {
    const envelope = structuredClone(valid), row = envelope.archive.tables.find(table => table.name === 'outbox').rows[0];
    mutations[index](row); envelope.sha256 = crypto.createHash('sha256').update(canonicalJson(envelope.archive)).digest('hex');
    const source = path.join(f.dataRoot, 'exports', `effect-injected-${index}.json`); fs.writeFileSync(source, canonicalJson(envelope));
    const target = new UnifiedDataStore(path.join(f.base, `effect-target-${index}`)); t.after(() => target.close());
    await assert.rejects(target.importProject({ source, root: path.join(f.base, `effect-project-${index}`), idempotencyKey: `effect-import-${index}` }), /project_archive_scope_invalid/);
  }
});

test('project import deduplicates matching small and chunked content without colliding actor request keys', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const small = 'SHARED_SMALL_CONTENT', large = Buffer.alloc(1024 * 1024 + 113, 0x4c);
  const sourceSmall = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'same-request-key', data: { name: 'source-small.txt', origin: 'source', content: small } });
  const sourceLarge = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'source-large', data: { name: 'source-large.bin', origin: 'source', content: { encoding: 'base64', data: large.toString('base64'), mimeType: 'application/octet-stream' } } });
  const archive = path.join(f.dataRoot, 'exports', 'dedupe.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'dedupe-export' });

  const targetData = path.join(f.base, 'dedupe-target-data'), targetProject = path.join(f.base, 'dedupe-existing-project');
  fs.mkdirSync(path.join(targetProject, '.solopreneur'), { recursive: true });
  fs.copyFileSync(f.csvPath, path.join(targetProject, '.solopreneur', 'roadmap.csv'));
  const target = new UnifiedDataStore(targetData); t.after(() => target.close());
  const other = await target.acceptRoadmapCsv({ root: targetProject });
  target.write({ kind: 'asset', action: 'create', scope: other.projectId, idempotencyKey: 'same-request-key', data: { name: 'target-small.txt', origin: 'target', content: small } });
  target.write({ kind: 'asset', action: 'create', scope: other.projectId, idempotencyKey: 'target-large', data: { name: 'target-large.bin', origin: 'target', content: { encoding: 'base64', data: large.toString('base64'), mimeType: 'application/octet-stream' } } });
  const blocked = path.join(targetData, 'exports', 'blocked-target-effect.txt'); fs.mkdirSync(path.dirname(blocked), { recursive: true }); fs.writeFileSync(blocked, 'occupied');
  await assert.rejects(target.export({ ref: other.projectId, format: 'json', destination: blocked, idempotencyKey: 'unrelated-pending-export' }), /EEXIST/);
  const imported = await target.importProject({ source: archive, root: path.join(f.base, 'dedupe-imported-project'), idempotencyKey: 'dedupe-import' });
  assert.equal(imported.projectId, accepted.projectId);
  assert.equal(target.read(sourceSmall.objectId).data.content, small);
  assert.deepEqual(Buffer.from(target.read(sourceLarge.objectId).data.content.data, 'base64'), large);
  assert.equal(target.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 2);
  assert.equal(target.rows("SELECT COUNT(*) AS count FROM outbox WHERE channel='file_export' AND state='pending'")[0].count, 1);
});

test('project import resumes exact crash residue but cleans a caught pre-transaction failure', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const archive = path.join(f.dataRoot, 'exports', 'resumable.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'resumable-export' });

  const resumeStore = new UnifiedDataStore(path.join(f.base, 'resume-data'));
  t.after(() => resumeStore.close());
  const resumeRoot = path.join(f.base, 'resume-project'), control = path.join(resumeRoot, '.solopreneur');
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: accepted.projectId }) + '\n');
  fs.copyFileSync(f.csvPath, path.join(control, 'roadmap.csv'));
  const resumed = await resumeStore.importProject({ source: archive, root: resumeRoot, idempotencyKey: 'resume-import' });
  assert.equal(resumed.projectId, accepted.projectId);

  const retryStore = new UnifiedDataStore(path.join(f.base, 'retry-import-data'));
  t.after(() => retryStore.close());
  const retryRoot = path.join(f.base, 'retry-import-project'), run = retryStore.db.run.bind(retryStore.db);
  let fail = true;
  retryStore.db.run = (sql, values) => { if (fail && sql === 'PRAGMA foreign_keys=OFF') { fail = false; throw new Error('injected_import_begin_failure'); } return run(sql, values); };
  await assert.rejects(retryStore.importProject({ source: archive, root: retryRoot, idempotencyKey: 'retry-import' }), /injected_import_begin_failure/);
  assert.equal(fs.existsSync(path.join(retryRoot, '.solopreneur', 'project.json')), false);
  assert.equal(fs.existsSync(path.join(retryRoot, '.solopreneur', 'roadmap.csv')), false);
  retryStore.db.run = run;
  assert.equal((await retryStore.importProject({ source: archive, root: retryRoot, idempotencyKey: 'retry-import' })).projectId, accepted.projectId);
});

test('project import resumes either single matching crash file only for its durable pending request', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const archive = path.join(f.dataRoot, 'exports', 'single-file-resume.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'single-file-resume-export' });
  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8'));
  const state = envelope.archive.tables.find(table => table.name === 'roadmap_file_states').rows.find(row => row.project_id === accepted.projectId);
  const roadmapContent = envelope.archive.tables.find(table => table.name === 'contents').rows.find(row => row.id === state.accepted_content_id);
  const roadmapBytes = Buffer.from(roadmapContent.data.bytes, 'base64');
  for (const existing of ['identity', 'roadmap']) {
    const target = new UnifiedDataStore(path.join(f.base, `single-${existing}-data`)); t.after(() => target.close());
    const root = path.join(f.base, `single-${existing}-project`), control = path.join(root, '.solopreneur'), key = `single-${existing}`;
    fs.mkdirSync(control, { recursive: true });
    if (existing === 'identity') fs.writeFileSync(path.join(control, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: accepted.projectId }) + '\n');
    else fs.writeFileSync(path.join(control, 'roadmap.csv'), roadmapBytes);
    const inputHash = crypto.createHash('sha256').update(canonicalJson({ sourceHash: envelope.sha256, root: path.resolve(root) })).digest('hex');
    target.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [target.actorId, `project-import:${key}`, crypto.randomUUID(), inputHash, 'pending']);
    const result = await target.importProject({ source: archive, root, idempotencyKey: key });
    assert.equal(result.projectId, accepted.projectId);
    assert.equal(fs.existsSync(path.join(control, 'project.json')), true);
    assert.equal(fs.existsSync(path.join(control, 'roadmap.csv')), true);
  }
});

test('project import rejects a symlinked control directory and an invalid portable project identity before writing', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const archive = path.join(f.dataRoot, 'exports', 'boundary.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'boundary-export' });
  const target = new UnifiedDataStore(path.join(f.base, 'boundary-data'));
  t.after(() => target.close());
  const project = path.join(f.base, 'symlink-project'), outside = path.join(f.base, 'outside-control');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(project, '.solopreneur'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(target.importProject({ source: archive, root: project, idempotencyKey: 'symlink-import' }), /project_import_target_invalid/);
  assert.deepEqual(fs.readdirSync(outside), []);

  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8')), originalId = envelope.archive.projectId;
  const invalidArchive = JSON.parse(JSON.stringify(envelope).split(originalId).join('not-a-uuid'));
  invalidArchive.sha256 = crypto.createHash('sha256').update(canonicalJson(invalidArchive.archive)).digest('hex');
  const invalidPath = path.join(f.dataRoot, 'exports', 'invalid-project-id.json');
  fs.writeFileSync(invalidPath, canonicalJson(invalidArchive));
  await assert.rejects(target.importProject({ source: invalidPath, root: path.join(f.base, 'invalid-id-project'), idempotencyKey: 'invalid-id-import' }), /project_archive_invalid/);
  assert.equal(target.rows("SELECT COUNT(*) AS count FROM projects WHERE id='not-a-uuid'")[0].count, 0);
});

test('project import pins the control directory while creating identity and roadmap files', async t => {
  const f = fixture(t); await f.call('accept_roadmap_csv', { root: f.project });
  const archive = path.join(f.dataRoot, 'exports', 'import-race.json');
  await f.store.exportProject({ root: f.project, destination: archive, idempotencyKey: 'import-race-export' });
  const target = new UnifiedDataStore(path.join(f.base, 'import-race-data')); t.after(() => target.close());
  const root = path.join(f.base, 'import-race-project'), control = path.join(root, '.solopreneur');
  const moved = path.join(root, '.solopreneur-original'), outside = path.join(f.base, 'import-race-outside');
  fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(outside);
  const writeFile = fs.writeFileSync;
  let swapped = false;
  fs.writeFileSync = (file, ...args) => {
    if (!swapped && typeof file === 'number') {
      swapped = true; fs.renameSync(control, moved); fs.symlinkSync(outside, control, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return writeFile(file, ...args);
  };
  try { await assert.rejects(target.importProject({ source: archive, root, idempotencyKey: 'import-parent-race' }), /project_import_target_invalid|export_destination_symlink/); }
  finally { fs.writeFileSync = writeFile; }
  assert.equal(swapped, true); assert.deepEqual(fs.readdirSync(outside), []); assert.deepEqual(fs.readdirSync(moved), []);
  assert.equal(target.rows('SELECT COUNT(*) AS count FROM projects')[0].count, 0);
});

test('portable export excludes host-local pending file exports while retaining importable history', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const asset = f.store.write({ kind: 'asset', action: 'create', scope: accepted.projectId, idempotencyKey: 'pending-file-export-asset', data: { name: 'pending.txt', origin: 'package7', content: 'PENDING_EXPORT' } });
  const localDestination = path.join(f.dataRoot, 'exports', 'blocked.txt');
  fs.mkdirSync(path.dirname(localDestination), { recursive: true }); fs.writeFileSync(localDestination, 'BLOCK');
  await assert.rejects(f.store.export({ ref: asset.objectId, format: 'text', destination: localDestination, idempotencyKey: 'pending-local-export' }), /EEXIST/);
  assert.equal(f.store.rows("SELECT COUNT(*) AS count FROM outbox WHERE channel='file_export' AND state='pending'")[0].count, 1);
  const archive = path.join(f.dataRoot, 'exports', 'without-local-effect.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'without-local-effect' });
  const target = new UnifiedDataStore(path.join(f.base, 'without-local-effect-data'));
  t.after(() => target.close());
  const imported = await target.importProject({ source: archive, root: path.join(f.base, 'without-local-effect-project'), idempotencyKey: 'without-local-effect-import' });
  assert.equal(imported.projectId, accepted.projectId);
  assert.equal(target.rows("SELECT COUNT(*) AS count FROM outbox WHERE channel='file_export'")[0].count, 0);
});

test('an imported project rebinds and delivers its pending roadmap projection', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const deliver = f.store.deliverRoadmapProjection.bind(f.store); f.store.deliverRoadmapProjection = async () => { throw new Error('pause-export-projection'); };
  await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes.map(node => node.id === '1' ? { ...node, title: '迁入后投影' } : node), idempotencyKey: 'pending-export' });
  f.store.deliverRoadmapProjection = deliver;
  const archive = path.join(f.dataRoot, 'exports', 'pending.json'); await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'pending-archive' });
  const targetStore = new UnifiedDataStore(path.join(f.base, 'pending-target-data')), targetOperations = createRuntimeDataOperations(targetStore), targetProject = path.join(f.base, 'pending-target-project');
  t.after(async () => { await targetOperations.close(); targetStore.close(); });
  const imported = await targetOperations({ operation: 'import_project', input: { source: archive, root: targetProject, idempotencyKey: 'pending-import' } });
  assert.match(fs.readFileSync(path.join(targetProject, '.solopreneur', 'roadmap.csv'), 'utf8'), /迁入后投影/);
  assert.equal((await targetOperations({ operation: 'read_roadmap', input: { root: targetProject } })).pending, false);
  assert.deepEqual(await targetOperations({ operation: 'import_project', input: { source: archive, root: targetProject, idempotencyKey: 'pending-import' } }), imported);
  const targetRoadmap = path.join(targetProject, '.solopreneur', 'roadmap.csv');
  const projectedBytes = fs.readFileSync(targetRoadmap);
  fs.writeFileSync(targetRoadmap, fs.readFileSync(f.csvPath));
  await assert.rejects(targetOperations({ operation: 'import_project', input: { source: archive, root: targetProject, idempotencyKey: 'pending-import' } }), /project_import_receipt_target_changed/);
  fs.writeFileSync(targetRoadmap, projectedBytes);
});

test('a pending imported projection stays retryable until the exact effect is delivered', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const sourceDeliver = f.store.deliverRoadmapProjection.bind(f.store);
  f.store.deliverRoadmapProjection = async () => { throw new Error('pause-retryable-import-source'); };
  await f.call('update_roadmap', { root: f.project, expectedRevision: accepted.revision, nodes: accepted.nodes.map(node => node.id === '1' ? { ...node, title: '解除故障后投影' } : node), idempotencyKey: 'retryable-import-source' });
  f.store.deliverRoadmapProjection = sourceDeliver;
  const archive = path.join(f.dataRoot, 'exports', 'retryable-pending.json');
  await f.call('export_project', { root: f.project, destination: archive, idempotencyKey: 'retryable-pending-export' });

  const target = new UnifiedDataStore(path.join(f.base, 'retryable-target-data'));
  const targetProject = path.join(f.base, 'retryable-target-project'), key = 'retryable-pending-import';
  t.after(() => target.close());
  const deliver = target.deliverRoadmapProjection.bind(target);
  target.deliverRoadmapProjection = async () => { throw new Error('hold-target'); };
  await assert.rejects(target.importProject({ source: archive, root: targetProject, idempotencyKey: key }), /project_import_projection_pending:hold-target/);
  await assert.rejects(target.importProject({ source: archive, root: targetProject, idempotencyKey: key }), /project_import_projection_pending:hold-target/);
  assert.equal(target.rows("SELECT status FROM requests WHERE idempotency_key=?", [`project-import:${key}`])[0].status, 'pending');
  assert.doesNotMatch(fs.readFileSync(path.join(targetProject, '.solopreneur', 'roadmap.csv'), 'utf8'), /解除故障后投影/);
  target.deliverRoadmapProjection = deliver;
  const imported = await target.importProject({ source: archive, root: targetProject, idempotencyKey: key });
  assert.equal(imported.projectId, accepted.projectId);
  assert.match(fs.readFileSync(path.join(targetProject, '.solopreneur', 'roadmap.csv'), 'utf8'), /解除故障后投影/);
  assert.equal(target.rows("SELECT status FROM requests WHERE idempotency_key=?", [`project-import:${key}`])[0].status, 'committed');
});

test('an agent reads a formal attachment URI through the same scoped authorization path', async t => {
  const f = fixture(t), accepted = await f.call('accept_roadmap_csv', { root: f.project });
  const attachment = f.store.writeInternalAttachment(accepted.projectId, {
    name: 'agent-input.txt', bytes: Buffer.from('FORMAL_ATTACHMENT_CONTENT').toString('base64'), mimeType: 'text/plain', idempotencyKey: 'formal-attachment'
  });
  const session = await f.call('open_mcp_session', { projectId: accepted.projectId });
  const read = await f.operations({ operation: 'read', sessionToken: session.sessionToken, input: { ref: attachment.ref } });
  assert.equal(read.objectId, attachment.objectId);
  const foreignRoot = path.join(f.base, 'formal-ref-foreign');
  fs.mkdirSync(path.join(foreignRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(foreignRoot, '.solopreneur', 'roadmap.csv'), fs.readFileSync(f.csvPath));
  const foreign = await f.call('accept_roadmap_csv', { root: foreignRoot });
  const foreignSession = await f.call('open_mcp_session', { projectId: foreign.projectId });
  await assert.rejects(f.operations({ operation: 'read', sessionToken: foreignSession.sessionToken, input: { ref: attachment.ref } }), /scope_denied/);
});

test('a host secret survives a cold runtime process without entering the database', async t => {
  const f = fixture(t), secretStore = path.join(f.base, 'host-secrets'), token = `cold-${crypto.randomUUID()}`;
  const previous = process.env.SOLOMAP_TEST_SECRET_STORE; process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  try { await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: token, chatId: '999' }, request => f.call(request.operation, request.input), 'cold-secret'); }
  finally { if (previous === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE; else process.env.SOLOMAP_TEST_SECRET_STORE = previous; }
  const script = `const {UnifiedDataStore}=require(${JSON.stringify(path.join(__dirname, '../out/db/unifiedDataStore.js'))});const {createRuntimeDataOperations}=require(${JSON.stringify(path.join(__dirname, '../out/runtimeDataOperations.js'))});const {refreshTelegramRuntimeConfig}=require(${JSON.stringify(path.join(__dirname, '../out/telegramRuntimeConfig.js'))});(async()=>{const s=UnifiedDataStore.open(process.argv[1]);const o=createRuntimeDataOperations(s);const c=await refreshTelegramRuntimeConfig(process.argv[1],r=>o(r));process.stdout.write(JSON.stringify({enabled:c.enabled,chatId:c.chatId,botToken:c.botToken}));await o.close();s.close()})().catch(e=>{console.error(e);process.exit(1)})`;
  const child = cp.spawnSync(process.execPath, ['-e', script, f.dataRoot], { encoding: 'utf8', env: { ...process.env, SOLOMAP_TEST_SECRET_STORE: secretStore, NODE_TEST_CONTEXT: '' } });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { enabled: true, chatId: '999', botToken: token });
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'solomap.db')).includes(Buffer.from(token)), false);
});

test('a Telegram token remains usable by the runtime while database reads, search and storage expose only its secret reference', async t => {
  const f = fixture(t);
  const token = `package7-secret-${crypto.randomUUID()}`;
  const configured = await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: token, chatId: '4242' }, request => f.call(request.operation, request.input), 'package7-secret-config');
  assert.equal(configured.botToken, token);
  assert.equal((await refreshTelegramRuntimeConfig(f.dataRoot, request => f.call(request.operation, request.input))).botToken, token);
  const stored = f.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'botToken');
  assert.equal(stored.value, undefined);
  assert.equal(stored.secretRef, 'vscode-secret://solopreneur.telegramBotToken');
  assert.equal(f.store.search({ scope: null, query: token }).items.length, 0);
  const fingerprint = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(f.store.search({ scope: null, query: fingerprint }).items.length, 0);
  assert.equal(f.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.some(item => item.key === 'botTokenFingerprint'), false);
  for (const name of ['solomap.db', 'solomap.db-wal', 'solomap.db-shm']) {
    const file = path.join(f.dataRoot, name);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from(token)), false, `${name} must not contain the token`);
  }
});

test('legacy Telegram migration redacts token bytes before capturing source evidence', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package7-legacy-secret-'));
  const dataRoot = path.join(base, '.solomap-global'), secretStore = path.join(base, 'host-secrets');
  const runtime = path.join(dataRoot, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const token = `legacy-secret-${crypto.randomUUID()}`;
  fs.writeFileSync(path.join(runtime, 'telegram-config.json'), JSON.stringify({ enabled: true, botToken: token, chatId: '9898', language: 'zh' }));
  const store = new UnifiedDataStore(dataRoot);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); cleanupExact(base); });
  const previous = process.env.SOLOMAP_TEST_SECRET_STORE; process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  try { importLegacyRuntimeState(store, dataRoot); }
  finally { if (previous === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE; else process.env.SOLOMAP_TEST_SECRET_STORE = previous; }
  const config = await refreshTelegramRuntimeConfig(dataRoot, request => operations(request));
  assert.equal(config.botToken, token);
  const migratedState = store.readHostSettings({ namespace: 'telegram', ownerScope: 'global', secretStateRef: 'vscode-secret://solopreneur.telegramBotToken' }).secretState;
  assert.equal(migratedState.fingerprint, crypto.createHash('sha256').update(token).digest('hex'));
  const repeated = await persistTelegramRuntimeConfig(dataRoot, { botToken: token }, request => operations(request), 'legacy-same-token');
  assert.equal(repeated.bindingGeneration, config.bindingGeneration);
  assert.equal(repeated.replyGeneration, config.replyGeneration);
  assert.deepEqual(repeated.conversationIds, config.conversationIds);
  assert.equal(repeated.offset, config.offset);
  const captured = store.readMigrationSource(`runtime-state:${path.resolve(dataRoot)}`, 'runtime/telegram-config.json');
  assert.equal(captured.bytes.includes(Buffer.from(token)), false);
  assert.match(captured.bytes.toString('utf8'), /botTokenFingerprint/);
  assert.equal(store.search({ scope: null, query: token }).items.length, 0);
  for (const name of ['solomap.db', 'solomap.db-wal', 'solomap.db-shm']) {
    const file = path.join(dataRoot, name);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from(token)), false, `${name} must not contain the legacy token`);
  }
  fs.unlinkSync(path.join(runtime, 'telegram-config.json'));
  const script = `const {UnifiedDataStore}=require(${JSON.stringify(path.join(__dirname, '../out/db/unifiedDataStore.js'))});const {createRuntimeDataOperations}=require(${JSON.stringify(path.join(__dirname, '../out/runtimeDataOperations.js'))});const {refreshTelegramRuntimeConfig}=require(${JSON.stringify(path.join(__dirname, '../out/telegramRuntimeConfig.js'))});(async()=>{const s=UnifiedDataStore.open(process.argv[1]);const o=createRuntimeDataOperations(s);const c=await refreshTelegramRuntimeConfig(process.argv[1],r=>o(r));process.stdout.write(JSON.stringify({enabled:c.enabled,chatId:c.chatId,botToken:c.botToken}));await o.close();s.close()})().catch(e=>{console.error(e);process.exit(1)})`;
  const child = cp.spawnSync(process.execPath, ['-e', script, dataRoot], { encoding: 'utf8', env: { ...process.env, SOLOMAP_TEST_SECRET_STORE: secretStore, NODE_TEST_CONTEXT: '' } });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { enabled: true, chatId: '9898', botToken: token });
});

test('a legacy ordinary Telegram fingerprint setting is migrated out of search on refresh', async t => {
  const f = fixture(t), token = `legacy-fingerprint-${crypto.randomUUID()}`;
  const fingerprint = crypto.createHash('sha256').update(token).digest('hex');
  f.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', patches: [
    { key: 'botToken', expectedRevision: 0, secretRef: 'vscode-secret://solopreneur.telegramBotToken' },
    { key: 'botTokenFingerprint', expectedRevision: 0, value: fingerprint }
  ], idempotencyKey: 'legacy-ordinary-fingerprint' });
  assert.equal(f.store.search({ scope: null, query: fingerprint }).items.length, 1);
  await refreshTelegramRuntimeConfig(f.dataRoot, request => f.call(request.operation, request.input));
  const settings = f.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global', secretStateRef: 'vscode-secret://solopreneur.telegramBotToken' });
  assert.equal(settings.items.some(item => item.key === 'botTokenFingerprint'), false);
  assert.equal(settings.secretState.fingerprint, fingerprint);
  assert.equal(f.store.search({ scope: null, query: fingerprint }).items.length, 0);
});

test('legacy Telegram sources never overwrite a current binding and failed host persistence keeps the old runtime token', async t => {
  const f = fixture(t), secretStore = path.join(f.base, 'current-host-secrets'), oldToken = `current-${crypto.randomUUID()}`, legacyToken = `legacy-${crypto.randomUUID()}`;
  const previous = process.env.SOLOMAP_TEST_SECRET_STORE; process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
  try {
    await persistTelegramRuntimeConfig(f.dataRoot, { enabled: true, botToken: oldToken, chatId: '42' }, request => f.call(request.operation, request.input), 'current-token');
    const runtime = path.join(f.dataRoot, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'telegram-config.json'), JSON.stringify({ enabled: true, botToken: legacyToken, chatId: '1' }));
    importLegacyRuntimeState(f.store, f.dataRoot);
    assert.equal((await refreshTelegramRuntimeConfig(f.dataRoot, request => f.call(request.operation, request.input))).botToken, oldToken);
    assert.equal([...fs.readdirSync(secretStore)].map(name => fs.readFileSync(path.join(secretStore, name), 'utf8'))[0], oldToken);

    const blocked = path.join(f.base, 'blocked-secret-store'); fs.writeFileSync(blocked, 'not-a-directory');
    process.env.SOLOMAP_TEST_SECRET_STORE = blocked;
    await assert.rejects(persistTelegramRuntimeConfig(f.dataRoot, { botToken: 'FAILED_NEW_TOKEN' }, request => f.call(request.operation, request.input), 'failed-token'), /EEXIST|ENOTDIR/);
    process.env.SOLOMAP_TEST_SECRET_STORE = secretStore;
    assert.equal((await refreshTelegramRuntimeConfig(f.dataRoot, request => f.call(request.operation, request.input))).botToken, oldToken);
  } finally { if (previous === undefined) delete process.env.SOLOMAP_TEST_SECRET_STORE; else process.env.SOLOMAP_TEST_SECRET_STORE = previous; }
});
