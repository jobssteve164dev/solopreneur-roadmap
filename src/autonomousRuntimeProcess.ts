import * as crypto from 'crypto';

import {
  claimRuntimeLease,
  hasRuntimeLease,
  readCurrentRegisteredShadowDecision,
  runCognitiveShadowDecisionCycle,
  runShadowDecisionCycle,
  updateRuntimeState
} from './autonomousRuntime';
import { CopilotCliShadowEngine } from './copilotShadowEngine';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function intervalValue(): number {
  const parsed = Number(argumentValue('--interval-ms') || 30_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.round(parsed)) : 30_000;
}

function main(): void {
  const globalDataPath = argumentValue('--global-data-path');
  if (!globalDataPath) {
    process.stderr.write('SoloMap Runtime requires --global-data-path.\n');
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--once')) {
    runShadowDecisionCycle({ globalDataPath });
    return;
  }

  const runtimeId = argumentValue('--runtime-id') || crypto.randomUUID();
  const cognitiveEngine = argumentValue('--cognitive-engine');
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid: process.pid });
  if (!lease.acquired) return;

  let stopping = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const runCycle = async () => {
    if (stopping || running) return;
    running = true;
    try {
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const current = readCurrentRegisteredShadowDecision(globalDataPath);
      const decision = cognitiveEngine === 'copilot'
        ? (current?.engineStatus === 'completed' ? current : await runCognitiveShadowDecisionCycle({
          globalDataPath,
          engine: new CopilotCliShadowEngine()
        }))
        : (current || runShadowDecisionCycle({ globalDataPath }));
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: decision.decisionId,
        error: ''
      });
    } catch (error) {
      const fallback = readCurrentRegisteredShadowDecision(globalDataPath) || runShadowDecisionCycle({ globalDataPath });
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: fallback.decisionId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      running = false;
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  void runCycle();
  timer = setInterval(() => void runCycle(), intervalValue());
}

main();
