import * as fs from 'fs';
import * as path from 'path';

import { readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { CognitiveCliRunner } from './localAgentCliEngine';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { DeliveryPublisher, PiMainPathDelivery, PiMainPathRequest, PiMainPathResult } from './piMainPathDelivery';

export async function runConfiguredPiMainPath(options: {
  globalDataPath: string;
  request: PiMainPathRequest;
  runner?: CognitiveCliRunner;
  publisher?: DeliveryPublisher;
}): Promise<PiMainPathResult> {
  const config = readCognitiveRuntimeConfig(options.globalDataPath);
  if (config.mode !== 'agent_cli' || !config.agentCli) throw new Error('SoloMap has no selected Agent CLI model pipe.');
  const engine = new EmbeddedPiAgentEngine({
    agentCli: config.agentCli,
    model: config.model,
    configRevision: config.revision,
    workingDirectory: path.join(options.globalDataPath, 'runtime', 'pi-main-path-work'),
    runner: options.runner
  });
  return new PiMainPathDelivery({ engine, publisher: options.publisher }).run(options.request);
}

export async function runPiMainPathRequestFile(globalDataPath: string, requestFile: string): Promise<PiMainPathResult> {
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as PiMainPathRequest;
  return runConfiguredPiMainPath({ globalDataPath, request });
}
