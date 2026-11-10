const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { sendRuntimeDataRequest, sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');
const { createDatabaseGenerationBaseline, captureDatabaseGenerationProof, persistDatabaseGenerationCutover, readDatabaseGenerationReclaimManifest, reclaimDatabaseGeneration, reclaimOrphanedDatabaseGenerations, recoverPendingDatabaseGenerationCutover } = require('../out/databaseGeneration.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

async function launchRuntime(root) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const deadline = Date.now() + 15_000;
  for (;;) {
    assert.equal(child.exitCode, null, stderr);
    assert.ok(Date.now() < deadline, stderr || 'Runtime generation fixture did not become ready');
    try {
      const health = await sendRuntimeControlCommand(root, 'health', { timeoutMs: 1000 });
      if (health.ok && health.status === 'running') break;
    } catch { /* The endpoint file can precede the listening control server. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, stderr: () => stderr };
}

test('an online database generation captures every foreground commit while maintenance builds its baseline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-capture-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const generationId = crypto.randomUUID(), candidateDir = path.join(root, 'database-generations', generationId);
  try {
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'baseline', data: { category: 'inbox', title: 'baseline', status: 'captured', content: 'before' } });
    active.beginDatabaseGenerationCapture();
    const overlap = active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'overlap', data: { category: 'inbox', title: 'captured in baseline and changeset', status: 'captured', content: 'baselineuniqueterm' } });
    await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), active.databaseId);
    active.write({ kind: 'memory', action: 'patch', scope: null, objectId: overlap.objectId, expectedRevision: overlap.revision, idempotencyKey: 'overlap-final', data: { content: 'latestuniqueterm' } });
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'foreground', data: { category: 'inbox', title: 'foreground survives', status: 'captured', content: 'after' } });
    const delta = active.stopDatabaseGenerationCapture();
    const candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    try {
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='captured in baseline and changeset'")[0].count, 1);
      assert.equal(candidate.read(overlap.objectId).data.content, 'baselineuniqueterm');
      assert.equal(candidate.search({ scope: null, query: 'baselineuniqueterm' }).items.some(item => item.objectId === overlap.objectId), true);
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='foreground survives'")[0].count, 0);
      candidate.applyDatabaseGenerationChangeset(delta.changeset, delta.searchObjectIds);
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='captured in baseline and changeset'")[0].count, 1);
      assert.equal(candidate.read(overlap.objectId).data.content, 'latestuniqueterm');
      assert.equal(candidate.search({ scope: null, query: 'latestuniqueterm' }).items.some(item => item.objectId === overlap.objectId), true,
        'session changesets exclude FTS virtual tables, so the explicit touched-object manifest must rebuild the candidate index');
      assert.equal(candidate.search({ scope: null, query: 'baselineuniqueterm' }).items.some(item => item.objectId === overlap.objectId), false,
        'reindexing must replace stale terms instead of retaining the baseline virtual-table row');
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='foreground survives'")[0].count, 1);
      assert.equal(candidate.verifyDatabaseGeneration().integrity, 'ok');
    } finally { candidate.close(); }
  } finally { active.close(); }
});

test('generation replay rebases candidate event sequences without dropping concurrent foreground receipts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-event-rebase-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const generationId = crypto.randomUUID(), candidateDir = path.join(root, 'database-generations', generationId);
  try {
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-baseline',
      data: { category: 'inbox', title: 'event baseline', status: 'captured', content: 'baseline' } });
    const boundary = active.readRuntimeWriterBarrier().committedSequence;
    active.beginDatabaseGenerationCapture();
    await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), active.databaseId);
    const candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    try {
      const imported = candidate.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-import',
        data: { category: 'inbox', title: 'candidate import', status: 'captured', content: 'candidate' } });
      const foreground = active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-foreground',
        data: { category: 'inbox', title: 'foreground event', status: 'captured', content: 'foreground' } });
      const liveSequence = active.readRuntimeWriterBarrier().committedSequence;
      const delta = active.stopDatabaseGenerationCapture();
      candidate.applyDatabaseGenerationChangeset(delta.changeset, delta.searchObjectIds, boundary, liveSequence);
      for (const receipt of [imported, foreground]) {
        const event = candidate.rows('SELECT sequence,request_id FROM events WHERE subject_id=? ORDER BY sequence DESC LIMIT 1', [receipt.objectId])[0];
        assert.ok(event, `event for ${receipt.objectId} must survive generation replay`);
        const request = candidate.rows('SELECT committed_sequence FROM requests WHERE id=?', [event.request_id])[0];
        assert.equal(Number(request.committed_sequence), Number(event.sequence));
      }
      const sequences = candidate.rows('SELECT sequence FROM events').map(row => Number(row.sequence));
      assert.equal(new Set(sequences).size, sequences.length);
    } finally { candidate.close(); }
  } finally { active.close(); }
});

test('startup cutover publishes one fully verified generation and reclaims its completed staging directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-cutover-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  active.beginDatabaseGenerationCapture();
  await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), databaseId);
  active.stopDatabaseGenerationCapture();
  active.close();
  const candidate = UnifiedDataStore.open(candidateDir, databaseId);
  candidate.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'candidate-only', data: { category: 'inbox', title: 'candidate active', status: 'captured', content: 'generation' } });
  candidate.close();
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000001"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'imported-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000001', locationId: '00000000-0000-4000-8000-000000000002', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now(),
    candidateProof: captureDatabaseGenerationProof(path.join(candidateDir, 'solomap.db'))
  });
  const recovered = recoverPendingDatabaseGenerationCutover(root);
  assert.equal(recovered.state, 'complete');
  assert.equal(fs.existsSync(candidateDir), false);
  const activated = UnifiedDataStore.open(root, databaseId);
  try { assert.equal(activated.rows("SELECT COUNT(*) AS count FROM memories WHERE title='candidate active'")[0].count, 1); }
  finally { activated.close(); }
  assert.equal(fs.existsSync(path.join(target, '.solopreneur', 'project.json')), true);
  assert.equal(fs.existsSync(path.join(target, '.solopreneur', 'roadmap.csv')), true);
  const { DiskDatabase } = require('../out/db/diskDatabase.js');
  const originalExec = DiskDatabase.prototype.exec;
  let integrityChecks = 0;
  DiskDatabase.prototype.exec = function(sql) {
    if (/PRAGMA integrity_check/i.test(sql)) integrityChecks += 1;
    return originalExec.call(this, sql);
  };
  try {
    assert.equal(recoverPendingDatabaseGenerationCutover(root), null, 'completed cutover journals leave the startup hot path');
    assert.equal(integrityChecks, 0, 'a completed generation must use its frozen verification proof instead of rescanning the active database');
  } finally { DiskDatabase.prototype.exec = originalExec; }
});

test('cutover does not move the active database when project files cannot be published exactly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-publish-conflict-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'active-only', data: { category: 'inbox', title: 'active remains', status: 'captured', content: 'old generation' } });
  active.close();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  const target = path.join(root, 'conflicting-project', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000031"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  fs.writeFileSync(path.join(target, 'project.json'), '{"conflict":true}\n');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000031', locationId: '00000000-0000-4000-8000-000000000032', identityPath: path.join(target, 'project.json'), roadmapPath: path.join(target, 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });

  assert.throws(() => recoverPendingDatabaseGenerationCutover(root), /database_generation_target_changed/);
  assert.equal(fs.existsSync(path.join(candidateDir, 'previous-solomap.db')), false);
  const reopened = UnifiedDataStore.open(root, databaseId);
  try { assert.equal(reopened.rows("SELECT COUNT(*) AS count FROM memories WHERE title='active remains'")[0].count, 1); }
  finally { reopened.close(); }
});

test('project file publication rolls back a newly published identity when the roadmap conflicts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-roadmap-conflict-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  active.close();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  const target = path.join(root, 'roadmap-conflict-project', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true }); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000041"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title\n');
  fs.writeFileSync(path.join(target, 'roadmap.csv'), 'conflict\n');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000041', locationId: '00000000-0000-4000-8000-000000000042', identityPath: path.join(target, 'project.json'), roadmapPath: path.join(target, 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  assert.throws(() => recoverPendingDatabaseGenerationCutover(root), /database_generation_target_changed/);
  assert.equal(fs.existsSync(path.join(target, 'project.json')), false);
  assert.equal(fs.existsSync(path.join(candidateDir, 'previous-solomap.db')), false);
});

test('startup cutover resumes moving the previous generation sidecars after a crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-old-sidecars-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  active.close();
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000011"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'old-sidecars-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000011', locationId: '00000000-0000-4000-8000-000000000012', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  const previous = path.join(candidateDir, 'previous-solomap.db');
  fs.renameSync(path.join(root, 'solomap.db'), previous);
  fs.writeFileSync(path.join(root, 'solomap.db-wal'), 'old-wal');
  fs.writeFileSync(path.join(root, 'solomap.db-shm'), 'old-shm');

  const recovered = recoverPendingDatabaseGenerationCutover(root);

  assert.equal(recovered.state, 'complete');
  if (fs.existsSync(path.join(root, 'solomap.db-wal'))) assert.notEqual(fs.readFileSync(path.join(root, 'solomap.db-wal'), 'utf8'), 'old-wal');
  if (fs.existsSync(path.join(root, 'solomap.db-shm'))) assert.notEqual(fs.readFileSync(path.join(root, 'solomap.db-shm'), 'utf8'), 'old-shm');
  assert.equal(fs.existsSync(candidateDir), false, 'the verified previous database and sidecars must not accumulate');
});

test('startup cutover resumes activating candidate sidecars after a crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-new-sidecars-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  active.close();
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000021"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'new-sidecars-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'old-moved', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000021', locationId: '00000000-0000-4000-8000-000000000022', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  fs.renameSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'previous-solomap.db'));
  fs.renameSync(path.join(candidateDir, 'solomap.db'), path.join(root, 'solomap.db'));
  fs.writeFileSync(path.join(candidateDir, 'solomap.db-wal'), 'candidate-wal');
  fs.writeFileSync(path.join(candidateDir, 'solomap.db-shm'), 'candidate-shm');

  const recovered = recoverPendingDatabaseGenerationCutover(root);

  assert.equal(recovered.state, 'complete');
  assert.equal(fs.existsSync(candidateDir), false);
});

test('generation reclaim planning returns an exact read-only physical manifest and never selects the active candidate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-reclaim-manifest-'));
  t.after(() => cleanupExact(root));
  const activeId = crypto.randomUUID(), completedId = crypto.randomUUID(), orphanId = crypto.randomUUID();
  const make = id => {
    const directory = path.join(root, 'database-generations', id);
    fs.mkdirSync(path.join(directory, 'project-files', '.solopreneur'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'solomap.db'), id);
    return directory;
  };
  const activeDir = make(activeId), completedDir = make(completedId), orphanDir = make(orphanId);
  const journal = (generationId, candidateDir, state) => ({
    schemaVersion: 1, state, generationId, candidateDir, databaseId: 'database-id',
    result: { projectId: crypto.randomUUID(), locationId: crypto.randomUUID(), identityPath: path.join(root, `${generationId}-project`, '.solopreneur', 'project.json'), roadmapPath: path.join(root, `${generationId}-project`, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(candidateDir, 'project-files', '.solopreneur', 'project.json'),
    hiddenRoadmapPath: path.join(candidateDir, 'project-files', '.solopreneur', 'roadmap.csv'), createdAt: Date.now()
  });
  persistDatabaseGenerationCutover(root, journal(activeId, activeDir, 'ready'));
  fs.writeFileSync(path.join(completedDir, 'cutover-complete.json'), JSON.stringify(journal(completedId, completedDir, 'complete')));

  const manifest = readDatabaseGenerationReclaimManifest(root);

  assert.equal(manifest.activeGenerationId, activeId);
  assert.deepEqual(manifest.entries.map(entry => [entry.generationId, entry.state, entry.reclaimCandidate]), [
    [activeId, 'active', false], [completedId, 'complete', true], [orphanId, 'orphaned', true]
  ].sort((left, right) => left[0].localeCompare(right[0])));
  for (const entry of manifest.entries) {
    assert.equal(entry.safeInventory, true);
    assert.equal(entry.files.some(file => file.path === path.join(entry.directory, 'solomap.db')), true);
    assert.equal(entry.files.every(file => file.path.startsWith(`${entry.directory}${path.sep}`)), true);
    assert.match(entry.files[0].inode, /^\d+$/);
  }
  assert.throws(() => reclaimDatabaseGeneration(root, activeId), /database_generation_reclaim_not_safe/);
  assert.equal(reclaimDatabaseGeneration(root, completedId).files, 2);
  assert.equal(reclaimDatabaseGeneration(root, orphanId).files, 1);
  assert.equal(fs.existsSync(activeDir), true); assert.equal(fs.existsSync(completedDir), false); assert.equal(fs.existsSync(orphanDir), false);
});

test('startup reclaims only manifest-verified orphaned generations left by a hard crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-startup-reclaim-'));
  t.after(() => cleanupExact(root));
  const activeId = crypto.randomUUID(), orphanId = crypto.randomUUID();
  const make = id => {
    const directory = path.join(root, 'database-generations', id);
    fs.mkdirSync(path.join(directory, 'changesets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'solomap.db'), id);
    fs.writeFileSync(path.join(directory, 'changesets', '000000000001.changeset'), 'delta');
    return directory;
  };
  const activeDir = make(activeId), orphanDir = make(orphanId);
  const hidden = path.join(activeDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId: activeId, candidateDir: activeDir, databaseId: 'database-id',
    result: { projectId: crypto.randomUUID(), locationId: crypto.randomUUID(), identityPath: path.join(root, 'project', '.solopreneur', 'project.json'), roadmapPath: path.join(root, 'project', '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });

  const reclaimed = reclaimOrphanedDatabaseGenerations(root);

  assert.deepEqual(reclaimed.map(item => item.generationId), [orphanId]);
  assert.equal(fs.existsSync(activeDir), true, 'the cutover journal protects its active generation');
  assert.equal(fs.existsSync(orphanDir), false, 'the exact orphan inventory is reclaimed during startup');
});

test('Runtime project import builds a generation off-actor, captures concurrent foreground commits, and activates it on restart', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-runtime-e2e-'));
  t.after(() => cleanupExact(base));
  const sourceRoot = path.join(base, 'source-data'), sourceProject = path.join(base, 'source-project');
  const targetRoot = path.join(base, 'target-data', '.solomap-global'), targetProject = path.join(base, 'target-project');
  fs.mkdirSync(path.join(sourceProject, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(sourceProject, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Generation import,,,,codex,,Pending,,'
  ].join('\n'));
  const source = new UnifiedDataStore(sourceRoot), sourceOperations = createRuntimeDataOperations(source);
  const archive = path.join(base, 'source.solomap-project.json');
  try {
    await sourceOperations({ operation: 'accept_roadmap_csv', input: { root: sourceProject } });
    source.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'source-marker',
      data: { category: 'inbox', title: 'generation source marker', status: 'captured', content: 'source generation content' } });
    await sourceOperations({ operation: 'export_project', input: { root: sourceProject, destination: archive, idempotencyKey: 'generation-runtime-export' } });
  } finally { await sourceOperations.close(); source.close(); }

  const target = new UnifiedDataStore(targetRoot); const databaseId = target.databaseId; target.close();
  let runtime = await launchRuntime(targetRoot);
  const committed = [];
  try {
    const importing = sendRuntimeDataRequest(targetRoot, { operation: 'import_project', input: {
      source: archive, root: targetProject, idempotencyKey: 'generation-runtime-import'
    } }).then(() => assert.fail('generation import must hand off through a Runtime restart'), error => error);
    for (let index = 0; index < 24; index++) {
      try {
        const receipt = await sendRuntimeDataRequest(targetRoot, { operation: 'write', input: {
          kind: 'memory', action: 'create', scope: null, idempotencyKey: `generation-foreground-${index}`,
          data: { category: 'inbox', title: `foreground-${index}`, status: 'captured', content: `foreground commit ${index}` }
        } });
        committed.push(receipt.objectId);
      } catch (error) {
        if (!/database_generation_cutover|Invalid Runtime endpoint|ECONNRESET|ECONNREFUSED/.test(String(error?.message || error))) throw error;
        break;
      }
    }
    const importError = await importing;
    assert.match(String(importError.message || importError), /database_generation_cutover|Runtime data service is unavailable|ECONNRESET/);
    const [exitCode] = await once(runtime.child, 'exit');
    assert.equal(exitCode, 75, runtime.stderr());
    assert.ok(committed.length > 0, 'foreground commits must overlap the off-actor generation build');

    runtime = await launchRuntime(targetRoot);
    const replay = await sendRuntimeDataRequest(targetRoot, { operation: 'import_project', input: {
      source: archive, root: targetProject, idempotencyKey: 'generation-runtime-import'
    } });
    assert.ok(replay.projectId);
    assert.equal((await sendRuntimeDataRequest(targetRoot, { operation: 'read_roadmap', input: { root: targetProject } })).nodes.length, 1);
    for (const objectId of committed) {
      const value = await sendRuntimeDataRequest(targetRoot, { operation: 'read', input: { ref: objectId } });
      assert.match(String(value.data.content), /foreground commit/);
    }
    const reopened = UnifiedDataStore.open(targetRoot, databaseId);
    try { assert.equal(reopened.verifyDatabaseGeneration().integrity, 'ok'); }
    finally { reopened.close(); }
  } finally {
    if (runtime.child.exitCode === null) {
      const exited = once(runtime.child, 'exit');
      await sendRuntimeControlCommand(targetRoot, 'stop').catch(() => undefined);
      await exited;
    }
  }
});
