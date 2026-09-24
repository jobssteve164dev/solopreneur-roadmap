#!/usr/bin/env node

const path = require('node:path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');

esbuild.buildSync({
  stdin: {
    contents: [
      "export { Agent } from '@earendil-works/pi-agent-core';",
      "export { createAssistantMessageEventStream } from '@earendil-works/pi-ai';"
    ].join('\n'),
    resolveDir: projectRoot,
    sourcefile: 'pi-agent-runtime-entry.mjs',
    loader: 'js'
  },
  outfile: path.join(projectRoot, 'out', 'piAgentRuntime.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  treeShaking: true,
  legalComments: 'eof',
  logLevel: 'warning'
});
