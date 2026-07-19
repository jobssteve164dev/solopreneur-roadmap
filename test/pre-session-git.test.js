const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPreSessionGitCommit } = require('../out/preSessionGit.js');

test('pre-session backup keeps the extension event loop responsive while Git is slow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pre-session-git-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  childProcess.execFileSync('/usr/bin/git', ['init'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'solomap@example.test'], { cwd: root });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'work.txt'), 'change\n');

  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = "status" ]; then sleep 0.2; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
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
    assert.match(await backup, /^[0-9a-f]{40}$/);
  } finally {
    process.env.PATH = previousPath;
  }
});
