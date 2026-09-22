import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { readProjectAutonomyAuthorization } from './projectAutonomyAuthorization';

interface WorkerRequest {
  statePath: string;
  authorizationFile: string;
  projectPath: string;
  authorizationEpoch: number;
  timeoutMs: number;
  stdin: string;
  readyPath: string;
  cancelPath: string;
  workerToken: string;
  launch: { command: string; args: string[]; env: NodeJS.ProcessEnv };
}

interface WorkerState {
  status: string;
  workerPid: number;
  childPid: number;
  [key: string]: unknown;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

async function waitForReady(readyPath: string): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) {
    process.exitCode = 2;
    return;
  }
  const request = readJson<WorkerRequest>(requestPath);
  if (!request.workerToken || request.workerToken !== process.argv[3]) {
    process.exitCode = 2;
    return;
  }
  if (!(await waitForReady(request.readyPath))) {
    const interrupted = readJson<WorkerState>(request.statePath);
    if (interrupted.status === 'running') {
      writeJson(request.statePath, {
        ...interrupted,
        status: 'failed',
        terminationReason: 'worker_interrupted_before_ready',
        finishedAt: new Date().toISOString()
      });
    }
    return;
  }
  let state = readJson<WorkerState>(request.statePath);
  const grant = readProjectAutonomyAuthorization(request.authorizationFile, request.projectPath);
  if (!grant.enabled || grant.epoch !== request.authorizationEpoch) {
    writeJson(request.statePath, { ...state, status: 'cancelled', terminationReason: 'authorization_revoked', finishedAt: new Date().toISOString() });
    return;
  }

  const stdoutFd = fs.openSync(String(state.stdoutPath), 'a', 0o600);
  const stderrFd = fs.openSync(String(state.stderrPath), 'a', 0o600);
  const child = childProcess.spawn(request.launch.command, request.launch.args, {
    cwd: '/',
    env: request.launch.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', stdoutFd, stderrFd]
  });
  state = { ...state, workerPid: process.pid, childPid: Number(child.pid || 0), status: 'running' };
  writeJson(request.statePath, state);
  child.stdin?.end(request.stdin || '');

  let reason = '';
  let settled = false;
  const stopChild = (nextReason: string) => {
    if (settled || reason) return;
    reason = nextReason;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    force.unref();
  };
  const interval = setInterval(() => {
    try {
      const current = readProjectAutonomyAuthorization(request.authorizationFile, request.projectPath);
      if (fs.existsSync(request.cancelPath)) stopChild('cancelled_by_user');
      else if (!current.enabled || current.epoch !== request.authorizationEpoch) stopChild('authorization_revoked');
    } catch {
      stopChild('state_unavailable');
    }
  }, 100);
  interval.unref();
  const timeout = setTimeout(() => stopChild('timed_out'), request.timeoutMs);
  timeout.unref();
  const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError = '') => {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    clearTimeout(timeout);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const latest = readJson<WorkerState>(request.statePath);
    const status = reason === 'timed_out' ? 'timed_out' : reason ? 'cancelled' : (!spawnError && code === 0 ? 'succeeded' : 'failed');
    writeJson(request.statePath, {
      ...latest,
      status,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      terminationReason: reason || (spawnError ? 'spawn_failed' : '')
    });
  };
  child.once('error', error => {
    fs.appendFileSync(String(state.stderrPath), error.message, 'utf8');
    finish(null, null, error.message);
  });
  child.once('close', (code, signal) => finish(code, signal));
}

void main();
