#!/usr/bin/env node

const path = require('node:path');

const { runConfiguredPiMainPath } = require('../out/piMainPathRuntime.js');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = String(process.argv[index + 1] || '');
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function main() {
  const projectPath = path.resolve(argument('--project', process.cwd()));
  const globalDataPath = path.resolve(argument('--global-data-path', path.join(projectPath, '..', '.solomap-global')));
  const taskId = argument('--task-id');
  const instruction = argument('--instruction');
  const filePath = argument('--path');
  const commitTitle = argument('--commit-message', `docs: complete ${taskId}`);
  if (!taskId || !instruction || !filePath) {
    throw new Error('Usage: npm run pi:deliver -- --task-id <id> --instruction <text> --path <relative-file> [--commit-message <title>] [--push]');
  }
  const result = await runConfiguredPiMainPath({
    globalDataPath,
    request: {
      taskId,
      projectPath,
      instruction,
      allowedPaths: [filePath],
      commitMessage: `${commitTitle}\n\nSoloMap-Task: ${taskId}`,
      push: process.argv.includes('--push')
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
