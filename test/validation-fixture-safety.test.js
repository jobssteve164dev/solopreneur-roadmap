const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeOwnedEntry } = require('../scripts/owned-fixture-cleanup.cjs');
const { readCompleteJson } = require('../scripts/validation-json-receipt.cjs');

test('owned fixture cleanup treats an entry that disappeared concurrently as already removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-owned-cleanup-contract-'));
  try {
    assert.doesNotThrow(() => removeOwnedEntry(root, path.join(root, 'already-gone')));
  } finally {
    fs.rmdirSync(root);
  }
});

test('validation receipt reader waits through absent and incomplete JSON without hiding real failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-receipt-contract-'));
  const receipt = path.join(root, 'receipt.json');
  try {
    assert.equal(readCompleteJson(receipt), undefined);
    fs.writeFileSync(receipt, '{"schemaVersion":');
    assert.equal(readCompleteJson(receipt), undefined);
    fs.writeFileSync(receipt, '{"schemaVersion":1}');
    assert.deepEqual(readCompleteJson(receipt), { schemaVersion: 1 });
    fs.unlinkSync(receipt);
    fs.mkdirSync(receipt);
    assert.throws(() => readCompleteJson(receipt), /EISDIR|illegal operation|directory/i);
  } finally {
    if (fs.existsSync(receipt)) {
      if (fs.lstatSync(receipt).isDirectory()) fs.rmdirSync(receipt);
      else fs.unlinkSync(receipt);
    }
    fs.rmdirSync(root);
  }
});

test('real launch fixture keeps Driver progress receipt single-writer', () => {
  const source = fs.readFileSync(path.join(__dirname, 'browser', 'real-codex-launch-gate.cjs'), 'utf8');
  const playwrightSection = source.slice(source.indexOf('const acceptedWallMs'), source.indexOf('const completed ='));
  assert.doesNotMatch(playwrightSection, /writeFileSync\(receiptPath/,
    'Playwright must not overwrite the Driver-owned terminal progress receipt');
});

test('accepted intelligence ingress remains recoverable when preparation fails before materialization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'intelligenceRuntime.ts'), 'utf8');
  const executeIngress = source.slice(source.indexOf('private async executeIngress'), source.indexOf('private async runBounded'));
  assert.doesNotMatch(executeIngress, /requestCancellation/,
    'a preparation failure is not a user cancellation');
  assert.match(executeIngress, /!materialized.*scheduleRecovery/s,
    'the durable dispatcher must retry ingress that has not yet materialized');
});
