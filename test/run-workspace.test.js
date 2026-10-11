const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('workspace evidence preserves project changes and excludes internal or ignored files without writing snapshots', async () => {
  const { snapshotWorkspace, workspaceChanges } = require('../out/runWorkspace.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-workspace-'));
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.solopreneur'));
  fs.writeFileSync(path.join(root, '.gitignore'), '*.secret\n.solopreneur/\n');
  fs.writeFileSync(path.join(root, 'old.txt'), 'before');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'gone');
  fs.writeFileSync(path.join(root, 'ignored.secret'), 'private');
  fs.writeFileSync(path.join(root, '.solopreneur', 'roadmap.csv'), 'user roadmap');
  fs.writeFileSync(path.join(root, '.solopreneur', 'status.json'), 'internal');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'dependency'), 'package');
  const before = await snapshotWorkspace(root);
  assert.deepEqual(Object.keys(before).sort(), ['.gitignore', '.solopreneur/roadmap.csv', 'gone.txt', 'old.txt']);
  fs.writeFileSync(path.join(root, 'old.txt'), 'longer content');
  fs.writeFileSync(path.join(root, 'new 🌿.txt'), 'new');
  fs.writeFileSync(path.join(root, '__proto__'), 'a real user file');
  fs.unlinkSync(path.join(root, 'gone.txt')); // Only this test's newly generated file.
  const after = await snapshotWorkspace(root);
  assert.deepEqual(workspaceChanges(before, after), ['A __proto__', 'A new 🌿.txt', 'D gone.txt', 'M old.txt']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.solopreneur')).sort(), ['roadmap.csv', 'status.json']);
});

test('unversioned workspace evidence applies existing generated-directory exclusions and propagates unavailable roots', async () => {
  const { snapshotWorkspace } = require('../out/runWorkspace.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-workspace-unversioned-'));
  for (const dir of ['out', 'build', '.next', 'src', '.solopreneur', '.git', 'node_modules']) fs.mkdirSync(path.join(root, dir));
  for (const dir of ['out', 'build', '.next', 'src', '.solopreneur', '.git', 'node_modules']) fs.writeFileSync(path.join(root, dir, 'data'), 'body');
  assert.deepEqual(Object.keys(await snapshotWorkspace(root)), ['src/data']);
  await assert.rejects(snapshotWorkspace(path.join(root, 'missing')), /ENOENT/);
});

test('large Git file inventories are read completely rather than bounded by exec maxBuffer', async () => {
  const { snapshotWorkspace } = require('../out/runWorkspace.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-workspace-inventory-'));
  execFileSync('git', ['init', '-q', root]);
  for (let index = 0; index < 5000; index++) fs.writeFileSync(path.join(root, `file-${String(index).padStart(5, '0')}-${'x'.repeat(210)}`), 'body');
  const snapshot = await snapshotWorkspace(root);
  assert.equal(Object.keys(snapshot).length, 5000);
  assert.equal(fs.readdirSync(root).length, 5001);
});

test('sealed Git evidence keeps the editable roadmap and excludes ignored or internal state', async () => {
  const { captureRunGitEvidence, snapshotWorkspace } = require('../out/runWorkspace.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-git-evidence-boundary-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(root, '.solopreneur'));
  fs.writeFileSync(path.join(root, '.solopreneur', 'roadmap.csv'), 'original roadmap');
  fs.writeFileSync(path.join(root, 'ignored.secret'), 'original secret');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.secret\n');
  git('add', '-f', '.solopreneur/roadmap.csv', 'ignored.secret', '.gitignore'); git('commit', '-q', '-m', 'fixture baseline');
  const baseline = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, '.solopreneur', 'roadmap.csv'), 'actual changed user roadmap');
  fs.writeFileSync(path.join(root, 'ignored.secret'), 'private new secret');
  fs.writeFileSync(path.join(root, '.solopreneur', 'agent_status.json'), 'internal state');
  const evidence = await captureRunGitEvidence(root, baseline, await snapshotWorkspace(root));
  assert.equal(evidence.available, true); assert.ok(evidence.patch.includes('actual changed user roadmap'));
  assert.ok(!evidence.patch.includes('private new secret')); assert.ok(!evidence.patch.includes('internal state'));
  assert.equal(Object.hasOwn(evidence.files, 'ignored.secret'), false);
  assert.ok(evidence.files['.solopreneur/roadmap.csv']);
});

test('file fingerprints support a project root alias and reject a file symlink outside the project', async () => {
  const { captureRunGitEvidence, snapshotWorkspace, matchesRunFileEvidence } = require('../out/runWorkspace.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-file-evidence-alias-'));
  const root = path.join(base, 'project'); const alias = path.join(base, 'alias'); fs.mkdirSync(root);
  fs.symlinkSync(root, alias, 'dir'); fs.writeFileSync(path.join(root, 'result.txt'), 'original actual content🌿');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside'); fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'outside-link.txt'));
  const evidence = await captureRunGitEvidence(alias, '', await snapshotWorkspace(alias));
  assert.ok(evidence.files['result.txt']); assert.equal(matchesRunFileEvidence(alias, 'result.txt', evidence.files['result.txt']), true);
  assert.equal(Object.hasOwn(evidence.files, 'outside-link.txt'), false);
});
