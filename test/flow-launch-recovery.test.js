const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function editor(deliveryPending, failure = false) {
  let source;
  if (process.env.SOLOMAP_TEST_FLOW_BASELINE === '1') {
    const original = require('node:child_process').execFileSync('git', ['show', '470c9a8d4d2c1432dc6ca5a257411b91e77bfeed:src/extension.ts'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    source = require('typescript').transpileModule(original, { compilerOptions: { target: 9, module: 1 } }).outputText;
  } else source = fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8');
  const begin = source.indexOf('async function handleRunFlow(');
  const end = source.indexOf('\nasync function linkSoloConversationToNode(', begin);
  assert.ok(begin >= 0 && end > begin);
  const deliveries = [];
  const flow = { flowId: 'flow-fixture', status: failure ? 'failed' : 'running', loops: [
    { loopId: 'loop-1', index: 1, planner: { executionLogId: 1 }, builder: {}, verifier: {} }
  ] };
  const state = { status: { deliveryPending, nodeId: '__flow__::flow-fixture::loop-1::planner', runKind: 'flow_planner',
    agentCli: 'fixture-agent', status: failure ? 'Failed' : 'Running', failureReason: failure ? 'fixture_cli_unavailable' : '' } };
  const run = vm.runInNewContext(`${source.slice(begin, end)}\nhandleRunFlow`, {
    crypto: require('node:crypto'), activeProjectRoot: '', syncEngine: null,
    getPersistedSettings: () => ({ globalDataPath: '/isolated/global' }), hasFlowModeAccess: async () => true,
    flowStore_1: { readFlowTrace: async () => flow, matchesFlowLaunchIntent: () => true },
    autonomousRuntimeControl_1: { sendRuntimeDataRequest: async (root, request) => {
      assert.equal(root, '/isolated/global'); assert.equal(request.operation, 'read_run_state'); return state;
    } },
    agentRunPreparation_1: { resumePreparedAgentRun: async value => {
      assert.equal(value, state); return { dataRoot: '/isolated/global', finalCommand: 'existing-durable-runner' };
    } },
    runLifecycleClient_1: { runStatusReference: () => 'solomap://run/1' },
    launchAgentConversationTerminal: async input => { deliveries.push(input); }
  });
  return { deliveries, run: () => run({}, 'original goal', '', '', [], {
    workspaceRoot: '/isolated/project', engine: {}, globalDataPath: '/isolated/global', launchIntentId: 'existing-intent'
  }) };
}

test('replaying an accepted Flow resumes its prepared role through the existing editor delivery', async () => {
  const f = editor(true);
  assert.equal(await f.run(), true);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].command, 'existing-durable-runner');
  assert.equal(f.deliveries[0].conversationId, 1);
});

test('an already delivered Flow role is not launched twice and an undeliverable role stays failed', async () => {
  const delivered = editor(false);
  assert.equal(await delivered.run(), true); assert.equal(delivered.deliveries.length, 0);
  const failed = editor(true, true);
  await assert.rejects(failed.run(), /fixture_cli_unavailable/); assert.equal(failed.deliveries.length, 0);
});
