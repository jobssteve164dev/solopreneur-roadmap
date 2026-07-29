const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const {
  appendCollaborationIdea,
  buildCollaborationInviteCode,
  collaborationDeviceCredentialSecretKey,
  collaborationRoomsStateKey,
  collaborationRoomSecretsKey,
  createCollaborationLobbySession,
  createCollaborationRoom,
  parseCollaborationInviteCode,
  readOrCreateCollaborationDeviceCredential,
  readCollaborationRooms,
  saveCollaborationRoom
} = require(path.join(projectRoot, 'out', 'collaborationRooms.js'));

function createStorage() {
  const globalValues = new Map();
  const secretValues = new Map();
  return {
    globalValues,
    secretValues,
    context: {
      globalState: {
        get(key) { return globalValues.get(key); },
        update(key, value) { globalValues.set(key, value); return Promise.resolve(); }
      },
      secrets: {
        get(key) { return Promise.resolve(secretValues.get(key)); },
        store(key, value) { secretValues.set(key, value); return Promise.resolve(); }
      }
    }
  };
}

test('collaboration rooms keep metadata in global state and credentials in secret storage', async () => {
  const storage = createStorage();
  const now = Date.now();
  const room = {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    encryptionKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
    authorId: 'author1234567890ABCD',
    nickname: 'Steve',
    title: 'SoloMap · 临时共创',
    projectPath: '/workspace/solomap',
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + 60 * 60 * 1000
  };

  await saveCollaborationRoom(storage.context, room);

  const metadata = storage.globalValues.get(collaborationRoomsStateKey);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].roomId, room.roomId);
  assert.equal(metadata[0].relayToken, undefined);
  assert.equal(metadata[0].encryptionKey, undefined);
  const secrets = JSON.parse(storage.secretValues.get(collaborationRoomSecretsKey));
  assert.equal(secrets[room.roomId].relayToken, room.relayToken);
  assert.equal(secrets[room.roomId].encryptionKey, room.encryptionKey);

  const restored = await readCollaborationRooms(storage.context);
  assert.deepEqual(restored, [room]);
});

