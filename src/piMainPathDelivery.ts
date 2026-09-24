import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { PiDeliveryInput, PiDeliveryProposal } from './piAgentEngine';

interface DeliveryEngine {
  proposeDelivery(input: PiDeliveryInput): Promise<PiDeliveryProposal>;
}

export interface DeliveryPublisher {
  prepare?(input: { projectPath: string; paths: string[] }): Promise<string>;
  publish(input: { projectPath: string; paths: string[]; commitMessage: string; push: boolean; baseHead?: string }): Promise<{ commit: string; pushed: boolean }>;
}

export interface PiMainPathRequest {
  taskId: string;
  projectPath: string;
  instruction: string;
  allowedPaths: string[];
  commitMessage: string;
  push: boolean;
}

export interface PiMainPathResult {
  engineId: string;
  modelPipe: string;
  summary: string;
  changedPaths: string[];
  commit: string;
  pushed: boolean;
}

function normalizeRelativePath(value: string): string {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Pi main path received an invalid file path: ${value}`);
  }
  return normalized;
}

function readAllowedFile(projectPath: string, relativePath: string): { path: string; content: string } {
  const target = path.resolve(projectPath, relativePath);
  const realTarget = fs.realpathSync(target);
  if (realTarget !== projectPath && !realTarget.startsWith(`${projectPath}${path.sep}`)) throw new Error(`Pi main path file escapes the project: ${relativePath}`);
  const stat = fs.lstatSync(realTarget);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pi main path requires a regular file: ${relativePath}`);
  return { path: relativePath, content: fs.readFileSync(realTarget, 'utf8') };
}

function replaceText(current: string, operation: PiDeliveryProposal['operations'][number]): string {
  const first = current.indexOf(operation.oldText);
  if (first < 0 || current.indexOf(operation.oldText, first + operation.oldText.length) >= 0) {
    throw new Error(`Pi main path replacement is not unique: ${operation.path}`);
  }
  return current.slice(0, first) + operation.newText + current.slice(first + operation.oldText.length);
}

function writeReplacement(target: string, next: string): void {
  const temporary = `${target}.solomap-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(target).mode & 0o777 });
  fs.renameSync(temporary, target);
}

function runGit(projectPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', args, { cwd: projectPath, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
      else resolve(String(stdout).trim());
    });
  });
}

export class GitMainPathPublisher implements DeliveryPublisher {
  public async prepare(input: { projectPath: string; paths: string[] }): Promise<string> {
    const branch = await runGit(input.projectPath, ['branch', '--show-current']);
    if (branch !== 'main') throw new Error('Pi main path publishing requires the local main branch.');
    await runGit(input.projectPath, ['fetch', 'origin', 'main']);
    const baseHead = await runGit(input.projectPath, ['rev-parse', 'HEAD']);
    const remoteHead = await runGit(input.projectPath, ['rev-parse', 'origin/main']);
    if (baseHead !== remoteHead) throw new Error('Pi main path local HEAD must match origin/main before delivery.');
    const existingChanges = await runGit(input.projectPath, ['status', '--porcelain', '--', ...input.paths]);
    if (existingChanges) throw new Error('Pi main path cannot overwrite existing changes in its allowed files.');
    return baseHead;
  }

  public async publish(input: { projectPath: string; paths: string[]; commitMessage: string; push: boolean; baseHead?: string }): Promise<{ commit: string; pushed: boolean }> {
    if (!input.baseHead) throw new Error('Pi main path publishing requires a prepared Git base.');
    const currentHead = await runGit(input.projectPath, ['rev-parse', 'HEAD']);
    if (currentHead !== input.baseHead) throw new Error('Pi main path Git base changed before commit.');
    await runGit(input.projectPath, ['commit', '--no-verify', '--only', '-m', input.commitMessage, '--', ...input.paths]);
    const commit = await runGit(input.projectPath, ['rev-parse', 'HEAD']);
    const parent = await runGit(input.projectPath, ['rev-parse', `${commit}^`]);
    if (parent !== input.baseHead) throw new Error('Pi main path commit does not descend directly from its prepared Git base.');
    const committedPaths = (await runGit(input.projectPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]))
      .split(/\r?\n/).filter(Boolean).sort();
    const expectedPaths = [...input.paths].sort();
    if (JSON.stringify(committedPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error('Pi main path commit contains paths outside the task result.');
    }
    if (input.push) await runGit(input.projectPath, ['push', 'origin', `${commit}:refs/heads/main`]);
    return { commit, pushed: input.push };
  }
}

export class PiMainPathDelivery {
  private readonly engine: DeliveryEngine;
  private readonly publisher: DeliveryPublisher;

  constructor(options: { engine: DeliveryEngine; publisher?: DeliveryPublisher }) {
    this.engine = options.engine;
    this.publisher = options.publisher || new GitMainPathPublisher();
  }

  public async run(request: PiMainPathRequest): Promise<PiMainPathResult> {
    const projectPath = fs.realpathSync(request.projectPath);
    const allowedPaths = [...new Set(request.allowedPaths.map(normalizeRelativePath))];
    const baseHead = await this.publisher.prepare?.({ projectPath, paths: allowedPaths });
    const allowedFiles = allowedPaths.map(relativePath => readAllowedFile(projectPath, relativePath));
    const proposal = await this.engine.proposeDelivery({
      taskId: request.taskId,
      instruction: request.instruction,
      allowedFiles
    });
    const allowed = new Set(allowedPaths);
    const nextContents = new Map(allowedFiles.map(file => [file.path, file.content]));
    for (const operation of proposal.operations) {
      if (!allowed.has(normalizeRelativePath(operation.path))) throw new Error(`Pi main path proposal exceeded its file list: ${operation.path}`);
      nextContents.set(operation.path, replaceText(nextContents.get(operation.path) || '', operation));
    }
    for (const file of allowedFiles) {
      if (readAllowedFile(projectPath, file.path).content !== file.content) {
        throw new Error(`Pi main path file changed while Pi Agent was working: ${file.path}`);
      }
    }
    for (const [relativePath, content] of nextContents) {
      const original = allowedFiles.find(file => file.path === relativePath)?.content;
      if (content !== original) writeReplacement(fs.realpathSync(path.resolve(projectPath, relativePath)), content);
    }
    const changedPaths = [...new Set(proposal.operations.map(operation => operation.path))].sort();
    const published = await this.publisher.publish({
      projectPath,
      paths: changedPaths,
      commitMessage: request.commitMessage,
      push: request.push,
      baseHead
    });
    return { ...proposal, changedPaths, ...published };
  }
}
