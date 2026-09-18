#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectReviewManifest, reviewHash } = require('../../out/learningReview.js');

function argsOf(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) result._.push(value);
    else result[value.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(temporary, 'utf8'));
  fs.renameSync(temporary, file);
}

function readPrompt(promptFile) {
  const text = fs.readFileSync(promptFile, 'utf8');
  const match = text.match(/^当前全局默认提示词JSON=(.*)$/m) || text.match(/^当前编辑器中的全局默认提示词=(.*)$/m);
  if (!match) throw new Error('Review prompt does not contain the current global prompt');
  return JSON.parse(match[1]);
}

function projectsFrom(globalRoot, workspace) {
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(globalRoot, 'projects.json'), 'utf8')); } catch { registry = {}; }
  const hidden = new Set((registry.hiddenProjects || []).map(item => path.resolve(typeof item === 'string' ? item : item.path || '')));
  const projects = (registry.projects || []).map(item => typeof item === 'string' ? item : item.path).filter(Boolean);
  if (workspace && !hidden.has(path.resolve(workspace))) projects.push(workspace);
  return [...new Set(projects.map(item => path.resolve(item)).filter(item => fs.existsSync(item) && !hidden.has(item)))];
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args._[0] !== 'collect') {
    console.log('Usage: solomap-review.cjs collect --run-id <id> --run-dir <path> --global <path> --workspace <path> --prompt-file <path>');
    return;
  }
  const runId = String(args['run-id'] || '');
  const runDir = path.resolve(String(args['run-dir'] || ''));
  const globalRoot = path.resolve(String(args.global || ''));
  const workspace = String(args.workspace || '');
  const promptFile = path.resolve(String(args['prompt-file'] || ''));
  if (!runId || path.basename(runDir) !== runId || !globalRoot || !fs.existsSync(promptFile)) throw new Error('Invalid incremental review arguments');
  const globalPrompt = readPrompt(promptFile);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(globalRoot, 'maintenance', 'review-state.json'), 'utf8')); } catch { state = {}; }
  const appliedSources = state.sources && typeof state.sources === 'object' ? state.sources : {};
  const deferredSourceIds = Array.isArray(state.deferredSourceIds) ? state.deferredSourceIds : [];
  const deferredSources = Array.isArray(state.deferredSources) ? Object.fromEntries(state.deferredSources.filter(source => source && typeof source.id === 'string').map(source => [source.id, source])) : {};
  const previousSources = { ...appliedSources, ...deferredSources };
  const manifest = await collectReviewManifest({
    runId,
    globalRoot,
    globalPrompt,
    projects: projectsFrom(globalRoot, workspace),
    incremental: true,
    includeGithub: false,
    previousSources,
    deferredSourceIds
  });
  for (const [id, previous] of Object.entries(previousSources)) {
    if (!previous || typeof previous !== 'object' || manifest.sources.some(source => source.id === id)) continue;
    if (previous.kind === 'deleted_source') {
      if (deferredSourceIds.includes(id)) manifest.sources.push(previous);
      continue;
    }
    if (typeof previous.file !== 'string' || fs.existsSync(previous.file)) continue;
    const value = { file: previous.file, previousHash: previous.hash, previousKind: previous.kind, ...(typeof previous.content === 'string' ? {} : { contentUnavailable: true }) };
    manifest.sources.push({ id, kind: 'deleted_source', projectPath: previous.projectPath, hash: reviewHash(JSON.stringify(value)), content: previous.content, value });
  }
  const persistedMatch = fs.readFileSync(promptFile, 'utf8').match(/^当前已持久化提示词哈希=([a-f0-9]{64})$/m);
  if (!persistedMatch) throw new Error('Review prompt does not contain the persisted prompt hash');
  manifest.persistedPromptHash = persistedMatch[1];
  const manifestFile = path.join(runDir, 'manifest.json');
  writeJson(manifestFile, manifest);
  writeJson(path.join(runDir, 'context-index.json'), {
    schemaVersion: 1,
    runId,
    manifestHash: reviewHash(JSON.stringify(manifest)),
    previousState: path.join(globalRoot, 'maintenance', 'review-state.json'),
    gaps: manifest.gaps,
    sources: manifest.sources.map(({ id, kind, file, hash, size, mtimeMs, ctimeMs, dev, ino, projectPath }) => ({ id, kind, file, hash, size, mtimeMs, ctimeMs, dev, ino, projectPath })),
    memory: manifest.memory.map(({ relativePath, hash }) => ({ relativePath, hash }))
  });
  console.log(JSON.stringify({ runId, sources: manifest.sources.length, memory: manifest.memory.length, gaps: manifest.gaps.length }));
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
