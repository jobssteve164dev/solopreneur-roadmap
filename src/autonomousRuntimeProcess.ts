import * as crypto from 'crypto';
import * as path from 'path';

import {
  claimRuntimeLease,
  hasRuntimeLease,
  readCurrentRegisteredShadowDecision,
  runCognitiveShadowDecisionCycle,
  runShadowDecisionCycle,
  updateRuntimeState
} from './autonomousRuntime';
import { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { LocalAgentCliEngine } from './localAgentCliEngine';
import { initializeAutonomousExecutionRuntime } from './autonomousExecutionRuntime';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function intervalValue(): number {
  const parsed = Number(argumentValue('--interval-ms') || 30_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.round(parsed)) : 30_000;
}

async function main(): Promise<void> {
  const globalDataPath = argumentValue('--global-data-path');
  if (!globalDataPath) {
    process.stderr.write('SoloMap Runtime requires --global-data-path.\n');
    process.exitCode = 2;
    return;
  }
  await initializeAutonomousExecutionRuntime({ globalDataPath });
  if (process.argv.includes('--once')) {
    runShadowDecisionCycle({ globalDataPath });
    return;
  }

  const runtimeId = argumentValue('--runtime-id') || crypto.randomUUID();
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid: process.pid });
  if (!lease.acquired) return;

  let stopping = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let activeEngine: LocalAgentCliEngine | undefined;
  const runCycle = async () => {
    if (stopping || running) return;
    running = true;
    try {
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const current = readCurrentRegisteredShadowDecision(globalDataPath);
      const cognitiveConfig = readCognitiveRuntimeConfig(globalDataPath);
      const cognitiveConfigRevision = cognitiveRuntimeConfigRevision(cognitiveConfig);
      const engine = cognitiveConfig.mode === 'agent_cli' ? new LocalAgentCliEngine({
        agentCli: cognitiveConfig.agentCli,
        model: cognitiveConfig.model,
        configRevision: cognitiveConfigRevision,
        workingDirectory: path.join(globalDataPath, 'runtime', 'cognitive-work')
      }) : null;
      activeEngine = engine || undefined;
      const decision = engine
        ? (current?.engineStatus === 'completed' && current.engineId === engine.id ? current : await runCognitiveShadowDecisionCycle({
          globalDataPath,
          engine,
          engineConfigRevision: cognitiveConfigRevision,
          beforeCommit: () => hasRuntimeLease(globalDataPath, runtimeId, process.pid)
            && cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(globalDataPath)) === cognitiveConfigRevision
        }))
        : runShadowDecisionCycle({ globalDataPath });
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: decision.decisionId,
        error: ''
      });
    } catch (error) {
      if (stopping) return;
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const fallback = runShadowDecisionCycle({ globalDataPath });
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: fallback.decisionId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      activeEngine = undefined;
      running = false;
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    activeEngine?.cancel();
    updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    process.exitCode = 0;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  void runCycle();
  timer = setInterval(() => void runCycle(), intervalValue());
}

void main().catch(error => {
  process.stderr.write(`SoloMap Runtime could not initialize autonomous execution: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
