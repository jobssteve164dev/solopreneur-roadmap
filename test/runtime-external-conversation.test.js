const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
const { runtimeProjectMcpSource } = require('../out/runtimeDataOperations.js');

test('an in-flight editor launch stays in the External Worker while unrelated Writer commits continue', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-external-conversation-launch-'));
  const root = path.join(base, 'global');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const bootstrap = new UnifiedDataStore(root);
  await bootstrap.registerProject({ root: projectRoot, name: 'Launch project' });
  const databaseId = bootstrap.databaseId;
  bootstrap.close();
  let releaseLaunch;
  let launchEntered;
  const entered = new Promise(resolve => { launchEntered = resolve; });
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId, dispatchSupervisorOperation: async request => {
    assert.equal(request.operation, 'execute_telegram_editor_command');
    launchEntered();
    await new Promise(resolve => { releaseLaunch = resolve; });
    return { status: 'started' };
  } });
  const source = await runtimeProjectMcpSource(root, projectRoot, undefined, request => domains.dispatch(request));
  try {
    const launching = source.call('start_conversation', {
      project: projectRoot, mode: 'solo', message: 'start without blocking writer', idempotencyKey: 'external-launch-proof'
    });
    await entered;
    const writerResult = await Promise.race([
      domains.dispatch({ operation: 'runtime_write_probe', input: { probeId: 'd67b4d6b-b8b7-4dbf-9537-3988effce2c1' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('writer_blocked_by_editor_launch')), 500))
    ]);
    assert.equal(writerResult.probeId, 'd67b4d6b-b8b7-4dbf-9537-3988effce2c1');
    releaseLaunch();
    assert.equal((await launching).status, 'started');
  } finally {
    releaseLaunch?.();
    await source?.close?.();
    await domains.close();
  }
});

test('a Conversation Worker crash releases its dispatch and restarts without fencing the independent Pi owner', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-external-conversation-crash-'));
  const root = path.join(base, 'global');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const bootstrap = new UnifiedDataStore(root);
  await bootstrap.registerProject({ root: projectRoot, name: 'Crash handoff project' });
  const databaseId = bootstrap.databaseId;
  bootstrap.close();
  let releaseFirst;
  let firstEntered;
  let calls = 0;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const domains = await RuntimeDataExecutionDomains.start({
    root, databaseId,
    runtime: { runtimeId: 'external-crash-runtime', releaseVersion: '0.0.639', buildId: 'external-crash-test' },
    dispatchSupervisorOperation: async request => {
      assert.equal(request.operation, 'execute_telegram_editor_command');
      calls += 1;
      if (calls === 1) {
        firstEntered();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      return { status: 'started' };
    }
  });
  const source = await runtimeProjectMcpSource(root, projectRoot, undefined, request => domains.dispatch(request));
  try {
    const ownerBefore = UnifiedDataStore.openReadOnly(root, databaseId);
    const generationBefore = ownerBefore.currentPiExecutionOwner().generation;
    ownerBefore.close();
    const launching = source.call('start_conversation', {
      project: projectRoot, mode: 'solo', message: 'crash this worker', idempotencyKey: 'external-crash-first'
    });
    await entered;
    await domains.conversation.worker.terminate();
    releaseFirst?.();
    await assert.rejects(launching, /runtime_data_domain_exited:external-worker/);

    const deadline = Date.now() + 5_000;
    let generationAfter = generationBefore;
    for (;;) {
      const check = UnifiedDataStore.openReadOnly(root, databaseId);
      const dispatches = Number(check.rows('SELECT COUNT(*) AS count FROM mcp_conversation_dispatches')[0].count);
      generationAfter = check.currentPiExecutionOwner().generation;
      check.close();
      if (dispatches === 0) break;
      assert.ok(Date.now() < deadline, 'Conversation Worker dispatch cleanup must finish');
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    let restarted;
    for (;;) {
      try {
        restarted = await source.call('start_conversation', {
          project: projectRoot, mode: 'solo', message: 'restart succeeds', idempotencyKey: 'external-crash-second'
        });
        break;
      } catch (error) {
        if (!/runtime_data_domain_unavailable:external-worker/.test(String(error)) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal(restarted.status, 'started');
    assert.equal(generationAfter, generationBefore);
  } finally {
    releaseFirst?.();
    await source?.close?.();
    await domains.close();
  }
});
