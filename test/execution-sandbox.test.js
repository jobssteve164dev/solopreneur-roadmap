const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const childProcess = require('child_process');
const net = require('net');

const { LinuxBubblewrapSandbox } = require('../out/executionSandbox.js');

test('sandbox fails closed when the operating-system boundary cannot start', async () => {
  const sandbox = new LinuxBubblewrapSandbox({
    executable: '/missing/bwrap',
    runProbe: async () => ({ ok: false, reason: 'namespace unavailable' })
  });

  assert.deepEqual(await sandbox.probe(), {
    available: false,
    kind: 'linux-bubblewrap',
    reason: 'namespace unavailable'
  });
  assert.throws(
    () => sandbox.buildInvocation({ workspacePath: '/tmp/work', command: '/usr/bin/node', args: [], networkAccess: 'tool' }),
    /verified before use/i
  );
});

test('sandbox allows tool network only when the project policy permits it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-networked-sandbox-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const sandbox = new LinuxBubblewrapSandbox({
    executable: '/usr/bin/bwrap',
    runProbe: async () => ({ ok: true, reason: '' })
  });
  await sandbox.probe();

  const launch = sandbox.buildInvocation({ workspacePath: workspace, command: '/usr/bin/node', args: [], networkAccess: 'tool' });
  assert.ok(!launch.args.includes('--unshare-net'));
  assert.ok(launch.args.includes('--unshare-user'));
  assert.ok(launch.args.includes('--clearenv'));
  assert.ok(!launch.args.includes(os.homedir()));
  for (const networkFile of ['/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/hosts']) {
    if (fs.existsSync(networkFile)) assert.ok(launch.args.includes(networkFile));
  }
  if (fs.existsSync('/etc/ssl/certs')) assert.ok(launch.args.includes('/etc/ssl/certs'));
});

test('sandbox invocation exposes only the isolated workspace, read-only system files, and no network', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sandbox-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const sandbox = new LinuxBubblewrapSandbox({
    executable: '/usr/bin/bwrap',
    runProbe: async () => ({ ok: true, reason: '' })
  });
  assert.equal((await sandbox.probe()).available, true);

  const launch = sandbox.buildInvocation({ workspacePath: workspace, command: '/usr/bin/node', args: ['script.js'], networkAccess: 'offline' });
  assert.equal(launch.command, '/usr/bin/bwrap');
  assert.ok(launch.args.includes('--unshare-net'));
  assert.ok(launch.args.includes('--clearenv'));
  assert.ok(launch.args.includes('--ro-bind'));
  assert.ok(launch.args.includes('--bind'));
  assert.ok(launch.args.includes(workspace));
  assert.ok(!launch.args.includes(os.homedir()));
  assert.deepEqual(launch.args.slice(-2), ['/usr/bin/node', 'script.js']);
});

test('networked sandbox mounts common CA bundle paths across Linux distributions', async () => {
  const caPaths = [
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/pki/tls/cert.pem',
    '/etc/ssl/cert.pem',
    '/etc/ssl/ca-bundle.pem',
    '/var/lib/ca-certificates/ca-bundle.pem'
  ];
  const sandbox = new LinuxBubblewrapSandbox({
    executable: '/usr/bin/bwrap',
    runProbe: async () => ({ ok: true, reason: '' }),
    systemPathExists: candidate => caPaths.includes(candidate)
  });
  await sandbox.probe();

  const launch = sandbox.buildInvocation({ workspacePath: '/isolated/task', command: '/usr/bin/true', args: [], networkAccess: 'tool' });
  for (const caPath of caPaths) assert.ok(launch.args.includes(caPath), caPath);
  for (const parent of ['/etc/pki/tls/certs', '/etc/ssl', '/var/lib/ca-certificates']) {
    assert.ok(launch.args.includes(parent), parent);
  }
});

test('installed operating-system sandbox enforces filesystem, HOME, and network boundaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-real-sandbox-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(workspace);
  const sandbox = new LinuxBubblewrapSandbox();
  const probe = await sandbox.probe();
  if (!probe.available) {
    t.skip(`real sandbox unavailable: ${probe.reason}`);
    return;
  }

  const secret = path.join(root, 'host-secret.txt');
  fs.writeFileSync(secret, 'must-not-be-readable');

  const script = [
    "const fs=require('fs')",
    "const net=require('net')",
    "fs.writeFileSync('/workspace/inside.txt','inside')",
    `try{fs.writeFileSync(${JSON.stringify(outside)},'outside')}catch{}`,
    `try{fs.readFileSync(${JSON.stringify(secret)});process.exit(8)}catch{}`,
    "if(fs.existsSync('/home/solomap/.ssh'))process.exit(9)",
    "const socket=net.createConnection({host:'1.1.1.1',port:53})",
    "socket.once('connect',()=>process.exit(10))",
    "socket.once('error',()=>process.exit(0))",
    "setTimeout(()=>process.exit(11),1000)"
  ].join(';');
  const launch = sandbox.buildInvocation({ workspacePath: workspace, command: '/usr/bin/node', args: ['-e', script], networkAccess: 'offline' });
  const result = childProcess.spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
  assert.equal(fs.existsSync(outside), false);

  const server = net.createServer(socket => socket.end('ok'));
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  const networkScript = [
    "const net=require('net')",
    `const socket=net.createConnection({host:'127.0.0.1',port:${port}})`,
    "socket.once('data',data=>process.exit(String(data)==='ok'?0:12))",
    "socket.once('error',()=>process.exit(13))",
    "setTimeout(()=>process.exit(14),1000)"
  ].join(';');
  const networkLaunch = sandbox.buildInvocation({ workspacePath: workspace, command: '/usr/bin/node', args: ['-e', networkScript], networkAccess: 'tool' });
  const networked = childProcess.spawn(networkLaunch.command, networkLaunch.args, { env: networkLaunch.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  networked.stderr.on('data', chunk => stderr.push(String(chunk)));
  const exitCode = await new Promise((resolve, reject) => {
    networked.once('error', reject);
    networked.once('close', resolve);
  });
  await new Promise(resolve => server.close(resolve));
  assert.equal(exitCode, 0, stderr.join(''));
});
