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
    await page.evaluate(() => {
      window.__unchangedProjectCard = document.querySelector('[data-select-project-path="/workspace/alpha"]');
      window.postMessage({ command: 'projectIssuesLoaded', projectPath: '/workspace/beta', issues: { openCount: 1, issues: [], syncedAt: new Date().toISOString() } }, '*');
    });
    assert.equal(await page.evaluate(() => window.__unchangedProjectCard === document.querySelector('[data-select-project-path="/workspace/alpha"]')), true);
    await page.evaluate(() => window.postMessage({ command: 'projectsLoaded', projects: {
      projects: [{ name: 'Alpha', path: '/workspace/alpha' }, { name: 'Beta', path: '/workspace/beta' }],
      selectedProjectPath: '/workspace/alpha', portfolio: [], updatedProjectPaths: [], globalStore: { portfolio: [] }
    } }, '*'));
    assert.equal(await page.evaluate(() => window.__unchangedProjectCard === document.querySelector('[data-select-project-path="/workspace/alpha"]')), true);
    await page.evaluate(data => window.postMessage({ command: 'projectsLoaded', projects: {
      projects: data.map(({ name, path }) => ({ name, path })),
      selectedProjectPath: '/workspace/alpha',
      portfolio: [{ ...data[1], issuePressure: '1' }],
      updatedProjectPaths: ['/workspace/beta']
    } }, '*'), portfolio);
    assert.equal(await page.evaluate(() => window.__unchangedProjectCard === document.querySelector('[data-select-project-path="/workspace/alpha"]')), true);
    await page.locator('[data-refresh-project-path="/workspace/beta"]').click();
    assert.equal(await page.evaluate(() => window.__unchangedProjectCard === document.querySelector('[data-select-project-path="/workspace/alpha"]')), true);
    assert.ok(messages.some(message => message.command === 'project.refreshExternalData' && message.projectPath === '/workspace/beta'));
    await page.locator('[data-project-conversation-input]').focus();
    await page.evaluate(() => {
      window.__beforeAlphaIssue = document.querySelector('[data-select-project-path="/workspace/alpha"]');
      window.__beforeBetaIssue = document.querySelector('[data-select-project-path="/workspace/beta"]');
      window.postMessage({ command: 'projectIssuesLoaded', projectPath: '/workspace/alpha', issues: { openCount: 2, issues: [], syncedAt: new Date().toISOString() } }, '*');
      window.postMessage({ command: 'projectIssuesLoaded', projectPath: '/workspace/beta', issues: { openCount: 3, issues: [], syncedAt: new Date().toISOString() } }, '*');
    });
    await page.locator('body').click({ position: { x: 380, y: 880 } });
    await page.waitForFunction(() =>
      window.__beforeAlphaIssue !== document.querySelector('[data-select-project-path="/workspace/alpha"]')
      && window.__beforeBetaIssue !== document.querySelector('[data-select-project-path="/workspace/beta"]')
    );
    assert.deepEqual(await page.evaluate(() => [
      window.__beforeAlphaIssue !== document.querySelector('[data-select-project-path="/workspace/alpha"]'),
      window.__beforeBetaIssue !== document.querySelector('[data-select-project-path="/workspace/beta"]')
    ]), [true, true]);
    await page.evaluate(() => window.postMessage({
      command: 'dailyReviewLoaded',
      review: {
        source: 'runtime_shadow', status: 'completed', decisionId: 'decision-browser-many',
        recommendedProjectPath: '/workspace/beta', summary: '今天先推进 Beta', needsConfirmation: [],
        todos: [
          { projectPath: '/workspace/beta', title: '推进 Beta', reason: '先收口已有进展。' },
          ...Array.from({ length: 5 }, (_, index) => ({
            projectPath: `/workspace/other-${index + 1}`,
            title: `其他项目 ${index + 1}`,
            reason: `建议 ${index + 1}`
          }))
        ]
      }
    }, '*'));
    assert.equal(await page.locator('.daily-review-panel [data-daily-review-index]').count(), 3);
    await page.locator('[data-global-focus-project="/workspace/beta"]').click();
    assert.ok(messages.some(message => message.command === 'recordTodayShadowFeedback' && message.outcome === 'accepted'));
    await page.locator('#btn-toggle-settings').click();
    assert.ok(messages.some(message => message.command === 'checkDependencies'));
    await page.evaluate(() => window.postMessage({
      command: 'dependenciesChecked',
      status: {
        agentReady: true,
        agentMessage: 'codex is ready.',
        agentAutomationReady: true,
        agentAutomationMessage: 'codex can run tasks.',
        githubAuthReady: true,
        githubMessage: 'GitHub is ready.',
        supportedAgents: [{
          family: 'codex', title: 'Codex', command: 'codex', installed: true, selected: true,
          automationReady: true, automationPreconfigured: true,
          account: {
            state: 'ready', plan: 'Pro',
            usage: [{ usedPercent: 64, windowMinutes: 300, resetsAt: 1893456000 }],
            credits: { hasCredits: true, unlimited: false, balance: '12.50' }
          }
        }]
      }
    }, '*'));
    assert.match(await page.locator('#agent-readiness-panel').textContent(), /Pro/);
    assert.match(await page.locator('#agent-readiness-panel').textContent(), /36%/);
    assert.match(await page.locator('#agent-readiness-panel').textContent(), /12\.50/);
    await page.locator('#setting-cognitive-engine-agent [data-solo-trigger]').click();
    await page.locator('#setting-cognitive-engine-agent [data-solo-option-value="codex"]').click();
    assert.equal(await page.locator('#setting-cognitive-engine-agent').getAttribute('data-value'), 'codex');
    assert.match(await page.locator('#help-cognitive-engine-agent').textContent(), /不会打开终端窗口/);
    await page.locator('#setting-telegram-enabled [data-solo-trigger]').click();
    await page.locator('#setting-telegram-enabled [data-solo-option-value="on"]').click();
    assert.equal(await page.locator('#setting-telegram-enabled').getAttribute('data-value'), 'on');
    await page.locator('#setting-telegram-token').fill('mock-bot-token');
    assert.equal(await page.locator('#setting-telegram-token').getAttribute('type'), 'password');
    if (process.env.SOLOMAP_BROWSER_SCREENSHOT) {
      await page.screenshot({ path: process.env.SOLOMAP_BROWSER_SCREENSHOT, fullPage: true });
    }
    await page.locator('#btn-save-settings').click();
    assert.ok(messages.some(message => message.command === 'settings.update' && message.cognitiveEngineAgent === 'codex'));
    assert.ok(messages.some(message => message.command === 'settings.update' && message.telegramEnabled === true && message.telegramBotToken === 'mock-bot-token'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ names: names.slice(0, 2), feedback: 'accepted', cognitiveEngineAgent: 'codex', pageErrors: errors.length }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
