const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('version 2 session binding only exposes the confirmed head revision as resumable', () => {
  const identity = require(path.join(projectRoot, 'out', 'sessionIdentity.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-session-identity-'));
  const filePath = path.join(root, 'session.json');
  const createdAt = '2026-09-02T00:00:00.000Z';
  const plannedAt = '2026-09-02T00:00:01.000Z';
  const confirmedAt = '2026-09-02T00:00:02.000Z';

  identity.createSessionBinding(filePath, {
    runId: 'run-41',
    provider: 'claude',
    workspaceRoot: '/workspace/project',
    cliPath: '/usr/local/bin/claude',
    bindingNonce: 'nonce-41',
    method: 'caller_assigned',
    contract: 'official_stable',
    createdAt
  });
  let binding = identity.readSessionBinding(filePath);
  assert.equal(binding.version, 2);
  assert.equal(binding.headRevision, 1);
  assert.equal(binding.resumableRevision, undefined);
  assert.equal(binding.revisions[0].state, 'preparing');
  assert.equal(identity.getResumableSession(filePath), null);

  binding = identity.appendSessionBindingRevision(filePath, 1, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359cc0',
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'planned',
    createdAt: plannedAt,
    evidence: { source: 'official_cli_parameter' }
  });
  assert.equal(binding.headRevision, 2);
  assert.equal(binding.resumableRevision, undefined);
  assert.equal(identity.getResumableSession(filePath), null);

  binding = identity.confirmSessionBinding(
    filePath,
    2,
    '019ecd99-4325-7050-8e71-7def92359cc0',
    confirmedAt,
    { source: 'solomap_turn_started' }
  );
  assert.equal(binding.headRevision, 3);
  assert.equal(binding.resumableRevision, 3);
  assert.deepEqual(identity.getResumableSession(filePath), {
    runId: 'run-41',
    revision: 3,
    sessionId: '019ecd99-4325-7050-8e71-7def92359cc0',
    provider: 'claude',
    workspaceRoot: '/workspace/project',
    cliPath: '/usr/local/bin/claude'
  });

  assert.throws(
    () => identity.appendSessionBindingRevision(filePath, 2, {
      method: 'caller_assigned',
      contract: 'official_stable',
      state: 'unavailable',
      createdAt: confirmedAt,
      errorCode: 'identity_not_observed'
    }),
    (error) => error && error.code === 'identity_index_conflict'
  );
});

test('a non-confirmed head invalidates an older resumable revision without deleting its audit history', () => {
  const identity = require(path.join(projectRoot, 'out', 'sessionIdentity.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-session-supersede-'));
  const filePath = path.join(root, 'session.json');
  identity.createSessionBinding(filePath, {
    runId: 'run-42',
    provider: 'cursor',
    workspaceRoot: '/workspace/project',
    cliPath: '/usr/local/bin/cursor-agent',
    bindingNonce: 'nonce-42',
    method: 'provider_created',
    contract: 'official_stable'
  });
  identity.appendSessionBindingRevision(filePath, 1, {
    sessionId: 'chat-42',
    method: 'provider_created',
    contract: 'official_stable',
    state: 'planned'
  });
  identity.confirmSessionBinding(filePath, 2, 'chat-42');
  const conflicted = identity.appendSessionBindingRevision(filePath, 3, {
    sessionId: 'chat-43',
    supersedesRevision: 3,
    method: 'provider_created',
    contract: 'official_stable',
    state: 'conflict',
    errorCode: 'identity_ambiguous'
  });

  assert.equal(conflicted.headRevision, 4);
  assert.equal(conflicted.resumableRevision, undefined);
  assert.equal(conflicted.revisions.length, 4);
  assert.equal(identity.getResumableSession(filePath), null);
});

test('a binding with a broken revision sequence is never accepted as resumable', () => {
  const identity = require(path.join(projectRoot, 'out', 'sessionIdentity.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-session-revision-chain-'));
  const filePath = path.join(root, 'session.json');
  identity.createSessionBinding(filePath, {
    runId: 'run-43',
    provider: 'claude',
    workspaceRoot: '/workspace/project',
    cliPath: '/usr/local/bin/claude',
    bindingNonce: 'nonce-43',
    method: 'caller_assigned',
    contract: 'official_stable'
  });
  identity.appendSessionBindingRevision(filePath, 1, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359cf0',
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'planned'
  });
  identity.confirmSessionBinding(filePath, 2, '019ecd99-4325-7050-8e71-7def92359cf0');
  const damaged = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  damaged.revisions[1].revision = 1;
  fs.writeFileSync(filePath, JSON.stringify(damaged), 'utf8');

  assert.equal(identity.getResumableSession(filePath), null);
  assert.throws(
    () => identity.readSessionBinding(filePath),
    (error) => error && error.code === 'identity_binding_invalid'
  );
});
