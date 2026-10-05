const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

test('failed endpoint publication closes its listening server and leaves no temporary endpoint', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-endpoint-failure-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime', 'control.json'), { recursive: true });
  const script = `const { startRuntimeControlServer } = require(${JSON.stringify(path.resolve(__dirname, '../out/autonomousRuntimeControl.js'))}); startRuntimeControlServer({globalDataPath:${JSON.stringify(root)},runtimeId:'failure',onCommand:()=>({status:'running'})}).catch(error=>process.stdout.write(error.code));`;
  const result = await new Promise(resolve => execFile(process.execPath, ['-e', script], { timeout: 1500 }, (error, stdout) => resolve({ error, stdout })));
  assert.equal(result.error, null, 'startup rejection must release the server rather than keep the process alive');
  assert.match(result.stdout, /EISDIR|ENOTEMPTY/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'runtime')), ['control.json']);
});
