const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMigrationSettingsAction } = require('../out/migrationSettingsActions.js');

test('settings cancellation never approves or moves a file; confirmation uses the stored exact file list', async () => {
  const calls = [];
  const files = [{ itemId: 'item', path: '/isolated/old.json', bytes: 42 }];
  const dependencies = { getRoot: () => '/isolated', ready: async () => {}, call: async (_root, operation) => { calls.push(operation); return { files }; }, confirm: async displayed => { assert.deepEqual(displayed, files); return false; }, trash: async () => { throw new Error('must not trash'); } };
  const result = await handleMigrationSettingsAction({ command: 'dataMigration.recycle', planId: 'plan', dataRoot: '/isolated' }, dependencies);
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ['read_recycling_plan']);
});

test('an approved batch launches the Agent for the exact plan; changed roots cannot recycle', async () => {
  const calls = [];
  const files = [{ itemId: 'first', path: '/isolated/old1.json' }, { itemId: 'second', path: '/isolated/old2.json' }];
  const launches = [];
  const dependencies = { getRoot: () => '/isolated', ready: async () => {}, call: async (_root, operation) => { calls.push(operation); if (operation === 'read_recycling_plan') return { files }; if (operation === 'migration_overview') return { jobs: [] }; return {}; }, confirm: async () => true, trash: async () => { throw new Error('must not trash in the webview action'); }, launchAgent: async (kind, targetId) => launches.push({ kind, targetId }) };
  const result = await handleMigrationSettingsAction({ command: 'dataMigration.recycle', planId: 'plan', dataRoot: '/isolated' }, dependencies);
  assert.equal(result.agentStarted, true);
  assert.deepEqual(calls, ['read_recycling_plan', 'confirm_recycling', 'migration_overview']);
  assert.deepEqual(launches, [{ kind: 'recycling_apply', targetId: 'plan' }]);
  calls.length = 0;
  await assert.rejects(handleMigrationSettingsAction({ command: 'dataMigration.recycle', planId: 'plan', dataRoot: '/previous' }, dependencies), /data_location_changed/);
  assert.deepEqual(calls, []);
});

test('delegating migration launches the Agent migration task instead of only reviewing existing jobs', async () => {
  const launches = [];
  const calls = [];
  const dependencies = {
    getRoot: () => '/isolated',
    ready: async () => {},
    call: async (_root, operation) => { calls.push(operation); return { jobs: [] }; },
    confirm: async () => false,
    launchAgent: async (kind, targetId) => launches.push({ kind, targetId })
  };
  const result = await handleMigrationSettingsAction({ command: 'dataMigration.delegate', dataRoot: '/isolated' }, dependencies);
  assert.equal(result.agentStarted, true);
  assert.deepEqual(launches, [{ kind: 'migration_apply', targetId: undefined }]);
  assert.deepEqual(calls, ['migration_overview']);
});