test('collaboration invite code is opaque in normal use and round-trips room credentials', () => {
  const room = {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    encryptionKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
  };
  const code = buildCollaborationInviteCode(room);
  assert.match(code, /^SM1\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(code, /https?:|room123|relayToken/);
  assert.deepEqual(parseCollaborationInviteCode(code), room);
  assert.throws(() => parseCollaborationInviteCode('SM1.incomplete'), /invalid_invite_code/);
});

test('anonymous device credentials are registered once and reused from secret storage', async () => {
  const storage = createStorage();
  const issuedCredential = `${'a'.repeat(40)}.${'b'.repeat(40)}`;
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return new Response(JSON.stringify({ ok: true, deviceCredential: issuedCredential }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  assert.equal(await readOrCreateCollaborationDeviceCredential(storage.context, fetcher), issuedCredential);
  assert.equal(await readOrCreateCollaborationDeviceCredential(storage.context, fetcher), issuedCredential);
  assert.equal(requests, 1);
  assert.equal(storage.secretValues.get(collaborationDeviceCredentialSecretKey), issuedCredential);
});

test('room creation falls back from an invalid account grant to the saved anonymous device credential', async () => {
  const storage = createStorage();
  const issuedCredential = `${'a'.repeat(40)}.${'b'.repeat(40)}`;
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({ ok: false }), { status: 401 });
    if (calls.length === 2) {
      return new Response(JSON.stringify({ ok: true, deviceCredential: issuedCredential }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, tier: 'anonymous', expiresAt: Date.now() + 3600000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const result = await createCollaborationRoom(storage.context, {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    expiresAt: Date.now() + 3600000
  }, 'expired-passport-grant', fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.authorization, 'Bearer expired-passport-grant');
  assert.match(calls[1].url, /\/api\/collaboration\/devices$/);
  assert.equal(calls[2].init.headers.authorization, `Device ${issuedCredential}`);
});

test('room creation falls back to the device when the cached account request has a network failure', async () => {
  const storage = createStorage();
  const issuedCredential = `${'a'.repeat(40)}.${'b'.repeat(40)}`;
  storage.secretValues.set(collaborationDeviceCredentialSecretKey, issuedCredential);
  const diagnostics = [];
  let requests = 0;
  const result = await createCollaborationRoom(storage.context, {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    expiresAt: Date.now() + 3600000
  }, 'expired-account-secret', async (_url, init) => {
    requests += 1;
    if (String(init.headers.authorization).startsWith('Bearer ')) throw new Error('socket unavailable');
    return new Response(JSON.stringify({ ok: true, tier: 'anonymous', expiresAt: Date.now() + 3600000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }, (event) => diagnostics.push(event));

  assert.equal(result.ok, true);
  assert.equal(requests, 2);
  assert.deepEqual(diagnostics.map(({ stage, outcome, error }) => ({ stage, outcome, error })), [{
    stage: 'account_create',
    outcome: 'fallback',
    error: 'collaboration_network_error'
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /expired-account-secret|socket unavailable/);
});

test('room creation aborts a stalled request and reports its exact diagnostic stage', async () => {
  const storage = createStorage();
  storage.secretValues.set(collaborationDeviceCredentialSecretKey, `${'a'.repeat(40)}.${'b'.repeat(40)}`);
  const diagnostics = [];
  const startedAt = Date.now();
  await assert.rejects(createCollaborationRoom(storage.context, {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    expiresAt: Date.now() + 3600000
  }, '', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), (event) => diagnostics.push(event), 60), /collaboration_request_timeout/);

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, 'device_create');
  assert.equal(diagnostics[0].outcome, 'failure');
  assert.equal(diagnostics[0].error, 'collaboration_request_timeout');
});

test('an expired anonymous device credential is replaced once before room creation is retried', async () => {
  const storage = createStorage();
  const expiredCredential = `${'x'.repeat(40)}.${'y'.repeat(40)}`;
  const freshCredential = `${'c'.repeat(40)}.${'d'.repeat(40)}`;
  storage.secretValues.set(collaborationDeviceCredentialSecretKey, expiredCredential);
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({ ok: false }), { status: 401 });
    if (calls.length === 2) {
      return new Response(JSON.stringify({ ok: true, deviceCredential: freshCredential }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, tier: 'anonymous' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const result = await createCollaborationRoom(storage.context, {
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    expiresAt: Date.now() + 3600000
  }, '', fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.authorization, `Device ${expiredCredential}`);
  assert.match(calls[1].url, /\/api\/collaboration\/devices$/);
  assert.equal(calls[2].init.headers.authorization, `Device ${freshCredential}`);
  assert.equal(storage.secretValues.get(collaborationDeviceCredentialSecretKey), freshCredential);
});

test('saving a collaboration idea appends without replacing existing project notes', () => {
  const notes = appendCollaborationIdea('Existing project note.', {
    authorName: 'Reviewer',
    text: 'Audit the reconnect path before release.',
    createdAt: Date.parse('2026-07-29T10:00:00.000Z')
  });
  assert.match(notes, /^Existing project note\./);
  assert.match(notes, /临时共创想法/);
  assert.match(notes, /Reviewer/);
  assert.match(notes, /Audit the reconnect path before release\./);
});

test('public lobby sessions require an account grant and never fall back to an anonymous device', async () => {
  assert.deepEqual(await createCollaborationLobbySession('Builder', ''), { ok: false, error: 'login_required' });
  const calls = [];
  const result = await createCollaborationLobbySession('  Builder  ', 'account-grant', async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      ok: true,
      ticket: 'signed-ticket',
      memberId: 'member-id',
      sessionStartedAt: 1000,
      sessionEndsAt: 2000
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/collaboration\/lobby\/session$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer account-grant');
  assert.equal(JSON.parse(calls[0].init.body).nickname, 'Builder');
  assert.equal(result.ok, true);
  assert.equal(result.ticket, 'signed-ticket');
});
