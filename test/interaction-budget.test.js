const test = require('node:test');
const assert = require('node:assert/strict');

const { createInteractionBudget, advanceInteractionBudget } = require('../out/interactionBudget.js');

test('interaction budget keeps one monotonic clock on the same boot', () => {
  const budget = createInteractionBudget({ wallMs: 1_000, bootId: 'boot-a', uptimeMs: 50_000, interactionId: 'action-a' });
  const sample = advanceInteractionBudget(budget, { wallMs: 9_000, bootId: 'boot-a', uptimeMs: 54_250 });
  assert.deepEqual(sample, { ...budget, elapsedFloorMs: 4_250, elapsedMs: 4_250, verdict: 'normal', clockTrusted: true });
});

test('interaction budget cannot be reset by a later layer or wall rollback', () => {
  const budget = { ...createInteractionBudget({ wallMs: 10_000, bootId: 'boot-a', uptimeMs: 50_000, interactionId: 'action-b' }), elapsedFloorMs: 7_000 };
  const sameBoot = advanceInteractionBudget(budget, { wallMs: 2_000, bootId: 'boot-a', uptimeMs: 55_000 });
  assert.equal(sameBoot.elapsedMs, 7_000);
  assert.equal(sameBoot.verdict, 'degraded');
  const untrusted = advanceInteractionBudget(budget, { wallMs: 2_000, bootId: 'boot-b', uptimeMs: 1_000 });
  assert.equal(untrusted.elapsedMs, 7_000);
  assert.equal(untrusted.verdict, 'clock_untrusted');
  assert.equal(untrusted.clockTrusted, false);
});

test('interaction budget carries its floor across a verified reboot and fails versions over ten seconds', () => {
  const budget = { ...createInteractionBudget({ wallMs: 1_000, bootId: 'boot-a', uptimeMs: 50_000, interactionId: 'action-c' }), elapsedFloorMs: 4_000 };
  const sample = advanceInteractionBudget(budget, { wallMs: 12_500, bootId: 'boot-b', uptimeMs: 500 });
  assert.equal(sample.elapsedMs, 11_500);
  assert.equal(sample.verdict, 'deadline_exceeded');
  assert.equal(sample.clockTrusted, true);
});

test('interaction budget fails exactly at the ten second release boundary', () => {
  const budget = createInteractionBudget({ wallMs: 1_000, bootId: 'boot-a', uptimeMs: 50_000, interactionId: 'action-boundary' });
  const sample = advanceInteractionBudget(budget, { wallMs: 11_000, bootId: 'boot-a', uptimeMs: 60_000 });
  assert.equal(sample.elapsedMs, 10_000);
  assert.equal(sample.verdict, 'deadline_exceeded');
});

test('an externally accepted conversation keeps its original wall-clock budget when another process dispatches it', () => {
  const { createInteractionBudgetAt, readInteractionClock } = require('../out/interactionBudget.js');
  const clock = readInteractionClock();
  const budget = createInteractionBudgetAt(clock.wallMs - 2_500, 'external-action');
  const sample = advanceInteractionBudget(budget, clock);
  assert.ok(sample.elapsedMs >= 2_400 && sample.elapsedMs <= 2_600, JSON.stringify(sample));
  assert.equal(sample.interactionId, 'external-action');
});

test('provider ingress receipt binds the exact interaction and native turn once', () => {
  const { readInteractionClock } = require('../out/interactionBudget.js');
  const { taskIngressReceiptFields } = require('../out/providerTaskIngress.js');
  const now = readInteractionClock();
  const interactionBudget = createInteractionBudget({ ...now, interactionId: 'action-d' });
  const evidence = { provider: 'codex', kind: 'codex_task_started', nativeTurnId: 'turn-1', sessionId: 'session-1', providerStartedAt: new Date().toISOString() };
  const fields = taskIngressReceiptFields({ interactionBudget }, evidence);
  assert.equal(fields.taskIngressReceipt.interactionId, 'action-d');
  assert.equal(fields.taskIngressReceipt.nativeTurnId, 'turn-1');
  assert.equal(fields.taskIngressReceipt.authority, 'provider_native');
  assert.equal(fields.taskIngressVerdict, 'normal');
  assert.deepEqual(taskIngressReceiptFields({ interactionBudget: fields.interactionBudget, taskIngressReceipt: fields.taskIngressReceipt }, evidence), {});
  assert.deepEqual(taskIngressReceiptFields({ interactionBudget: fields.interactionBudget, taskIngressReceipt: fields.taskIngressReceipt }, { ...evidence, nativeTurnId: 'turn-2' }), {});
});

