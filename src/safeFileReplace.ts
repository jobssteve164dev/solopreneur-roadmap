import * as crypto from 'crypto';
import * as fs from 'fs';

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function hashFile(file: string): string {
  const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), descriptor = fs.openSync(file, 'r');
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

/** Replace a regular file only while the bytes observed by the caller remain current. */
export function replaceRegularFileIfUnchanged(file: string, temporary: string, expected: Buffer | string | { sha256: string }): void {
  const expectedHash = typeof expected === 'object' && !Buffer.isBuffer(expected) ? expected.sha256 : hash(Buffer.isBuffer(expected) ? expected : Buffer.from(expected));
  if (!fs.existsSync(file)) {
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('file_changed_during_write');
      throw error;
    }
    fs.unlinkSync(temporary);
    return;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('file_replace_target_invalid');
  const guard = `${temporary}.previous`;
  const displaced = `${temporary}.displaced`;
  const replacementHash = hashFile(temporary);
  fs.linkSync(file, guard);
  try {
    const before = fs.lstatSync(file);
    if (before.dev !== stat.dev || before.ino !== stat.ino || hashFile(guard) !== expectedHash) throw new Error('file_changed_during_write');
    fs.renameSync(file, displaced);
    const moved = fs.lstatSync(displaced);
    if (moved.dev !== stat.dev || moved.ino !== stat.ino || hashFile(displaced) !== expectedHash) {
      try { fs.linkSync(displaced, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      throw new Error('file_changed_during_write');
    }
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('file_changed_during_write');
    }
    fs.unlinkSync(temporary);
    const published = fs.lstatSync(file);
    // A writer that opened the old inode before the rename can still finish late.
    // The hard link retains those bytes so the external edit can be restored.
    if (hashFile(displaced) !== expectedHash) {
      const current = fs.lstatSync(file);
      if (current.dev === published.dev && current.ino === published.ino && hashFile(file) === replacementHash) {
        fs.renameSync(displaced, file);
      }
      throw new Error('file_changed_during_write');
    }
  } finally {
    if (fs.existsSync(guard)) fs.unlinkSync(guard);
    if (fs.existsSync(displaced)) {
      if (!fs.existsSync(file)) fs.linkSync(displaced, file);
      const current = fs.lstatSync(file), retained = fs.lstatSync(displaced);
      if (current.dev === retained.dev && current.ino === retained.ino || hashFile(displaced) === expectedHash) fs.unlinkSync(displaced);
    }
  }
}
