const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { removeOwnedEntry } = require('../scripts/owned-fixture-cleanup.cjs');

const { runtimeOperationDefinition } = require('../out/runtimeOperationRegistry.js');
const runtimeDataOperations = require('../out/runtimeDataOperations.js');

test('Source Git operations have explicit foreground worker contracts', () => {
  assert.deepEqual(runtimeOperationDefinition('read_project_source_snapshot'), {
    operation: 'read_project_source_snapshot',
    domain: 'foreground-command',
    kind: 'query',
    executor: 'git-worker',
    replay: 'safe',
    authority: 'stateless'
  });
  assert.deepEqual(runtimeOperationDefinition('read_project_source_status'), {
    operation: 'read_project_source_status',
    domain: 'git-job',
    kind: 'query',
    executor: 'git-worker',
    replay: 'safe',
    authority: 'stateless'
  });
  for (const operation of ['create_project_branch', 'switch_project_branch']) {
    assert.deepEqual(runtimeOperationDefinition(operation), {
      operation,
      domain: 'foreground-command',
      kind: 'command',
      executor: 'git-worker',
      replay: 'never',
      authority: 'stateless'
    });
  }
});

test('Source snapshot parses bounded local Git facts without changing the repository', async () => {
  assert.equal(typeof runtimeDataOperations.readProjectSourceSnapshot, 'function');
  const calls = [];
  const outputs = new Map([
    ['rev-parse --is-inside-work-tree', 'true\n'],
    ['symbolic-ref --quiet --short HEAD', 'main\n'],
    ['rev-parse --short HEAD', 'abc1234\n'],
    ['for-each-ref --count=201 --sort=-committerdate --format=%(refname:short)%00%(HEAD) refs/heads', 'main\0*\nfeature/source\0 \n']
  ]);
  const snapshot = await runtimeDataOperations.readProjectSourceSnapshot('/repo', async (_root, args) => {
    calls.push(args);
    const key = args.join(' ');
    if (!outputs.has(key)) throw new Error('unexpected_git_call:' + key);
    return outputs.get(key);
  });
  assert.deepEqual(snapshot, {
    available: true,
    currentBranch: 'main',
    detachedHead: '',
    branches: [{ name: 'main', current: true }, { name: 'feature/source', current: false }],
    changedFiles: 0,
    upstream: '',
    ahead: 0,
    behind: 0,
    statusLoaded: false,
    statusError: false,
    unavailableReason: '',
    truncated: false
  });
  assert.equal(calls.some(args => args.includes('switch')), false);
  assert.equal(calls.some(args => args[0] === 'status' || args[0] === 'rev-list'), false, 'core Source facts do not wait for status enhancements');

  const readError = await runtimeDataOperations.readProjectSourceSnapshot('/repo', async () => { throw new Error('git_timeout'); });
  assert.equal(readError.available, false);
  assert.equal(readError.unavailableReason, 'read_error');
  const noRepository = await runtimeDataOperations.readProjectSourceSnapshot('/repo', async () => { throw new Error('fatal: not a git repository'); });
  assert.equal(noRepository.available, false);
  assert.equal(noRepository.unavailableReason, 'not_repository');
});

test('Source status enhancement is a separate bounded Git read', async () => {
  assert.equal(typeof runtimeDataOperations.readProjectSourceStatus, 'function');
  const status = await runtimeDataOperations.readProjectSourceStatus('/repo', async (_root, args) => {
    const key = args.join(' ');
    if (key === 'status --porcelain=v1') return ' M src/a.ts\n?? notes.md\n';
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') return 'origin/main\n';
    if (key === 'rev-list --left-right --count @{upstream}...HEAD') return '2\t3\n';
    throw new Error('unexpected_git_call:' + key);
  });
  assert.deepEqual(status, { changedFiles: 2, upstream: 'origin/main', ahead: 3, behind: 2, statusLoaded: true, statusError: false });
  const failed = await runtimeDataOperations.readProjectSourceStatus('/repo', async () => { throw new Error('git_timeout'); });
  assert.deepEqual(failed, { changedFiles: 0, upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: true });
});

test('ambiguous Source mutation failure is settled by a fresh authoritative read without replay', async () => {
  assert.equal(typeof runtimeDataOperations.confirmProjectSourceMutation, 'function');
  let reads = 0;
  const snapshot = { available: true, currentBranch: 'feature/source', detachedHead: '', branches: [], changedFiles: 0,
    upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: false, truncated: false, unavailableReason: '' };
  const recovered = await runtimeDataOperations.confirmProjectSourceMutation('feature/source', 'action_failed', async () => {
    reads += 1;
    return snapshot;
  });
  assert.deepEqual(recovered, { success: true, recovered: true, snapshot });
  assert.equal(reads, 1);
  const knownFailure = await runtimeDataOperations.confirmProjectSourceMutation('feature/source', 'local_changes', async () => ({ ...snapshot, currentBranch: 'main' }));
  assert.equal(knownFailure.success, false);
  assert.equal(knownFailure.snapshot.currentBranch, 'main');
  assert.equal(runtimeDataOperations.projectSourceMutationSettledError('action_failed', false), 'result_unknown');
  assert.equal(runtimeDataOperations.projectSourceMutationSettledError('action_failed', true), '');
  assert.equal(runtimeDataOperations.projectSourceMutationSettledError('local_changes', false), 'local_changes');
});

