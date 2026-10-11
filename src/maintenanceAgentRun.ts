import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { prepareAgentRun } from './agentRunPreparation';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { maintenanceRunKinds } from './runLifecycleTypes';

export async function prepareMaintenanceAgentRun(input: {
  workspaceRoot: string; globalDataPath: string; maintenanceRoot: string; agentCli: string;
  taskPermissionMode: string; runKind: string; request: string;
  buildPrompt: (resultPath: string) => string;
}): Promise<Awaited<ReturnType<typeof prepareAgentRun>> & { resultFilePath: string }> {
  if (!maintenanceRunKinds.includes(input.runKind)) throw new Error('maintenance_run_kind_invalid');
  const operationId = crypto.randomUUID();
  const dataRoot = normalizeGlobalDataPathForExtension(input.globalDataPath, input.workspaceRoot);
  const resultFilePath = path.join(dataRoot, 'tmp', operationId, 'result.json');
  fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
  const prepared = await prepareAgentRun({
    workspaceRoot: input.workspaceRoot, globalDataPath: dataRoot, agentCli: input.agentCli, selectedModel: '',
    nodeId: '__solo__', executionLogId: 0, runKind: input.runKind, userMessage: input.request,
    prompt: input.buildPrompt(resultFilePath), taskPermissionMode: input.taskPermissionMode,
    launchIntentId: `maintenance:${operationId}`,
    metadata: { maintenanceWorkspaceRoot: input.maintenanceRoot, maintenanceResultPath: resultFilePath, launchSummary: input.request }
  });
  return { ...prepared, resultFilePath };
}
