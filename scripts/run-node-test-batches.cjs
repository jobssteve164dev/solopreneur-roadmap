#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');

function usage() {
  console.error('Usage: node scripts/run-node-test-batches.cjs [--batch-size=N] [--from=N] [--to=N] [--test-timeout=N] <test-file>');
}

function collectTopLevelTestNames(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const declaration = "const test = require('node:test');";
  if (!source.includes(declaration)) throw new Error(`node_test_declaration_missing:${filePath}`);
  const names = [];
  const collector = name => { names.push(String(name)); };
  for (const method of ['after', 'afterEach', 'before', 'beforeEach']) collector[method] = () => {};
  for (const method of ['only', 'skip', 'todo']) collector[method] = collector;

  const marker = '__solomapNodeTestCollector';
  if (globalThis[marker]) throw new Error('node_test_collector_already_active');
  globalThis[marker] = collector;
  const definitionModule = new Module(filePath, module);
  definitionModule.filename = filePath;
  definitionModule.paths = Module._nodeModulePaths(path.dirname(filePath));
  try {
    definitionModule._compile(source.replace(declaration, `const test = globalThis.${marker};`), filePath);
  } finally {
    delete globalThis[marker];
  }
  return [...new Set(names)];
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run() {
  const args = process.argv.slice(2);
  const sizeArgument = args.find(value => value.startsWith('--batch-size='));
  const batchSize = Number(sizeArgument?.slice('--batch-size='.length) || 50);
  const fromArgument = args.find(value => value.startsWith('--from='));
  const toArgument = args.find(value => value.startsWith('--to='));
  const timeoutArgument = args.find(value => value.startsWith('--test-timeout='));
  const from = Number(fromArgument?.slice('--from='.length) || 1);
  const to = Number(toArgument?.slice('--to='.length) || Number.MAX_SAFE_INTEGER);
  const testTimeout = Number(timeoutArgument?.slice('--test-timeout='.length) || 120_000);
  const files = args.filter(value => !/^--(?:batch-size|from|to|test-timeout)=/.test(value));
  if (files.length !== 1 || !Number.isInteger(batchSize) || batchSize < 1
    || !Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from
    || !Number.isInteger(testTimeout) || testTimeout < 1) {
    usage();
    process.exitCode = 2;
    return;
  }

  const filePath = path.resolve(files[0]);
  const allNames = collectTopLevelTestNames(filePath);
  if (!allNames.length) throw new Error(`node_tests_missing:${filePath}`);
  const names = allNames.slice(from - 1, Math.min(to, allNames.length));
  if (!names.length) throw new Error(`node_test_range_empty:${from}:${to}:${allNames.length}`);
  const batches = [];
  for (let index = 0; index < names.length; index += batchSize) batches.push(names.slice(index, index + batchSize));

  let activeChild;
  let interruptedSignal;
  const interrupt = signal => {
    interruptedSignal = signal;
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill(signal);
  };
  process.once('SIGINT', () => interrupt('SIGINT'));
  process.once('SIGTERM', () => interrupt('SIGTERM'));

  for (let index = 0; index < batches.length; index++) {
    if (interruptedSignal) break;
    const pattern = `^(?:${batches[index].map(escapeRegularExpression).join('|')})$`;
    const firstOrdinal = from + index * batchSize;
    console.log(`[node-test-batch ${index + 1}/${batches.length}] tests ${firstOrdinal}-${firstOrdinal + batches[index].length - 1}`);
    const wrapper = path.join(__dirname, 'run-node-tests.cjs');
    activeChild = childProcess.spawn(process.execPath, [wrapper, '--test-force-exit', `--test-timeout=${testTimeout}`, `--test-name-pattern=${pattern}`, filePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    });
    const result = await new Promise((resolve, reject) => {
      activeChild.once('error', reject);
      activeChild.once('exit', (code, signal) => resolve({ code, signal }));
    });
    activeChild = undefined;
    if (result.code !== 0) {
      process.exitCode = result.code ?? (result.signal ? 128 : 1);
      return;
    }
  }
  if (interruptedSignal) process.exitCode = 128;
}

run().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