test('Source branch mutations pass branch names as argv and return authoritative readback', async () => {
  assert.equal(typeof runtimeDataOperations.createProjectBranch, 'function');
  assert.equal(typeof runtimeDataOperations.switchProjectBranch, 'function');
  const calls = [];
  let currentBranch = 'main';
  const run = async (_root, args) => {
    calls.push(args);
    if (args[0] === 'check-ref-format') return '';
    if (args[0] === 'switch') {
      currentBranch = args[1] === '-c' ? args[2] : args[1];
      return '';
    }
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
    if (args[0] === 'symbolic-ref') return currentBranch + '\n';
    if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
    if (args[0] === 'for-each-ref') return 'feature/source\0*\nmain\0 \n';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('no_upstream');
    throw new Error('unexpected_git_call:' + args.join(' '));
  };
  const created = await runtimeDataOperations.createProjectBranch('/repo', 'feature/source', run);
  assert.equal(created.currentBranch, 'feature/source');
  assert.deepEqual(calls[0], ['check-ref-format', '--branch', 'feature/source']);
  assert.deepEqual(calls[1], ['switch', '-c', 'feature/source']);
  calls.length = 0;
  await runtimeDataOperations.switchProjectBranch('/repo', 'main', run);
  assert.deepEqual(calls[0], ['check-ref-format', '--branch', 'main']);
  assert.deepEqual(calls[1], ['switch', 'main']);

  let readbackFailed = false;
  const unconfirmed = async (_root, args) => {
    if (args[0] === 'check-ref-format' || args[0] === 'switch') return '';
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
    if (args[0] === 'symbolic-ref') return 'feature/unconfirmed\n';
    if (args[0] === 'for-each-ref' && !readbackFailed) {
      readbackFailed = true;
      throw new Error('git_read_failed');
    }
    if (args[0] === 'for-each-ref') return 'feature/unconfirmed\0*\n';
    throw new Error('unexpected_git_call:' + args.join(' '));
  };
  await assert.rejects(
    runtimeDataOperations.switchProjectBranch('/repo', 'feature/unconfirmed', unconfirmed),
    /source_mutation_unconfirmed/
  );
  const recovered = await runtimeDataOperations.confirmProjectSourceMutation(
    'feature/unconfirmed', 'action_failed', () => runtimeDataOperations.readProjectSourceSnapshot('/repo', unconfirmed)
  );
  assert.equal(recovered.success, true, 'a successful command with failed first readback settles only after one fresh authoritative read');
});

test('Source operations follow real Git authority for detached HEAD, bounded branches, and dirty conflicts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-git-'));
  t.after(() => removeOwnedEntry(root, root));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'source-test@solomap.local']);
  git(['config', 'user.name', 'SoloMap Source Test']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'base']);

  const initial = await runtimeDataOperations.readProjectSourceSnapshot(root);
  assert.equal(initial.available, true);
  assert.equal(initial.currentBranch, 'main');

  const created = await runtimeDataOperations.createProjectBranch(root, 'feature/source');
  assert.equal(created.currentBranch, 'feature/source');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'feature\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'feature']);
  await runtimeDataOperations.switchProjectBranch(root, 'main');

  git(['switch', '--detach']);
  const detached = await runtimeDataOperations.readProjectSourceSnapshot(root);
  assert.equal(detached.currentBranch, '');
  assert.match(detached.detachedHead, /^[a-f0-9]+$/);
  await runtimeDataOperations.switchProjectBranch(root, 'main');

  for (let index = 1; index <= 205; index += 1) git(['branch', `fixture-${String(index).padStart(3, '0')}`]);
  const bounded = await runtimeDataOperations.readProjectSourceSnapshot(root);
  assert.equal(bounded.branches.length, 200);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.branches.some(branch => branch.name === 'main' && branch.current), true, 'the current branch stays visible when the list is truncated');

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'local work\n');
  await assert.rejects(runtimeDataOperations.switchProjectBranch(root, 'feature/source'));
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'local work\n');
  assert.equal((await runtimeDataOperations.readProjectSourceSnapshot(root)).currentBranch, 'main');

  const noRepository = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-no-repo-'));
  t.after(() => removeOwnedEntry(noRepository, noRepository));
  const unavailable = await runtimeDataOperations.readProjectSourceSnapshot(noRepository);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.unavailableReason, 'not_repository');
});
