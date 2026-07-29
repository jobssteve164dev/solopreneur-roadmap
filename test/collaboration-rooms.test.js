const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const {
  appendCollaborationIdea,
  buildCollaborationInviteUrl,
  collaborationRoomsStateKey,
  collaborationRoomSecretsKey,
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

test('collaboration invite keeps the encryption key in the URL fragment', () => {
  const url = buildCollaborationInviteUrl({
    roomId: 'room1234567890ABCDEFGH',
    relayToken: 'relayToken1234567890ABCDEFGHijklmnop',
    encryptionKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
  }, 'zh');
  assert.match(url, /^https:\/\/solomap\.app\/zh\/room\//);
  assert.match(url, /\?token=relayToken/);
  assert.match(url, /#abcdefghijklmnopqrstuvwxyzABCDEFGH123456789$/);
  assert.equal(new URL(url).hash.slice(1), 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789');
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
