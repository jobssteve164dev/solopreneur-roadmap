const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

test('global intelligence conversations retain their real scope without inventing a project', () => {
  const store = new UnifiedDataStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-dialog-')), '.solomap-global'));
  try {
    const conversation = store.write({ kind: 'conversation', action: 'create', scope: null, idempotencyKey: 'global-chat', data: { mode: 'intelligence', status: 'active', title: 'Global chat' } });
    const message = store.write({ kind: 'message', action: 'create', scope: null, idempotencyKey: 'global-message', data: { conversation_id: conversation.objectId, sequence: 0, role: 'user', content: 'Actual full message' } });
    assert.equal(store.read(message.objectId).data.content, 'Actual full message');
    assert.equal(store.read(conversation.objectId).projectId, null);
    assert.equal(store.search({ scope: null, kinds: ['project'] }).items.length, 0);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'real-project', data: { name: 'Actual project' } });
    assert.throws(() => store.write({ kind: 'message', action: 'create', scope: project.objectId, idempotencyKey: 'wrong-global-parent', data: { conversation_id: conversation.objectId, sequence: 1, role: 'user', content: 'Must not cross scope' } }), /scope_mismatch/);
  } finally { store.close(); }
});

test('nullable global conversation migration preserves populated V1 project messages, tasks and native bindings', () => {
  const { DatabaseSync } = require('node:sqlite');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-v1-conversation-'));
  const file = path.join(root, 'solomap.db');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'unified-schema-v1.sql'), 'utf8');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys=ON');
  old.exec(sql);
  old.prepare('INSERT INTO schema_migrations VALUES(1,?,1)').run(crypto.createHash('sha256').update(sql).digest('hex'));
  old.exec("INSERT INTO database_meta VALUES('database_id','old-id'); INSERT INTO actors(id,kind) VALUES('local-runtime','runtime'); INSERT INTO objects VALUES('project','project',NULL,1,1,1,NULL); INSERT INTO projects(id,name) VALUES('project','Original project'); INSERT INTO objects VALUES('chat','conversation','project',7,1,2,NULL); INSERT INTO conversations(id,project_id,mode,status,title) VALUES('chat','project','solo','active','Original title');");
  const body = Buffer.from('完整旧正文\n'.repeat(20000));
  old.prepare("INSERT INTO contents VALUES('body',?,'text/plain','utf8',?,?,?,NULL)").run(crypto.createHash('sha256').update(body).digest('hex'), body.length, body.length, body);
  old.exec("INSERT INTO objects VALUES('message','message','project',3,1,2,NULL); INSERT INTO messages(id,project_id,conversation_id,sequence,role,content_id) VALUES('message','project','chat',0,'user','body'); INSERT INTO objects VALUES('task','task','project',2,1,2,NULL); INSERT INTO tasks(id,project_id,conversation_id,original_request_content_id,status) VALUES('task','project','chat','body','active'); INSERT INTO session_bindings VALUES('chat',1,'claude','native-session','confirmed','original-contract',NULL,NULL);");
  old.close();
  const store = new UnifiedDataStore(root);
  const audit = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(store.read('chat').revision, 7);
    assert.equal(store.read('chat').data.title, 'Original title');
    assert.equal(store.read('message').data.content, body.toString());
    assert.equal(store.read('task').data.original_request_content, body.toString());
    assert.equal(audit.prepare('SELECT native_session_id FROM session_bindings').get().native_session_id, 'native-session');
    assert.deepEqual(audit.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(audit.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.throws(() => store.write({ kind: 'message', action: 'create', scope: null, idempotencyKey: 'cross-parent', data: { conversation_id: 'chat', sequence: 1, role: 'user', content: 'Must not cross projects' } }), /scope_mismatch/);
  } finally { audit.close(); store.close(); }
});
