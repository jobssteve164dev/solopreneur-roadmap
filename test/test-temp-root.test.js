const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('the Node test runner removes every fixture created inside its owned temporary root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-test-runner-contract-'));
  const nestedTest = path.join(base, 'owned-fixture.test.cjs');
  const resultPath = path.join(base, 'owned-root.txt');
  try {
    fs.writeFileSync(nestedTest, `const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test');test('fixture',()=>{fs.writeFileSync(path.join(os.tmpdir(),'fixture.txt'),'owned');fs.writeFileSync(process.env.SOLOMAP_TEST_ROOT_RESULT,os.tmpdir());});\n`);
    const env = { ...process.env, SOLOMAP_TEST_ROOT_RESULT: resultPath };
    delete env.NODE_TEST_CONTEXT;
    const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '../scripts/run-node-tests.cjs'), nestedTest], {
      cwd: path.join(__dirname, '..'),
      env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const ownedRoot = fs.readFileSync(resultPath, 'utf8');
    assert.equal(fs.existsSync(ownedRoot), false, 'the runner must remove its exact per-run fixture root');
  } finally {
    for (const file of [nestedTest, resultPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(base);
  }
});

test('the Node test runner expands a literal glob and runs the capacity test after regular tests', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-test-runner-batches-'));
  const resultPath = path.join(base, 'regular-finished.txt');
  try {
    fs.writeFileSync(path.join(base, 'regular.test.js'), `const fs=require('node:fs'),test=require('node:test');test('regular',async()=>{await new Promise(resolve=>setTimeout(resolve,100));fs.writeFileSync(process.env.SOLOMAP_TEST_BATCH_RESULT,'done');});\n`);
    fs.writeFileSync(path.join(base, 'pi-capacity-budget.test.js'), `const assert=require('node:assert/strict'),fs=require('node:fs'),test=require('node:test');test('capacity',()=>assert.equal(fs.readFileSync(process.env.SOLOMAP_TEST_BATCH_RESULT,'utf8'),'done'));\n`);
    const env = { ...process.env, SOLOMAP_TEST_BATCH_RESULT: resultPath };
    delete env.NODE_TEST_CONTEXT;
    const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '../scripts/run-node-tests.cjs'), path.join(base, '*.test.js')], {
      cwd: path.join(__dirname, '..'),
      env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout.match(/TAP version 13/g) || []).length, 2, 'the runner must start two test batches');
  } finally {
    for (const name of fs.readdirSync(base)) fs.unlinkSync(path.join(base, name));
    fs.rmdirSync(base);
  }
});

test('the Node test runner stops after a regular batch failure and propagates either batch failure', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-test-runner-failures-'));
  const capacityResultPath = path.join(base, 'capacity-ran.txt');
  const regularTest = path.join(base, 'regular.test.js');
  const capacityTest = path.join(base, 'pi-capacity-budget.test.js');
  const runner = path.join(__dirname, '../scripts/run-node-tests.cjs');
  const pattern = path.join(base, '*.test.js');
  try {
    fs.writeFileSync(regularTest, `const assert=require('node:assert/strict'),test=require('node:test');test('regular',()=>assert.fail('regular failure'));\n`);
    fs.writeFileSync(capacityTest, `const fs=require('node:fs'),test=require('node:test');test('capacity',()=>fs.writeFileSync(process.env.SOLOMAP_TEST_BATCH_RESULT,'ran'));\n`);
    const env = { ...process.env, SOLOMAP_TEST_BATCH_RESULT: capacityResultPath };
    delete env.NODE_TEST_CONTEXT;
    const regularFailure = childProcess.spawnSync(process.execPath, [runner, pattern], {
      cwd: path.join(__dirname, '..'), env, encoding: 'utf8'
    });
    assert.equal(regularFailure.status, 1, regularFailure.stderr || regularFailure.stdout);
    assert.equal(fs.existsSync(capacityResultPath), false, 'the capacity batch must not run after a regular batch failure');

    fs.writeFileSync(regularTest, `const test=require('node:test');test('regular',()=>{});\n`);
    fs.writeFileSync(capacityTest, `const assert=require('node:assert/strict'),test=require('node:test');test('capacity',()=>assert.fail('capacity failure'));\n`);
    const capacityFailure = childProcess.spawnSync(process.execPath, [runner, pattern], {
      cwd: path.join(__dirname, '..'), env, encoding: 'utf8'
    });
    assert.equal(capacityFailure.status, 1, capacityFailure.stderr || capacityFailure.stdout);
  } finally {
    for (const name of fs.readdirSync(base)) fs.unlinkSync(path.join(base, name));
    fs.rmdirSync(base);
  }
});

test('the Node test runner removes its owned temporary root for every handled interruption signal', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-test-runner-interrupt-'));
  try {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const suffix = signal.toLowerCase();
      const nestedTest = path.join(base, `interrupted-${suffix}.test.cjs`);
      const resultPath = path.join(base, `interrupted-${suffix}-root.txt`);
      fs.writeFileSync(nestedTest, `const childProcess=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test');test('fixture',async()=>{const child=childProcess.spawn(process.execPath,['-e',"const fs=require('node:fs'),path=require('node:path'),root=process.argv[1];setInterval(()=>{fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'survived.txt'),'alive');},20);",os.tmpdir()],{stdio:'ignore',detached:process.platform!=='win32'});fs.writeFileSync(path.join(os.tmpdir(),'fixture.txt'),'owned');fs.writeFileSync(process.env.SOLOMAP_TEST_ROOT_RESULT,JSON.stringify({root:os.tmpdir(),workerPid:process.pid,childPid:child.pid}));await new Promise(resolve=>setTimeout(resolve,60000));});\n`);
      const env = { ...process.env, SOLOMAP_TEST_ROOT_RESULT: resultPath };
      delete env.NODE_TEST_CONTEXT;
      const runner = childProcess.spawn(process.execPath, [path.join(__dirname, '../scripts/run-node-tests.cjs'), nestedTest], {
        cwd: path.join(__dirname, '..'), env, stdio: 'ignore'
      });
      for (let attempt = 0; attempt < 100 && !fs.existsSync(resultPath); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(fs.existsSync(resultPath), true, `the nested test must start before ${signal}`);
      assert.equal(runner.exitCode, null, `the nested test must still be running before ${signal}`);
      const fixture = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const closed = new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
      });
      assert.equal(runner.kill(signal), true, `${signal} must reach the runner`);
      const result = await closed;
      assert.deepEqual(result, { code: null, exitSignal: signal });
      for (const pid of [fixture.workerPid, fixture.childPid]) {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); }
          catch { break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.throws(() => process.kill(pid, 0), `${signal} must stop process ${pid} in the test tree`);
      }
      assert.equal(fs.existsSync(fixture.root), false, `${signal} must remove the exact per-run fixture root`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(fs.existsSync(fixture.root), false, `${signal} must not leave a child that recreates the fixture root`);
      fs.unlinkSync(nestedTest);
      fs.unlinkSync(resultPath);
    }
  } finally {
    for (const name of fs.readdirSync(base)) fs.unlinkSync(path.join(base, name));
    fs.rmdirSync(base);
  }
});
