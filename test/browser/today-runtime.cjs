// Run after compilation with Playwright available on NODE_PATH.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { getSidebarWebviewHtml } = require(path.join(root, 'out/sidebarWebview.js'));
Module._load = originalLoad;

const uri = { fsPath: root, toString: () => `file://${root}` };
const html = getSidebarWebviewHtml({ cspSource: 'self', asWebviewUri: value => value }, uri);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors = [];
    const messages = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('solomapPostMessage', message => messages.push(message));
    await page.evaluate(() => {
      let state = {};
      window.acquireVsCodeApi = () => ({
        getState: () => state,
        setState: next => { state = next; },
        postMessage: message => window.solomapPostMessage(message)
      });
    });
    await page.setContent(html);
    const portfolio = [
      { name: 'Alpha', path: '/workspace/alpha', globalPriority: 'P1', pendingNodes: 1, recommendedNodeTitle: '推进 Alpha', issues: { byPriority: {} }, delivery: {}, security: {} },
      { name: 'Beta', path: '/workspace/beta', globalPriority: 'P1', inProgressNodes: 1, recommendedNodeTitle: '推进 Beta', issues: { byPriority: {} }, delivery: {}, security: {} }
    ];
    await page.evaluate(data => window.postMessage({ command: 'projectsLoaded', projects: data }, '*'), {
      projects: portfolio.map(({ name, path }) => ({ name, path })),
      selectedProjectPath: '/workspace/alpha',
      portfolio
    });
    await page.evaluate(() => window.postMessage({
      command: 'dailyReviewLoaded',
      review: {
        source: 'runtime_shadow', status: 'completed', decisionId: 'decision-browser',
        recommendedProjectPath: '/workspace/beta', summary: '今天先推进 Beta', needsConfirmation: [],
        todos: [{ projectPath: '/workspace/beta', title: '推进 Beta', reason: '先收口已有进展。' }]
      }
    }, '*'));
    const names = await page.locator('.global-focus-name').allTextContents();
    assert.deepEqual(names.slice(0, 2), ['Beta', 'Alpha']);
    await page.locator('[data-global-focus-project="/workspace/beta"]').click();
    assert.ok(messages.some(message => message.command === 'recordTodayShadowFeedback' && message.outcome === 'accepted'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ names: names.slice(0, 2), feedback: 'accepted', pageErrors: errors.length }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
