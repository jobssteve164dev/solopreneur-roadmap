const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPreSessionGitCommit, retainPreSessionGitCommit } = require('../out/preSessionGit.js');

test('pre-session backup keeps the extension event loop responsive while Git is slow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-git-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  childProcess.execFileSync('/usr/bin/git', ['init'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'committed\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'work.txt'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'work.txt'), 'staged\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'work.txt'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'working tree\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
  const wrapper = path.join(bin, 'git');
  const callLog = path.join(root, '.git', 'solomap-test-git-calls');
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "status" ]; then echo status >> ${JSON.stringify(callLog)}; sleep 0.2; fi\nif [ "$1" = "add" ]; then echo add >> ${JSON.stringify(callLog)}; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const headBefore = childProcess.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const statusBefore = childProcess.execFileSync('/usr/bin/git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  try {
    let timerFired = false;
    const timer = new Promise((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 25));
    const backup = createPreSessionGitCommit(root);
    await timer;
    assert.equal(timerFired, true);
    const revision = await backup;
    assert.match(revision, /^[0-9a-f]{40}$/);
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), headBefore,
      'capturing a rollback baseline must not advance the user branch');
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }), statusBefore,
      'capturing a rollback baseline must preserve the user index and worktree state');
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${revision}:work.txt`], { cwd: root, encoding: 'utf8' }), 'working tree\n');
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${revision}:new.txt`], { cwd: root, encoding: 'utf8' }), 'untracked\n');
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['rev-parse', `refs/solomap/backups/${revision}`], { cwd: root, encoding: 'utf8' }).trim(), revision,
      'a dedicated ref must retain the hidden rollback commit for restore and garbage collection');
    assert.deepEqual(fs.readFileSync(callLog, 'utf8').trim().split('\n'), ['add'],
      'the optimized snapshot must scan the worktree once instead of running status before add');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('pre-session backup retains a clean HEAD so later history rewrites cannot discard the rollback baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-clean-git-'));
  childProcess.execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'committed\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'work.txt'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  const head = childProcess.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const revision = await createPreSessionGitCommit(root);

  assert.equal(revision, head);
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['rev-parse', `refs/solomap/backups/${head}`], { cwd: root, encoding: 'utf8' }).trim(), head,
    'even an unchanged baseline needs its own retention ref for durable rollback');
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }), '');
});

test('pre-session backup includes a tracked file even when a later ignore rule matches it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-ignored-git-'));
  childProcess.execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'tracked.env'), 'before\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'tracked.env'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'tracked.env\n');
  fs.writeFileSync(path.join(root, 'tracked.env'), 'rollback must keep this\n');

  const revision = await createPreSessionGitCommit(root);

  assert.match(revision, /^[0-9a-f]{40}$/);
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${revision}:tracked.env`], { cwd: root, encoding: 'utf8' }), 'rollback must keep this\n');
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${revision}:.gitignore`], { cwd: root, encoding: 'utf8' }), 'tracked.env\n');
});

test('identical dirty content reuses one deterministic rollback commit and ref', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-repeat-git-'));
  childProcess.execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'before\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'work.txt'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'same dirty content\n');

  const first = await createPreSessionGitCommit(root);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await createPreSessionGitCommit(root);

  assert.equal(second, first);
  const refs = childProcess.execFileSync('/usr/bin/git', ['for-each-ref', '--format=%(refname)', 'refs/solomap/backups/'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.deepEqual(refs, [`refs/solomap/backups/${first}`]);
});

test('retention replaces a hostile symbolic backup ref without moving its target branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-symbolic-git-'));
  childProcess.execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'baseline\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'work.txt'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  const head = childProcess.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const branch = childProcess.execFileSync('/usr/bin/git', ['symbolic-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  childProcess.execFileSync('/usr/bin/git', ['symbolic-ref', `refs/solomap/backups/${head}`, branch], { cwd: root });

  assert.equal(await retainPreSessionGitCommit(root, head), head);
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['rev-parse', branch], { cwd: root, encoding: 'utf8' }).trim(), head);
  assert.notEqual(childProcess.spawnSync('/usr/bin/git', ['symbolic-ref', '-q', `refs/solomap/backups/${head}`], { cwd: root }).status, 0);
  assert.equal(childProcess.execFileSync('/usr/bin/git', ['rev-parse', `refs/solomap/backups/${head}`], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('retention rejects an invalid or missing existing rollback commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-invalid-git-'));
  childProcess.execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root });
  assert.equal(await retainPreSessionGitCommit(root, 'not-a-hash'), null);
  assert.equal(await retainPreSessionGitCommit(root, '0123456789012345678901234567890123456789'), null);
});
