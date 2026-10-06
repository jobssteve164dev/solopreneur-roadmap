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

test('an approved batch stops and retains the file when native trash fails; changed roots cannot recycle', async () => {
  const calls = [];
  const files = [{ itemId: 'first', path: '/isolated/old1.json' }, { itemId: 'second', path: '/isolated/old2.json' }];
  const dependencies = { getRoot: () => '/isolated', ready: async () => {}, call: async (_root, operation) => { calls.push(operation); if (operation === 'read_recycling_plan') return { files }; if (operation === 'hold_recycling_file') return { path: '/isolated/.migration-recycle/first.json', hash: 'expected' }; if (operation === 'retire_recycling_file') throw new Error('Retained file could not be recycled'); return {}; }, confirm: async () => true, trash: async () => { throw new Error('System trash unavailable'); } };
  await assert.rejects(handleMigrationSettingsAction({ command: 'dataMigration.recycle', planId: 'plan', dataRoot: '/isolated' }, dependencies), /Retained file could not be recycled/);
  assert.deepEqual(calls, ['read_recycling_plan', 'confirm_recycling', 'hold_recycling_file', 'retire_recycling_file']);
  calls.length = 0;
  await assert.rejects(handleMigrationSettingsAction({ command: 'dataMigration.recycle', planId: 'plan', dataRoot: '/previous' }, dependencies), /data_location_changed/);
  assert.deepEqual(calls, []);
});