test('a native Provider receipt replaces an Agent acknowledgement but can never be downgraded by MCP', () => {
  const { taskIngressReceiptFields } = require('../out/providerTaskIngress.js');
  const interactionBudget = createInteractionBudget({ wallMs: Date.now(), bootId: 'boot-a', uptimeMs: 10_000, interactionId: 'action-authority' });
  const acknowledged = taskIngressReceiptFields({ interactionBudget }, {
    provider: 'opencode', kind: 'mcp_task_start', authority: 'agent_acknowledged', nativeTurnId: 'turn-mcp', sessionId: 'session', providerStartedAt: new Date().toISOString()
  });
  assert.equal(acknowledged.taskIngressReceipt.authority, 'agent_acknowledged');
  const native = taskIngressReceiptFields({ interactionBudget: acknowledged.interactionBudget, taskIngressReceipt: acknowledged.taskIngressReceipt }, {
    provider: 'opencode', kind: 'opencode_session_busy', authority: 'provider_native', nativeTurnId: 'turn-native', sessionId: 'session', providerStartedAt: new Date().toISOString()
  });
  assert.equal(native.taskIngressReceipt.authority, 'provider_native');
  assert.equal(native.taskIngressReceipt.nativeTurnId, 'turn-native');
  assert.deepEqual(taskIngressReceiptFields({ interactionBudget: native.interactionBudget, taskIngressReceipt: native.taskIngressReceipt }, {
    provider: 'opencode', kind: 'mcp_task_start', authority: 'agent_acknowledged', nativeTurnId: 'late-mcp', sessionId: 'session', providerStartedAt: new Date().toISOString()
  }), {});
});

test('a missing receipt becomes a persisted deadline failure at ten seconds', () => {
  const { taskIngressDeadlineFields } = require('../out/providerTaskIngress.js');
  const interactionBudget = createInteractionBudget({ wallMs: 1_000, bootId: 'boot-a', uptimeMs: 20_000, interactionId: 'action-no-receipt' });
  assert.deepEqual(taskIngressDeadlineFields({ interactionBudget }, { wallMs: 10_999, bootId: 'boot-a', uptimeMs: 29_999 }), {});
  const failed = taskIngressDeadlineFields({ interactionBudget }, { wallMs: 11_000, bootId: 'boot-a', uptimeMs: 30_000 });
  assert.equal(failed.taskIngressVerdict, 'deadline_exceeded');
  assert.equal(failed.taskIngressElapsedMs, 10_000);
  assert.equal(failed.deliveryLastError, 'agent_task_ingress_timeout');
});

test('provider ingress verdict uses the native task start instead of delayed observer polling', () => {
  const { readInteractionClock } = require('../out/interactionBudget.js');
  const { taskIngressReceiptFields } = require('../out/providerTaskIngress.js');
  const now = readInteractionClock();
  const acceptedWallMs = now.wallMs - 17_000;
  const interactionBudget = createInteractionBudget({
    wallMs: acceptedWallMs,
    bootId: now.bootId,
    uptimeMs: now.uptimeMs - 17_000,
    interactionId: 'action-delayed-observer'
  });
  const fields = taskIngressReceiptFields({ interactionBudget, deliveryLastError: 'agent_task_ingress_timeout',
    taskIngressDeadlineExceededAt: new Date(acceptedWallMs + 10_000).toISOString() }, {
    provider: 'codex',
    kind: 'codex_task_started',
    nativeTurnId: 'turn-delayed-observer',
    sessionId: 'session-delayed-observer',
    providerStartedAt: new Date(acceptedWallMs + 7_400).toISOString(),
    observedAt: new Date(now.wallMs).toISOString()
  });

  assert.equal(fields.taskIngressElapsedMs, 7_400);
  assert.equal(fields.taskIngressVerdict, 'degraded');
  assert.ok(fields.interactionBudget.elapsedFloorMs >= 16_900, 'observer latency remains visible on the monotonic budget');
  assert.equal(fields.taskIngressReceipt.observerDelayMs, 9_600);
  assert.equal(fields.deliveryLastError, '');
  assert.equal(fields.taskIngressDeadlineExceededAt, '');
});

test('a Provider task starting exactly at the ten-second boundary fails the release gate', () => {
  const { readInteractionClock } = require('../out/interactionBudget.js');
  const { taskIngressReceiptFields } = require('../out/providerTaskIngress.js');
  const now = readInteractionClock();
  const acceptedWallMs = now.wallMs - 10_050;
  const interactionBudget = createInteractionBudget({
    wallMs: acceptedWallMs,
    bootId: now.bootId,
    uptimeMs: now.uptimeMs - 10_050,
    interactionId: 'action-exact-boundary'
  });
  const fields = taskIngressReceiptFields({ interactionBudget }, {
    provider: 'codex',
    kind: 'codex_task_started',
    nativeTurnId: 'turn-exact-boundary',
    sessionId: 'session-exact-boundary',
    providerStartedAt: new Date(acceptedWallMs + 10_000).toISOString(),
    observedAt: new Date(now.wallMs).toISOString()
  });
  assert.equal(fields.taskIngressElapsedMs, 10_000);
  assert.equal(fields.taskIngressVerdict, 'deadline_exceeded');
});
