// Run after npm run compile; use the existing Playwright installation via NODE_PATH.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const webview = { asWebviewUri: () => '', cspSource: '' };
const uri = { fsPath: root };
const projects = [
  { path: '/fixture/a', name: 'Project A' },
  { path: '/fixture/b', name: 'Project B' }
];

(async () => {
  const html = require('../../out/sidebarWebview.js').getSidebarWebviewHtml(webview, uri);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({
        postMessage: message => window.messages.push(message),
        getState: () => ({}),
        setState() {}
      });
    });
    await page.setContent(html);
    const send = message => page.evaluate(value => {
      window.dispatchEvent(new MessageEvent('message', { data: value }));
    }, message);
    const loadProjects = (portfolio = projects, updatedProjectPaths) => send({
      command: 'projectsLoaded',
      projects: {
        projects,
        selectedProjectPath: projects[0].path,
        portfolio,
        ...(updatedProjectPaths === undefined ? {} : { updatedProjectPaths })
      }
    });

    await send({ command: 'settingsLoaded', settings: { language: 'zh', cliPath: 'agy', agentModelPreferences: {} } });
    await loadProjects();
    const initialStateLoad = await page.evaluate(() => window.messages.filter(message => message.command === 'uiState.load').at(-1));
    assert.ok(initialStateLoad, 'the selected project state is loaded once');
    await send({ command: 'uiStateLoaded', view: 'sidebar', scopeKey: initialStateLoad.scopeKey, loadRequestId: initialStateLoad.loadRequestId, state: {} });
    await page.evaluate(() => { window.messages = []; });

    await loadProjects([{ ...projects[1], description: 'background update' }], [projects[1].path]);
    assert.equal(
      await page.evaluate(() => window.messages.filter(message => message.command === 'uiState.load').length),
      0,
      'background project updates must not reload stable UI state'
    );

    await page.locator('[data-toggle-issue-panel]').click();
    await page.locator('[data-toggle-issue-form]').click();
    const issueTitle = page.locator('[data-issue-title]');
    await issueTitle.focus();
    await issueTitle.fill('保留这段输入');
    const issueTitleHandle = await issueTitle.elementHandle();
    await send({ command: 'projectIssuesLoaded', projectPath: projects[0].path, issues: { available: true, openCount: 1 } });
    await page.waitForTimeout(20);
    assert.equal(await issueTitleHandle.evaluate(element => element.isConnected), true, 'a focused card input must not be rebuilt');
    assert.equal(await issueTitle.inputValue(), '保留这段输入');
    await issueTitle.blur();
    await page.waitForTimeout(20);
    assert.equal(await page.locator('[data-issue-title]').inputValue(), '保留这段输入');

    const button = page.locator('[data-open-project-path="/fixture/a"]');
    const box = await button.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await send({ command: 'projectIssuesLoaded', projectPath: projects[0].path, issues: { available: true, openCount: 1 } });
    await page.mouse.up();
    await page.waitForTimeout(20);
    assert.deepEqual(
      await page.evaluate(() => window.messages.filter(message => message.command === 'project.openRoadmap')),
      [{ command: 'project.openRoadmap', projectPath: projects[0].path }],
      'a background card update must not swallow the active pointer action'
    );

    await page.evaluate(() => { window.messages = []; });
    const otherCard = page.locator('[data-select-project-path="/fixture/b"]');
    await otherCard.scrollIntoViewIfNeeded();
    const otherBox = await otherCard.boundingBox();
    assert.ok(otherBox);
    await page.mouse.move(otherBox.x + 4, otherBox.y + 4);
    await page.mouse.down();
    await send({ command: 'projectPullRequestsLoaded', projectPath: projects[1].path, pullRequests: { available: true, openCount: 2 } });
    await page.mouse.up();
    await page.waitForTimeout(20);
    assert.deepEqual(
      await page.evaluate(() => window.messages.filter(message => message.command === 'project.select')),
      [{ command: 'project.select', projectPath: projects[1].path }],
      'the shared card guard must preserve project selection actions too'
    );

    await page.evaluate(() => { window.messages = []; });
    const growth = page.locator('[data-open-project-growth-path="/fixture/a"]');
    await growth.focus();
    await growth.press('Enter');
    assert.deepEqual(
      await page.evaluate(() => window.messages.filter(message => message.command === 'project.openGrowth')),
      [{ command: 'project.openGrowth', projectPath: projects[0].path }],
      'keyboard activation remains available after background updates'
    );

    const securityPage = await browser.newPage();
    await securityPage.route('**/*', route => route.abort());
    await securityPage.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({
        postMessage: message => window.messages.push(message),
        getState: () => ({}),
        setState() {}
      });
    });
    await securityPage.setContent(html);
    const sendSecurity = message => securityPage.evaluate(value => {
      window.dispatchEvent(new MessageEvent('message', { data: value }));
    }, message);
    await sendSecurity({ command: 'settingsLoaded', settings: { language: 'zh', cliPath: 'codex', agentModelPreferences: {} } });
    await sendSecurity({
      command: 'projectsLoaded',
      projects: {
        projects,
        selectedProjectPath: projects[0].path,
        portfolio: [{
          ...projects[0],
          security: {
            available: true,
            openCriticalHigh: 1,
            alerts: [{ title: 'Fixture high risk', source: 'Dependabot', severity: 'high', state: 'open' }]
          }
        }, projects[1]]
      }
    });
    await securityPage.evaluate(() => document.querySelector('[data-toggle-delivery-panel]').click());
    await securityPage.evaluate(() => {
      window.messages = [];
      const portfolio = document.getElementById('portfolio-list');
      const querySelectorAll = portfolio.querySelectorAll.bind(portfolio);
      portfolio.querySelectorAll = selector => {
        if (selector === '[data-select-project-path]') throw new Error('fixture_render_interrupted');
        return querySelectorAll(selector);
      };
    });
    await securityPage.evaluate(() => document.querySelector('[data-agent-fix-security-project-path="/fixture/a"]').click());
    assert.deepEqual(
      await securityPage.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').map(message => ({ command: message.command, projectPath: message.projectPath }))),
      [{ command: 'conversation.runSolo', projectPath: projects[0].path }],
      'security repair must leave the webview before status rendering can delay or interrupt it'
    );
    await securityPage.close();

    console.log(JSON.stringify({ stableUiStateLoads: true, pointerActionSurvivesRefresh: true, keyboardActionWorks: true, focusedInputSurvivesRefresh: true, securityActionEscapesRender: true }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
