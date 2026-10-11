import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';

export type WorkspaceSnapshot = Record<string, { size: number; mtimeMs: number }>;

export interface RunGitEvidence {
  baseGitHash: string;
  available: boolean;
  patch: string;
  error: string;
  files: Record<string, RunFileEvidence>;
}

export interface RunFileEvidence { algorithm: 'sha1' | 'sha256'; format: 'git-blob' | 'bytes'; digest: string }

async function captureFileHashes(root: string, relativePaths: string[], files: Record<string, RunFileEvidence>): Promise<void> {
  const physicalRoot = await fs.promises.realpath(root);
  for (const relative of new Set(relativePaths.filter(relative => !skip(relative)))) {
    const full = path.resolve(root, relative);
    try {
      const stat = await fs.promises.lstat(full);
      if (!stat.isFile() || await fs.promises.realpath(full) !== path.resolve(physicalRoot, relative)) { delete files[relative]; continue; }
      const hash = crypto.createHash('sha256');
      for await (const bytes of fs.createReadStream(full)) hash.update(bytes);
      files[relative] = { algorithm: 'sha256', format: 'bytes', digest: hash.digest('hex') };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; delete files[relative]; }
  }
}

export function matchesRunFileEvidence(root: string, relative: string, evidence: RunFileEvidence | undefined): boolean {
  if (!evidence || !['sha1', 'sha256'].includes(evidence.algorithm) || !['git-blob', 'bytes'].includes(evidence.format)) return false;
  const full = path.resolve(root, relative); const contained = path.relative(root, full);
  if (!contained || contained.startsWith('..') || path.isAbsolute(contained)) return false;
  let descriptor: number | undefined;
  try {
    if (fs.realpathSync(full) !== path.resolve(fs.realpathSync(root), relative) || !fs.lstatSync(full).isFile()) return false;
    descriptor = fs.openSync(full, 'r');
    const size = fs.fstatSync(descriptor).size; const hash = crypto.createHash(evidence.algorithm);
    if (evidence.format === 'git-blob') hash.update(`blob ${size}\0`);
    const buffer = Buffer.allocUnsafe(65536); let count: number;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex') === evidence.digest;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export async function readWorkspaceGitHead(root: string): Promise<string> {
  try {
    const result = await git(root, ['rev-parse', '--verify', 'HEAD']);
    return result.code === 0 ? result.output.trim() : '';
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

export async function captureRunGitEvidence(root: string, baseGitHash: string, workspace?: WorkspaceSnapshot): Promise<RunGitEvidence> {
  const files: Record<string, RunFileEvidence> = Object.create(null);
  const unavailable = (error: string): RunGitEvidence => ({ baseGitHash, available: false, patch: '', error, files });
  if (!/^[a-f0-9]{40,64}$/.test(baseGitHash)) {
    if (workspace) await captureFileHashes(root, Object.keys(workspace), files);
    return unavailable('git_baseline_unavailable');
  }
  try {
    const tree = await git(root, ['ls-tree', '-rz', baseGitHash]);
    if (tree.code !== 0) return unavailable(`git_tree_failed:${tree.code}`);
    for (const entry of tree.output.split('\0').filter(Boolean)) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/);
      if (match && !skip(match[3])) files[match[3]] = { algorithm: match[2].length === 40 ? 'sha1' : 'sha256', format: 'git-blob', digest: match[2] };
    }
    const listed = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (listed.code !== 0) return unavailable(`git_inventory_failed:${listed.code}`);
    const patches: string[] = [];
    const changed = await git(root, ['diff', '--no-renames', '--name-only', '-z', baseGitHash, '--']);
    if (changed.code !== 0) return unavailable(`git_changed_files_failed:${changed.code}`);
    const candidates = [...new Set([...Object.keys(files), ...changed.output.split('\0'), ...listed.output.split('\0')])].filter(relative => relative && !skip(relative) && relative !== '.solopreneur/roadmap.csv');
    const ignored = candidates.length ? await git(root, ['check-ignore', '--no-index', '-z', '--stdin'], candidates.join('\0') + '\0') : { code: 1, output: '' };
    if (![0, 1].includes(ignored.code)) return unavailable(`git_ignore_check_failed:${ignored.code}`);
    const excluded = new Set(ignored.output.split('\0').filter(Boolean));
    for (const relative of excluded) delete files[relative];
    const accepted = (relative: string) => relative && !skip(relative) && !excluded.has(relative);
    const changedFiles = changed.output.split('\0').filter(accepted);
    const additions = listed.output.split('\0').filter(accepted);
    await captureFileHashes(root, [...changedFiles, ...additions], files);
    let batch: string[] = []; let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const diff = await git(root, ['diff', '--binary', baseGitHash, '--', ...batch]);
      if (diff.code !== 0) throw new Error(`git_diff_failed:${diff.code}`);
      patches.push(diff.output); batch = []; batchBytes = 0;
    };
    for (const relative of changedFiles) {
      const argument = `:(literal)${relative}`;
      if (batch.length && batchBytes + Buffer.byteLength(argument) + 1 > 65536) await flush();
      batch.push(argument); batchBytes += Buffer.byteLength(argument) + 1;
    }
    await flush();
    for (const relative of additions) {
      const addition = await git(root, ['diff', '--no-index', '--binary', '--', '/dev/null', relative]);
      if (![0, 1].includes(addition.code)) return unavailable(`git_new_file_diff_failed:${addition.code}:${relative}`);
      patches.push(addition.output);
    }
    return { baseGitHash, available: true, patch: patches.join(''), error: '', files };
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
}

export function gitEvidenceDocumentPurpose(turnId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(turnId)) throw new Error('workspace_turn_required');
  return `git_evidence_${turnId.replace(/-/g, '')}`;
}

