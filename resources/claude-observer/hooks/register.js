async function send($, action, event) {
  const node = await $.env.get('SOLOMAP_NODE_EXECUTABLE');
  const checkpoint = await $.env.get('SOLOMAP_TASK_COMMAND');
  if (!node || !checkpoint) return;
  for (;;) {
    try {
      const result = await $.process.run([node, checkpoint, action], { stdin: JSON.stringify(event), timeoutMs: 600000 });
      if (result.exitCode === 0) return result;
      if (result.exitCode === 3) return;
    } catch {}
    await $.clock.sleep(250);
  }
}

export function register(on) {
  let pendingUser = '';
  let active;
  let sequence = 0;
  let ready = false;
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    const receipt = await send($, 'native-ready', { schemaVersion: 1, sessionId: await $.session.id() });
    if (receipt) {
      ready = true;
      try {
        const saved = JSON.parse(receipt.stdout);
        sequence = Number(saved.nextSequence) - 1;
        active = saved.resume?.active;
        pendingUser = saved.resume?.pendingUser || '';
      } catch { sequence = 0; }
    }
    return result;
  });
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.uuid) {
      const message = e.message;
      if (e.door === 'prompt' && message.type === 'user' && !message.isMeta) {
        await send($, 'native-append', { schemaVersion: 1, kind: 'prompt', sessionId: await $.session.id(), uuid: e.uuid });
        pendingUser = e.uuid;
      }
      if (e.door === 'response' && active && message.type === 'assistant' && message.role === 'assistant') {
        const turn = active;
        await send($, 'native-append', { schemaVersion: 1, kind: 'assistant', sessionId: await $.session.id(), uuid: e.uuid, userUuid: turn.userUuid, providerTurnId: turn.providerTurnId });
        if (!turn.assistantUuids.includes(e.uuid)) turn.assistantUuids.push(e.uuid);
      }
    }
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && pendingUser) {
      if (!ready) {
        const receipt = await send($, 'native-ready', { schemaVersion: 1, sessionId: await $.session.id() });
        if (receipt) {
          ready = true;
          try { sequence = Number(JSON.parse(receipt.stdout).nextSequence) - 1; } catch { sequence = 0; }
        }
      }
      active = { providerTurnId: e.turnId, userUuid: pendingUser, assistantUuids: [], startedAt: new Date(await $.clock.now()).toISOString() };
      pendingUser = '';
      await send($, 'native-event', { schemaVersion: 1, phase: 'start', sequence: ++sequence, sessionId: await $.session.id(), ...active, completedAt: active.startedAt, reason: 'answer' });
    }
    return result;
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && active?.providerTurnId === e.turnId) {
      const event = { schemaVersion: 1, phase: 'complete', sequence: ++sequence, sessionId: await $.session.id(), ...active,
        completedAt: new Date(await $.clock.now()).toISOString(), reason: e.isAborted ? 'aborted' : e.reason };
      active = undefined;
      await send($, 'native-event', event);
    }
    return result;
  });
}
