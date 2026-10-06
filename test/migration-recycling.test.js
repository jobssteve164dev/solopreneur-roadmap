const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { importLegacyIntelligenceConversation } = require('../out/intelligenceConversationData.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

function fixture() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recycling-')), '.solomap-global');
  const id = '047c4416-2fbe-4562-b9b9-29e9e6d536be';
  const file = path.join(root, 'intelligence-conversations', id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ id, title: 'Old chat', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: 'All old content' }, { role: 'assistant', content: 'All old answer' }] });
  fs.writeFileSync(file, original);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  const call = (operation, input = {}) => operations({ operation, input });
  return { root, id, file, original, store, operations, call };
}

test('only fully migrated unchanged files enter an exact approved recycling plan; history remains usable and restorable', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const status = await f.call('migration_overview');
    assert.equal(status.recyclableFiles, 1);
    assert.equal(status.recyclableBytes, Buffer.byteLength(f.original));
    const plan = await f.call('prepare_recycling');
    assert.deepEqual(plan.files.map(file => file.path), [f.file]);
    await assert.rejects(f.call('hold_recycling_file', { itemId: plan.files[0].itemId }), /recycling_confirmation_required/);
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(fs.readFileSync(held.path, 'utf8'), f.original);
    assert.equal((await f.call('read_intelligence_conversation', { id: f.id })).conversation.messages.length, 2);
    const trash = path.join(f.root, 'fixture-system-trash.json');
    fs.renameSync(held.path, trash); // A test-owned stand-in for the native system trash.
    await f.call('finish_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal((await f.call('migration_overview')).recycledFiles, 1);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    fs.writeFileSync(f.file, 'Newer user content');
    await assert.rejects(f.call('restore_recycling_file', { itemId: plan.files[0].itemId }), /restore_target_exists/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'Newer user content');
  } finally { await f.operations.close(); f.store.close(); }
});

test('confirmation cannot recycle changed, mismatched, symlinked, or still used memory sources', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    fs.writeFileSync(f.file, f.original + '\n');
    await assert.rejects(f.call('hold_recycling_file', { itemId: plan.files[0].itemId }), /recycling_source_changed/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original + '\n');
    assert.equal((await f.call('migration_overview')).recyclableFiles, 0);
    fs.renameSync(f.file, f.file + '.retained');
    fs.symlinkSync(f.file + '.retained', f.file);
    assert.equal((await f.call('migration_overview')).recyclableFiles, 0);
    const memory = Buffer.from('Still used by a legacy reader');
    f.store.captureMigrationSource({ identity: path.join(f.root, 'memory'), key: 'profile.md', hash: require('node:crypto').createHash('sha256').update(memory).digest('hex') }, memory);
    assert.equal((await f.call('migration_overview')).recyclableFiles, 0);
    const session = await f.call('register_project', { root: path.dirname(f.root) });
    const identity = await f.call('open_mcp_session', { projectId: session.projectId });
    await assert.rejects(f.operations({ operation: 'prepare_recycling', input: {}, sessionToken: identity.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('held files and interrupted recycling survive owner restart, without creating another plan or losing bytes', async () => {
  const f = fixture();
  let next;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.operations.close(); f.store.close();
    next = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(next);
    try {
      const status = await ops({ operation: 'migration_overview', input: {} });
      assert.equal(status.heldFiles, 1);
      assert.equal(status.recycling[0].itemId, plan.files[0].itemId);
      const retry = await ops({ operation: 'hold_recycling_file', input: { itemId: plan.files[0].itemId } });
      assert.equal(retry.path, held.path);
      await ops({ operation: 'restore_recycling_file', input: { itemId: plan.files[0].itemId } });
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
      assert.equal(fs.existsSync(held.path), false, 'restoration leaves no held duplicate');
    } finally { await ops.close(); }
  } finally { if (next) next.close(); else { await f.operations.close(); f.store.close(); } }
});

test('a crash after native trash but before its acknowledgement can settle without trying to trash a missing file', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    fs.renameSync(held.path, path.join(f.root, 'fixture-crash-trash.json'));
    const recovered = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(recovered.recycled, true);
    assert.equal((await f.call('migration_overview')).recycledFiles, 1);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('the approved recoverable database recycling path works when system trash is unavailable', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.call('retire_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(held.path), false);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('interrupted restore publishes atomically and resumes its own target after owner restart', async () => {
  const f = fixture();
  let reopened;
  const link = fs.promises.link;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.promises.link = async (...args) => { await link(...args); throw new Error('fixture_exit_after_publish'); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_after_publish/);
    fs.promises.link = link;
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(reopened);
    try {
      await ops({ operation: 'restore_recycling_file', input: { itemId } });
      assert.equal(reopened.recyclingItems()[0].status, 'restored');
      assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.json')), false);
      assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.restore')), false);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    } finally { await ops.close(); }
  } finally { fs.promises.link = link; if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('an unrelated identical target is never mistaken for an interrupted restore', async () => {
  const f = fixture();
  const link = fs.promises.link;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.promises.link = async () => { throw new Error('fixture_exit_before_publish'); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_before_publish/);
    fs.promises.link = link;
    fs.writeFileSync(f.file, f.original);
    const inode = fs.statSync(f.file).ino;
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /restore_target_exists/);
    assert.equal(fs.statSync(f.file).ino, inode);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { fs.promises.link = link; await f.operations.close(); f.store.close(); }
});

test('a partial private restore write is recoverable without publishing partial bytes', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.writeFileSync(path.join(f.root, '.migration-recycle', itemId + '.restore.writing'), f.original.slice(0, 17));
    assert.equal(fs.existsSync(f.file), false);
    await f.call('restore_recycling_file', { itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.restore.writing')), false);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a durable restored receipt can finish cleanup after interruption', async () => {
  const f = fixture();
  const unlink = fs.promises.unlink;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    const receipt = path.join(f.root, '.migration-recycle', itemId + '.restore');
    fs.promises.unlink = async file => { if (file === receipt) throw new Error('fixture_exit_after_settle'); return unlink(file); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_after_settle/);
    fs.promises.unlink = unlink;
    assert.equal(f.store.recyclingItems()[0].status, 'restored');
    await f.call('restore_recycling_file', { itemId });
    assert.equal(fs.existsSync(receipt), false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { fs.promises.unlink = unlink; await f.operations.close(); f.store.close(); }
});

test('restoration interrupted before durable completion resumes after reopening the owner', async () => {
  const f = fixture();
  let reopened;
  const settle = f.store.setRecyclingStatus.bind(f.store);
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    f.store.setRecyclingStatus = (id, status, error) => {
      if (status === 'restored') throw new Error('fixture_exit_before_durable_completion');
      return settle(id, status, error);
    };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_before_durable_completion/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(reopened);
    try {
      await ops({ operation: 'restore_recycling_file', input: { itemId } });
      assert.equal(reopened.recyclingItems()[0].status, 'restored');
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    } finally { await ops.close(); }
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});
