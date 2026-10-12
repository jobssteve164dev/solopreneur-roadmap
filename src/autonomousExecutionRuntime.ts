import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DurableSandboxExecutionBackend, recoverDurableExecutionStates } from './durableSandboxExecutionBackend';
import { ExecutionSandbox, LinuxBubblewrapSandbox } from './executionSandbox';
import { ProjectAutonomyAuthorizationStore } from './projectAutonomyAuthorization';
import { UnifiedDataStore } from './db/unifiedDataStore';

async function gitRevision(workspacePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Unable to read isolated workspace revision: ${String(stderr || error.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

export async function initializeAutonomousExecutionRuntime(options: {
  globalDataPath: string;
  dataStore: UnifiedDataStore;
  sandbox?: ExecutionSandbox;
  readBaseRevision?: (workspacePath: string) => Promise<string>;
}): Promise<{ backend: DurableSandboxExecutionBackend; recoveredExecutionIds: string[]; sandboxAvailable: boolean }> {
  const runtimeRoot = path.join(options.globalDataPath, 'runtime');
  const isolationRoot = path.join(runtimeRoot, 'isolated-workspaces');
  const stateRoot = path.join(runtimeRoot, 'autonomous-executions');
  fs.mkdirSync(isolationRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  const backend = new DurableSandboxExecutionBackend({
    isolationRoot,
    stateRoot,
    authorization: new ProjectAutonomyAuthorizationStore({ globalDataPath: options.globalDataPath, dataStore: options.dataStore }),
    sandbox: options.sandbox || new LinuxBubblewrapSandbox(),
    readBaseRevision: options.readBaseRevision || gitRevision
  });
  const recovered = recoverDurableExecutionStates(stateRoot);
  const capabilities = await backend.probe();
  return {
    backend,
    recoveredExecutionIds: recovered.map(handle => handle.executionId),
    sandboxAvailable: capabilities.operatingSystemSandbox
  };
}
