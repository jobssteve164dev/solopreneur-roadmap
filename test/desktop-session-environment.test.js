const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { desktopSessionEnvironment } = require('../out/desktopSessionEnvironment.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name);
    if (fs.lstatSync(child).isDirectory()) cleanupExact(child);
    else fs.unlinkSync(child);
  }
  fs.rmdirSync(root);
}

test('discovers an existing keyring control socket for plugin child processes', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-desktop-session-'));
  const keyringRoot = path.join(runtimeRoot, 'keyring');
  const control = path.join(keyringRoot, 'control');
  fs.mkdirSync(keyringRoot);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(control, resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    cleanupExact(runtimeRoot);
  });

  assert.deepEqual(desktopSessionEnvironment({
    XDG_RUNTIME_DIR: runtimeRoot,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/existing-bus'
  }), {
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/existing-bus',
    GNOME_KEYRING_CONTROL: keyringRoot
  });
});

test('does not use a regular file as a keyring control socket', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-desktop-session-'));
  const keyringRoot = path.join(runtimeRoot, 'keyring');
  fs.mkdirSync(keyringRoot);
  fs.writeFileSync(path.join(keyringRoot, 'control'), 'not a socket');
  try {
    assert.notEqual(
      desktopSessionEnvironment({ XDG_RUNTIME_DIR: runtimeRoot }).GNOME_KEYRING_CONTROL,
      keyringRoot
    );
  } finally {
    cleanupExact(runtimeRoot);
  }
});

test('preserves an explicitly inherited keyring control directory', () => {
  assert.deepEqual(desktopSessionEnvironment({
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/existing-bus',
    GNOME_KEYRING_CONTROL: '/custom/keyring'
  }), {
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/existing-bus',
    GNOME_KEYRING_CONTROL: '/custom/keyring'
  });
});
