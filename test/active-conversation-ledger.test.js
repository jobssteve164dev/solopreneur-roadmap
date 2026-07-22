const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claimActiveConversation,
  getActiveConversationMigrationMarkerPath,
  listActiveConversations,
  markActiveConversationMigrationComplete,
  registerActiveConversation,
  releaseActiveConversationLease,
  unregisterActiveConversation
} = require('../out/activeConversationLedger.js');

test('active conversation ledger isolates records and leases processing across instances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-active-ledger-'));
  const globalRoot = path.join(root, '.solomap-global');
  const workspaceA = path.join(root, 'project-a');
  const workspaceB = path.join(root, 'project-b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const statusA = path.join(workspaceA, '.solopreneur', 'agent-status', '7.json');
  const statusB = path.join(workspaceB, '.solopreneur', 'agent-status', '7.json');

  registerActiveConversation({
    workspaceRoot: workspaceA,
    globalDataPath: globalRoot,
    conversationId: 7,
    nodeId: 'solo-conversation',
    statusFilePath: statusA,
    runKind: 'solo',
    ownerInstanceId: 'window-a'
  });
  registerActiveConversation({
    workspaceRoot: workspaceB,
    globalDataPath: globalRoot,
    conversationId: 7,
    nodeId: 'P01',
    statusFilePath: statusB,
    runKind: 'step',
    ownerInstanceId: 'window-b'
  });

  const records = listActiveConversations(workspaceA, globalRoot);
  assert.equal(records.length, 2);
  const recordA = records.find((record) => record.workspaceRoot === workspaceA);
  assert.ok(recordA);
  const leaseA = claimActiveConversation(workspaceA, globalRoot, recordA, 'window-a');
  assert.ok(leaseA);
  assert.equal(claimActiveConversation(workspaceA, globalRoot, recordA, 'window-b'), null);
  releaseActiveConversationLease(leaseA);
  const leaseB = claimActiveConversation(workspaceA, globalRoot, recordA, 'window-b');
  assert.ok(leaseB);
  releaseActiveConversationLease(leaseB);

  assert.equal(unregisterActiveConversation(workspaceA, globalRoot, 7, statusB), false);
  assert.equal(unregisterActiveConversation(workspaceA, globalRoot, 7, statusA), true);
  assert.equal(unregisterActiveConversation(workspaceB, globalRoot, 7, statusB), true);
  assert.equal(listActiveConversations(workspaceA, globalRoot).length, 0);

  markActiveConversationMigrationComplete(workspaceA, globalRoot);
  const markerPath = getActiveConversationMigrationMarkerPath(workspaceA, globalRoot);
  assert.equal(fs.existsSync(markerPath), true);

  fs.unlinkSync(markerPath);
  fs.rmdirSync(path.join(globalRoot, 'active-conversations', 'records'));
  fs.rmdirSync(path.join(globalRoot, 'active-conversations', 'leases'));
  fs.rmdirSync(path.join(globalRoot, 'active-conversations'));
  fs.rmdirSync(globalRoot);
  fs.rmdirSync(workspaceA);
  fs.rmdirSync(workspaceB);
  fs.rmdirSync(root);
});
