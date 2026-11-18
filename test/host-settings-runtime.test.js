const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');

test('actual runtime returns the complete serialized settings batch and its fixed replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-host-settings-runtime-'));
  const setup = new UnifiedDataStore(root);
  const { databaseId } = setup;
  setup.close();
  const domains = await RuntimeDataExecutionDomains.start({root, databaseId});
  t.after(() => domains.close());
  const value = {scheduledTasks: [{title: '完整计划与设置🌿'.repeat(20000)}]};
  const scope = {namespace: 'extension', ownerScope: 'global'};
  const request = {operation: 'patch_host_settings', input: {...scope, idempotencyKey: 'full-settings-result', patches: [
    {key: 'automationTasks', expectedRevision: 0, value}, {key: 'localOnly', expectedRevision: 0, value: true}
  ]}};
  const first = await domains.dispatchSerialized(request);
  const items = JSON.parse(first).items;
  assert.deepEqual(items.map(item => [item.key, item.revision, item.value]),
    [['automationTasks', 1, value], ['localOnly', 1, true]]);
  assert.equal(await domains.dispatchSerialized(request), first);
  assert.deepEqual(await domains.operations({operation:'read_host_settings', input: scope}), JSON.parse(first));
});

test('actual runtime archives an old fingerprint without replacing the current secret state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-host-secret-runtime-'));
  const setup = new UnifiedDataStore(root);
  const { databaseId } = setup;
  const scope = { namespace: 'telegram', ownerScope: 'global' };
  const secretRef = 'test:runtime-secret';
  const legacyFingerprint = 'a'.repeat(64), currentFingerprint = 'b'.repeat(64);
  setup.patchHostSettings({ ...scope, idempotencyKey: 'old-and-current-fingerprint', patches: [
    { key: 'botTokenFingerprint', expectedRevision: 0, value: legacyFingerprint }, { key: 'chatId', expectedRevision: 0, value: 'old-chat' }
  ], secretState: { secretRef, expectedRevision: 0, fingerprint: currentFingerprint } });
  setup.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  t.after(() => domains.close());
  const request = { operation: 'migrate_host_secret_state', input: { ...scope, secretRef, legacyKey: 'botTokenFingerprint', expectedRevision: 1,
    fingerprint: legacyFingerprint, idempotencyKey: 'archive-legacy-fingerprint-runtime' } };
  const migrated = JSON.parse(await domains.dispatchSerialized(request));
  assert.deepEqual(migrated.secretState, { fingerprint: currentFingerprint, revision: 1 });
  assert.deepEqual(migrated.items.map(item => [item.key, item.value]), [['chatId', 'old-chat']]);
  await domains.operations({ operation: 'patch_host_settings', input: { ...scope, idempotencyKey: 'changed-peer-after-archive',
    patches: [{ key: 'chatId', expectedRevision: 1, value: 'new-chat' }] } });
  const replayed = JSON.parse(await domains.dispatchSerialized(request));
  assert.deepEqual(replayed.secretState, migrated.secretState);
  assert.deepEqual(replayed.items.map(item => [item.key, item.value]), [['chatId', 'new-chat']]);
});
