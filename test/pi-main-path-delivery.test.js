const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

const { GitMainPathPublisher, PiMainPathDelivery } = require('../out/piMainPathDelivery.js');

function git(root, args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('Pi main path applies its proposal and hands the exact changed paths to Git publishing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-main-'));
  const target = path.join(root, 'docs', 'runtime.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '旧内容\n');
  const publishes = [];
  const runner = new PiMainPathDelivery({
    engine: {
      proposeDelivery: async () => ({
        engineId: 'pi-agent:agent-cli:codex:auto:test', modelPipe: 'codex', summary: '完成文档修改',
        operations: [{ type: 'replace_text', path: 'docs/runtime.md', oldText: '旧内容', newText: '新内容' }]
      })
    },
    publisher: { publish: async input => { publishes.push(input); return { commit: 'abc123', pushed: true }; } }
  });

  const result = await runner.run({
    taskId: 'docs-smoke', projectPath: root, instruction: '修改文档',
    allowedPaths: ['docs/runtime.md'], commitMessage: 'docs: update runtime', push: true
  });

  assert.equal(fs.readFileSync(target, 'utf8'), '新内容\n');
  assert.deepEqual(publishes[0].paths, ['docs/runtime.md']);
  assert.equal(publishes[0].push, true);
  assert.equal(result.commit, 'abc123');
  assert.equal(result.pushed, true);
  assert.equal(result.engineId, 'pi-agent:agent-cli:codex:auto:test');
});

test('Git main-path publishing commits only Pi-owned paths and preserves unrelated staged work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-git-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-remote-'));
  git(remote, ['init', '--bare']);
  git(root, ['init']);
  git(root, ['branch', '-m', 'main']);
  git(root, ['config', 'user.name', 'SoloMap Test']);
  git(root, ['config', 'user.email', 'test@solomap.local']);
  git(root, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(root, 'owned.md'), 'before\n');
  fs.writeFileSync(path.join(root, 'unrelated.md'), 'before\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  git(root, ['push', '-u', 'origin', 'main']);
  const publisher = new GitMainPathPublisher();
  const baseHead = await publisher.prepare({ projectPath: root, paths: ['owned.md'] });
  fs.writeFileSync(path.join(root, 'owned.md'), 'after\n');
  fs.writeFileSync(path.join(root, 'unrelated.md'), 'staged user work\n');
  git(root, ['add', 'unrelated.md']);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho hooked > hook.md\ngit add hook.md\n');
  fs.chmodSync(hook, 0o700);

  const result = await publisher.publish({
    projectPath: root, paths: ['owned.md'], commitMessage: 'docs: owned change', push: false, baseHead
  });

  assert.equal(result.commit, git(root, ['rev-parse', 'HEAD']));
  assert.equal(git(root, ['show', '--format=', '--name-only', 'HEAD']), 'owned.md');
  assert.equal(git(root, ['diff', '--cached', '--name-only']), 'unrelated.md');
  assert.equal(fs.existsSync(path.join(root, 'hook.md')), false);
});

test('Git main-path publishing refuses to push unrelated local commits to main', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ahead-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ahead-remote-'));
  git(remote, ['init', '--bare']);
  git(root, ['init']);
  git(root, ['branch', '-m', 'main']);
  git(root, ['config', 'user.name', 'SoloMap Test']);
  git(root, ['config', 'user.email', 'test@solomap.local']);
  git(root, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(root, 'owned.md'), 'before\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  git(root, ['push', '-u', 'origin', 'main']);
  fs.writeFileSync(path.join(root, 'unrelated.md'), 'local commit\n');
  git(root, ['add', 'unrelated.md']);
  git(root, ['commit', '-m', 'unrelated local commit']);

  await assert.rejects(
    () => new GitMainPathPublisher().prepare({ projectPath: root, paths: ['owned.md'] }),
    /must match origin\/main/i
  );
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), git(root, ['rev-parse', 'HEAD^']));
});

test('Pi main path validates every operation before writing any file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-atomic-'));
  fs.writeFileSync(path.join(root, 'one.md'), 'one\n');
  fs.writeFileSync(path.join(root, 'two.md'), 'two two\n');
  const runner = new PiMainPathDelivery({
    engine: {
      proposeDelivery: async () => ({
        engineId: 'pi', modelPipe: 'codex', summary: 'two edits', operations: [
          { type: 'replace_text', path: 'one.md', oldText: 'one', newText: 'changed' },
          { type: 'replace_text', path: 'two.md', oldText: 'two', newText: 'changed' }
        ]
      })
    },
    publisher: { publish: async () => ({ commit: '', pushed: false }) }
  });

  await assert.rejects(() => runner.run({
    taskId: 'atomic', projectPath: root, instruction: 'edit both',
    allowedPaths: ['one.md', 'two.md'], commitMessage: 'test', push: false
  }), /not unique/i);
  assert.equal(fs.readFileSync(path.join(root, 'one.md'), 'utf8'), 'one\n');
});

test('Pi main path preserves a user edit made while the model is responding', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-concurrent-'));
  const target = path.join(root, 'runtime.md');
  fs.writeFileSync(target, 'before\n');
  const runner = new PiMainPathDelivery({
    engine: {
      proposeDelivery: async () => {
        fs.writeFileSync(target, 'user edit\n');
        return {
          engineId: 'pi', modelPipe: 'codex', summary: 'edit',
          operations: [{ type: 'replace_text', path: 'runtime.md', oldText: 'before', newText: 'after' }]
        };
      }
    },
    publisher: { publish: async () => ({ commit: '', pushed: false }) }
  });

  await assert.rejects(() => runner.run({
    taskId: 'concurrent', projectPath: root, instruction: 'edit',
    allowedPaths: ['runtime.md'], commitMessage: 'test', push: false
  }), /changed while Pi Agent was working/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user edit\n');
});
