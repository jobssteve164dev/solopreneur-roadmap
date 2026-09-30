const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('extension loads when the VS Code host guards the Node navigator global', () => {
  const extension = path.resolve(__dirname, '../out/extension.js');
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return {};
      return originalLoad.apply(this, arguments);
    };
    Object.defineProperty(globalThis, 'navigator', {
      get() { throw new Error('navigator is guarded by the extension host'); }
    });
    require(${JSON.stringify(extension)});
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('cold extension import defers MCP SDK initialization until a query', () => {
  const extension = path.resolve(__dirname, '../out/extension.js');
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return {};
      return originalLoad.apply(this, arguments);
    };
    require(${JSON.stringify(extension)});
    if (Object.keys(require.cache).some(key => key.includes('/@modelcontextprotocol/sdk/'))) {
      throw new Error('MCP SDK loaded during extension cold start');
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('read-only MCP answers inside a guarded VS Code extension host', () => {
  const mcp = path.resolve(__dirname, '../out/intelligenceMcp.js');
  const script = `
    Object.defineProperty(globalThis, 'navigator', {
      get() { throw new Error('navigator is guarded by the extension host'); }
    });
    const { createIntelligenceMcpSession } = require(${JSON.stringify(mcp)});
    (async () => {
      const session = await createIntelligenceMcpSession({
        getProjects: () => [{ name: 'Alpha', path: '/private/alpha' }],
        getSelectedProjectPath: () => '/private/alpha',
        getCurrentSteps: () => [],
        getSettings: () => ({ language: 'zh' })
      });
      try {
        const result = await session.client.callTool({ name: 'get_current_project', arguments: {} });
        if (!JSON.stringify(result).includes('Alpha')) throw new Error('read tool did not answer');
      } finally { await session.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
