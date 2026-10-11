const test = require('node:test');
const assert = require('node:assert/strict');
const sound = require('../out/automationSound.js');

test('reloading a sound page releases its lost acknowledgement without replaying duplicate ready messages', async () => {
  const messages = []; const view = { postMessage: async message => { messages.push(message); return true; } };
  sound.handleAutomationSoundMessage(view, { command: 'automationSoundReady', pageId: 'page-before-reload' });
  let posted; const accepted = new Promise(resolve => { posted = resolve; });
  const flight = sound.deliverAutomationSound(view, 'delivery', 'attempt', posted);
  try {
    await accepted;
    sound.handleAutomationSoundMessage(view, { command: 'automationSoundReady', pageId: 'page-before-reload' });
    assert.equal(await Promise.race([flight, new Promise(resolve => setImmediate(() => resolve('pending')))]), 'pending');
    sound.handleAutomationSoundMessage(view, { command: 'automationSoundReady', pageId: 'page-after-reload' });
    assert.equal(await Promise.race([flight, new Promise(resolve => setImmediate(() => resolve('pending')))]), false, 'a fresh page cannot leave the previous playback claimed forever');
    assert.equal(messages.length, 1);
  } finally { sound.disposeAutomationSoundView(view); await flight; }
});

test('a sound acknowledgement must belong to the exact page that received the delivery', async () => {
  const messages = []; const view = { postMessage: async message => { messages.push(message); return true; } };
  sound.handleAutomationSoundMessage(view, { command: 'automationSoundReady', pageId: 'original-page' });
  let posted; const accepted = new Promise(resolve => { posted = resolve; });
  const flight = sound.deliverAutomationSound(view, 'delivery', 'attempt', posted);
  try {
    await accepted;
    sound.handleAutomationSoundMessage(view, { command: 'automationSoundPlayed', pageId: 'different-page', deliveryId: 'delivery', token: 'attempt', played: true });
    assert.equal(await Promise.race([flight, new Promise(resolve => setImmediate(() => resolve('pending')))]), 'pending');
    assert.equal(messages[0].pageId, 'original-page');
    sound.handleAutomationSoundMessage(view, { command: 'automationSoundPlayed', pageId: 'original-page', deliveryId: 'delivery', token: 'attempt', played: true });
    assert.equal(await flight, true);
  } finally { sound.disposeAutomationSoundView(view); await flight; }
});
