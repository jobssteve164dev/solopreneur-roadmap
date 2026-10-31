import { parentPort, threadId } from 'worker_threads';

import { buildProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';

const port = parentPort;
if (!port) throw new Error('sidebar_core_projection_parent_missing');

port.on('message', (message: { id?: number; project?: SolopreneurProject }) => {
  const id = Number(message.id);
  try {
    if (!message.project) throw new Error('sidebar_core_projection_project_missing');
    const summary = buildProjectPortfolioSummary(message.project, { coreOnly: true });
    port.postMessage({ id, summary, workerThreadId: threadId });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error), workerThreadId: threadId });
  }
});
