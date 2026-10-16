const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('rollback safety preserves user files outside the project metadata directory', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-rollback-safety-'));
  const project = path.join(base, 'project');
  const globalDataPath = path.join(base, '.solomap-global');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: project });
  fs.writeFileSync(path.join(project, 'new.txt'), 'keep me');
  fs.writeFileSync(path.join(project, '.solopreneur', 'project.json'), '{}');
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title\n');
  const { moveUntrackedFilesToRollbackSafety } = require('../out/rollbackSafety.js');
  const recoveryRoot = moveUntrackedFilesToRollbackSafety(project, globalDataPath);
  assert.ok(recoveryRoot.startsWith(path.join(globalDataPath, 'recovery', 'rollback-safety') + path.sep));
  assert.equal(fs.readFileSync(path.join(recoveryRoot, 'new.txt'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(project, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'project.json')), true);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'roadmap.csv')), true);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'rollback-safety')), false);
});

test('rollback safety preserves exact bytes when the recovery root is on another filesystem', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-rollback-cross-device-'));
  const project = path.join(base, 'project');
  const globalDataPath = path.join(base, '.solomap-global');
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: project });
  const source = path.join(project, 'asset.bin');
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  fs.writeFileSync(source, bytes);
  const renameSync = fs.renameSync;
  fs.renameSync = () => { const error = new Error('cross-device'); error.code = 'EXDEV'; throw error; };
  let recoveryRoot;
  try {
    const { moveUntrackedFilesToRollbackSafety } = require('../out/rollbackSafety.js');
    recoveryRoot = moveUntrackedFilesToRollbackSafety(project, globalDataPath);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(fs.readFileSync(path.join(recoveryRoot, 'asset.bin')), bytes);
  assert.equal(fs.existsSync(source), false);
});

test('rollback safety preserves untracked filenames with leading and trailing spaces', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-rollback-spaced-name-'));
  const project = path.join(base, 'project');
  const globalDataPath = path.join(base, '.solomap-global');
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: project });
  const name = ' kept exactly .txt ';
  fs.writeFileSync(path.join(project, name), 'exact name');
  const { moveUntrackedFilesToRollbackSafety } = require('../out/rollbackSafety.js');
  const recoveryRoot = moveUntrackedFilesToRollbackSafety(project, globalDataPath);
  assert.equal(fs.readFileSync(path.join(recoveryRoot, name), 'utf8'), 'exact name');
  assert.equal(fs.existsSync(path.join(project, name)), false);
});
