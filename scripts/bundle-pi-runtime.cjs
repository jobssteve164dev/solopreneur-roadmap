#!/usr/bin/env node

const path = require('node:path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');

esbuild.buildSync({
  stdin: {
    contents: [
      "export { Agent, AgentHarness, StorageBackedSession } from '@earendil-works/pi-agent-core';",
      "export { convertToLlm, DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, formatSize, prepareCompaction, shouldCompact, truncateHead } from '@earendil-works/pi-agent-core';",
      "export { compactWithRequest } from './node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js';",
      "export { buildSessionContext } from './node_modules/@earendil-works/pi-agent-core/dist/harness/session/context.js';",
      "export { TODO_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core/harness/context';",
      "export { createAssistantMessageEventStream } from '@earendil-works/pi-ai';",
      "export { getBuiltinModel, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';"
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
