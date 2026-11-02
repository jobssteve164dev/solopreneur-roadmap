import * as fs from 'fs';
import * as path from 'path';
import { parentPort, threadId, workerData } from 'worker_threads';

import { UnifiedDataStore } from './db/unifiedDataStore';
import { assessProjectFoundation, projectFoundationSignature } from './projectFoundation';
import { buildProjectPortfolioSummary, RoadmapNodeLike } from './projectPortfolio';

const port = parentPort;
if (!port) throw new Error('sidebar_database_projection_parent_missing');
const configuration = workerData as { root: string; databaseId: string };
const store = UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
const foundationWatchers = new Map<string, fs.FSWatcher[]>();
const foundationTimers = new Map<string, NodeJS.Timeout>();

function closeFoundationWatchers(root: string): void {
  for (const watcher of foundationWatchers.get(root) || []) watcher.close();
  foundationWatchers.delete(root);
  const timer = foundationTimers.get(root);
  if (timer) clearTimeout(timer);
  foundationTimers.delete(root);
}

function observeFoundation(root: string, expectedSignature?: string): void {
  const signature = projectFoundationSignature(root);
  if (signature !== expectedSignature) port!.postMessage({ foundationObservations: [{ path: root, signature }] });
}

function scheduleFoundationObservation(root: string): void {
  const previous = foundationTimers.get(root);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    foundationTimers.delete(root);
    syncFoundationObservers(root);
  }, 25);
  timer.unref();
  foundationTimers.set(root, timer);
}

function watchDirectory(root: string, directory: string, watchers: fs.FSWatcher[], expectedEntry = ''): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
      if (expectedEntry && filename && String(filename) !== expectedEntry) return;
      scheduleFoundationObservation(root);
    });
    watcher.on('error', () => scheduleFoundationObservation(root));
    watchers.push(watcher);
  } catch {}
}

function syncFoundationObservers(onlyRoot = ''): void {
  const inputs = store.sidebarFoundationObservationInputs();
  const active = new Set(inputs.map(input => path.resolve(input.path)));
  for (const root of foundationWatchers.keys()) if (!active.has(root)) closeFoundationWatchers(root);
  for (const input of inputs) {
    const root = path.resolve(input.path);
    if (onlyRoot && root !== onlyRoot) continue;
    closeFoundationWatchers(root);
    const watchers: fs.FSWatcher[] = [];
    if (fs.existsSync(root)) {
      watchDirectory(root, root, watchers);
      watchDirectory(root, path.join(root, '.github'), watchers);
      watchDirectory(root, path.join(root, '.github', 'workflows'), watchers);
    } else {
      let missing = root, ancestor = path.dirname(root);
      while (ancestor !== missing && !fs.existsSync(ancestor)) { missing = ancestor; ancestor = path.dirname(ancestor); }
      watchDirectory(root, ancestor, watchers, path.basename(missing));
    }
    foundationWatchers.set(root, watchers);
    observeFoundation(root, input.signature);
  }
}

port.on('message', (message: { id?: number; limit?: number; syncFoundations?: boolean; close?: boolean }) => {
  if (message.close) {
    for (const root of [...foundationWatchers.keys()]) closeFoundationWatchers(root);
    store.close();
    port.postMessage({ closed: true });
    port.close();
    return;
  }
  if (message.syncFoundations) {
    try { syncFoundationObservers(); }
    catch (error) { port.postMessage({ observerError: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  const id = Number(message.id);
  try {
    const items = store.pendingSidebarCoreProjectionInputs(Number(message.limit) || 16).map(input => {
      const nodes = new Map<string, RoadmapNodeLike[]>([[input.project.path, input.nodes]]);
      const projectPath = input.project.path;
      return {
        projectId: input.projectId,
        sourceRevision: input.sourceRevision,
        summary: buildProjectPortfolioSummary(input.project, {
          includeReusableSignals: true,
          roadmapNodesByProjectPath: nodes,
          investmentStatsByProjectPath: new Map([[projectPath, input.investmentStats]]),
          learningOverview: input.learningOverview,
          reusableSourceCountsByProjectPath: new Map([[projectPath, input.reusableSourceCount]]),
          documentationManifestsByProjectPath: new Map([[projectPath, input.documentationManifest]]),
          recentActivityAtByProjectPath: new Map([[projectPath, input.recentActivityAt]]),
          foundationAssessmentsByProjectPath: new Map([[projectPath, assessProjectFoundation(projectPath)]])
        })
      };
    });
    port.postMessage({ id, items, workerThreadId: threadId });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error), workerThreadId: threadId });
  }
});

syncFoundationObservers();
port.postMessage({ ready: true, workerThreadId: threadId });
