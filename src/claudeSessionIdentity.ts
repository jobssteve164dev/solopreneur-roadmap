import * as fs from 'fs';
import * as path from 'path';
import type { FileHandle } from 'fs/promises';

export async function* claudeTranscriptChunks(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
  for (let offset = start; offset < end;) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, end - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw new Error('native_source_read_incomplete');
    offset += bytesRead; yield buffer.subarray(0, bytesRead);
  }
}

/** Claude's native project-directory convention; long paths may use a Bun hash. */
export async function claudeTranscriptPaths(claudeHome: string, workspaceRoot: string, sessionId: string): Promise<string[]> {
  if (!path.isAbsolute(claudeHome) || !path.isAbsolute(workspaceRoot) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('identity_provider_context_invalid');
  const projects = path.join(claudeHome, 'projects');
  const canonical = (await fs.promises.realpath(workspaceRoot)).normalize('NFC');
  const names = [...new Set([path.resolve(workspaceRoot).normalize('NFC'), canonical])].map(value => value.replace(/[^a-zA-Z0-9]/g, '-'));
  const directories = new Set(names.filter(name => name.length <= 200));
  const prefixes = names.filter(name => name.length > 200).map(name => name.slice(0, 200) + '-');
  if (prefixes.length) {
    try { for (const entry of await fs.promises.readdir(projects, { withFileTypes: true })) if (entry.isDirectory() && prefixes.some(prefix => entry.name.startsWith(prefix))) directories.add(entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...directories].map(name => path.join(projects, name, `${sessionId}.jsonl`));
}

export async function assertClaudeTranscript(transcriptPath: string, claudeHome: string, workspaceRoot: string, sessionId: string, verifiedStamp = ''): Promise<{ inode: string; sourceSize: number; stamp: string; handle: FileHandle } | null> {
  const stat = await fs.promises.lstat(transcriptPath);
  const realHome = await fs.promises.realpath(claudeHome);
  const realPath = await fs.promises.realpath(transcriptPath);
  const relative = path.relative(path.join(realHome, 'projects'), realPath);
  if (!stat.isFile() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 2 || path.basename(realPath) !== `${sessionId}.jsonl`) throw new Error('identity_transcript_scope_mismatch');
  const handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    const physicalPath = await fs.promises.realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : realPath);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || physicalPath !== realPath || !opened.isFile()) throw new Error('identity_transcript_scope_mismatch');
    const value = { inode: `${opened.dev}:${opened.ino}`, sourceSize: opened.size, stamp: JSON.stringify([opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs]), handle };
    if (value.stamp === verifiedStamp) return value;
    const expectedWorkspace = await fs.promises.realpath(workspaceRoot);
    let parts: Buffer[] = []; let length = 0;
    for await (const chunk of claudeTranscriptChunks(handle, 0, opened.size)) {
      let offset = 0; let newline = chunk.indexOf(10);
      while (newline >= 0) {
        const part = chunk.subarray(offset, newline); parts.push(part); length += part.length;
        let row: any; try { row = JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch {}
        parts = []; length = 0; offset = newline + 1;
        if (['user', 'assistant'].includes(row?.type)) {
          if (row.sessionId !== sessionId || typeof row.cwd !== 'string' || row.isSidechain === true || await fs.promises.realpath(row.cwd).catch(() => '') !== expectedWorkspace) throw new Error('identity_provider_mismatch');
          return value;
        }
        newline = chunk.indexOf(10, offset);
      }
      if (offset < chunk.length) { const part = chunk.subarray(offset); parts.push(part); length += part.length; }
    }
    await handle.close(); return null;
  } catch (error) {
    await handle.close(); throw error;
  }
}
