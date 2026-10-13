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
  expectsResult?: boolean;
  metadata?: Record<string, unknown>;
  launchSlotId?: string;
  launchSlotScope?: 'project' | 'global';
}): Promise<Awaited<ReturnType<typeof prepareAgentRun>> & { resultFilePath: string }> {
  if (!maintenanceRunKinds.includes(input.runKind)) throw new Error('maintenance_run_kind_invalid');
  const operationId = crypto.randomUUID();
  const dataRoot = normalizeGlobalDataPathForExtension(input.globalDataPath, input.workspaceRoot);
  const resultFilePath = input.expectsResult === false ? '' : path.join(dataRoot, 'tmp', operationId, 'result.json');
  if (resultFilePath) fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
  const prepared = await prepareAgentRun({
    workspaceRoot: input.workspaceRoot, globalDataPath: dataRoot, agentCli: input.agentCli, selectedModel: '',
    nodeId: '__solo__', executionLogId: 0, runKind: input.runKind, userMessage: input.request,
    prompt: input.buildPrompt(resultFilePath), taskPermissionMode: input.taskPermissionMode,
    ...(input.launchSlotId ? { launchSlotId: input.launchSlotId, launchSlotScope: input.launchSlotScope || 'project' } : { launchIntentId: `maintenance:${operationId}` }),
    metadata: { ...input.metadata, maintenanceWorkspaceRoot: input.maintenanceRoot, ...(resultFilePath ? { maintenanceResultPath: resultFilePath } : {}), launchSummary: input.request }
  });
  return { ...prepared, resultFilePath };
}