function skip(relative: string): boolean {
  return relative === '.git' || relative.startsWith('.git/')
    || relative === 'node_modules' || relative.startsWith('node_modules/')
    || (relative.startsWith('.solopreneur/') && relative !== '.solopreneur/roadmap.csv')
    || relative === '.agent_status.json';
}

async function git(root: string, args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.resume();
    child.once('error', reject);
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.once('close', code => resolve({ code: code ?? -1, output: Buffer.concat(output).toString('utf8') }));
    child.stdin.end(input);
  });
}

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('workspace_directory_required');
  const snapshot: WorkspaceSnapshot = Object.create(null);
  const record = async (relative: string) => {
    if (skip(relative)) return;
    try {
      const stat = await fs.promises.stat(path.join(root, relative));
      if (stat.isFile()) snapshot[relative] = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  let versioned = false;
  try { const check = await git(root, ['rev-parse', '--is-inside-work-tree']); versioned = check.code === 0 && check.output.trim() === 'true'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (versioned) {
    const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    if (listed.code !== 0) throw new Error(`workspace_inventory_failed:${listed.code}`);
    const files = [...new Set(listed.output.split('\0').filter(Boolean))].filter(relative => !skip(relative));
    const candidates = files.filter(relative => relative !== '.solopreneur/roadmap.csv');
    const ignored = candidates.length ? await git(root, ['check-ignore', '--no-index', '-z', '--stdin'], candidates.join('\0') + '\0') : { code: 1, output: '' };
    if (![0, 1].includes(ignored.code)) throw new Error(`workspace_ignore_check_failed:${ignored.code}`);
    const excluded = new Set(ignored.output.split('\0').filter(Boolean));
    const accepted = files.filter(relative => !excluded.has(relative));
    for (let index = 0; index < accepted.length; index += 32) await Promise.all(accepted.slice(index, index + 32).map(record));
    await record('.solopreneur/roadmap.csv');
  } else {
    const generated = new Set(['out', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.turbo']);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (skip(relative)) continue;
        if (entry.isDirectory()) { if (!generated.has(entry.name)) await walk(full); }
        else if (entry.isFile()) await record(relative);
      }
    };
    await walk(root);
  }
  return snapshot;
}

export function workspaceChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changes: string[] = [];
  for (const [relative, metadata] of Object.entries(after)) {
    const previous = Object.prototype.hasOwnProperty.call(before, relative) ? before[relative] : undefined;
    if (!previous) changes.push(`A ${relative}`);
    else if (previous.size !== metadata.size || Math.round(previous.mtimeMs) !== Math.round(metadata.mtimeMs)) changes.push(`M ${relative}`);
  }
  for (const relative of Object.keys(before)) if (!after[relative]) changes.push(`D ${relative}`);
  return changes.sort((left, right) => left.localeCompare(right));
}

export function workspaceDocumentPurpose(turnId: string, phase: 'before' | 'after' | 'changes'): string {
  if (!/^[0-9a-f-]{36}$/.test(turnId)) throw new Error('workspace_turn_required');
  return `workspace_${phase}_${turnId.replace(/-/g, '')}`;
}
