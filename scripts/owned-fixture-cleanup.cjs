const fs = require('node:fs');
const path = require('node:path');

function removeOwnedEntry(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`test_fixture_outside_owned_root:${target}`);
  let info;
  try { info = fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    let names;
    try { names = fs.readdirSync(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) removeOwnedEntry(root, path.join(target, name));
    try { fs.rmdirSync(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  try { fs.unlinkSync(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { removeOwnedEntry };
