const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');

const { writeCognitiveRuntimeConfig } = require('../out/cognitiveRuntimeConfig.js');
const { runConfiguredPiMainPath } = require('../out/piMainPathRuntime.js');

function git(root, args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('shipped Runtime entry invokes Pi through the configured Agent CLI model pipe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-runtime-'));
  const project = path.join(root, 'project');
  const target = path.join(project, 'runtime.md');
  fs.mkdirSync(project);
  fs.writeFileSync(target, 'before\n');
  writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'gpt-test' });
  const invocations = [];
  const result = await runConfiguredPiMainPath({
    globalDataPath: root,
    request: {
      taskId: 'runtime-entry', projectPath: project, instruction: 'update',
      allowedPaths: ['runtime.md'], commitMessage: 'docs: update', push: false
    },
    runner: async invocation => {
      invocations.push(invocation);
      return JSON.stringify({
        summary: 'updated',
        operations: [{ type: 'replace_text', path: 'runtime.md', oldText: 'before', newText: 'after' }]
      });
    },
    publisher: { publish: async () => ({ commit: 'runtime-commit', pushed: false }) }
  });

  assert.equal(result.engineId.startsWith('pi-agent:agent-cli:codex:gpt-test:'), true);
  assert.equal(invocations[0].command, 'codex');
  assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
});

test('packaged autonomous Runtime process consumes a delivery request through a fake selected Agent CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-process-'));
  const project = path.join(root, 'project');
  const remote = path.join(root, 'remote.git');
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(fakeBin);
  git(root, ['init', '--bare', remote]);
  git(project, ['init']);
  git(project, ['branch', '-m', 'main']);
  git(project, ['config', 'user.name', 'SoloMap Test']);
  git(project, ['config', 'user.email', 'test@solomap.local']);
  git(project, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(project, 'runtime.md'), 'before\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'initial']);
  git(project, ['push', '-u', 'origin', 'main']);
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({summary:'runtime process',operations:[{type:'replace_text',path:'runtime.md',oldText:'before',newText:'after'}]})));\n`);
  fs.chmodSync(fakeCodex, 0o700);
  writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: fakeCodex, model: 'auto' });
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({
    taskId: 'process-entry', projectPath: project, instruction: 'update',
    allowedPaths: ['runtime.md'], commitMessage: 'docs: runtime process', push: true
  }));

  const output = childProcess.execFileSync(process.execPath, [
    path.resolve(__dirname, '..', 'out', 'autonomousRuntimeProcess.js'),
    '--global-data-path', root,
    '--delivery-request-file', requestPath
  ], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const result = JSON.parse(output);

  assert.equal(result.engineId.startsWith('pi-agent:agent-cli:codex:auto:'), true);
  assert.equal(result.pushed, true);
  assert.equal(git(remote, ['show', 'refs/heads/main:runtime.md']), 'after');
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'execution-runtime.json')), false);
});
