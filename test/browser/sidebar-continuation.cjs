const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { getSidebarWebviewHtml } = require('../../out/sidebarWebview.js');

// No workspace, Runtime, native Agent or persisted settings are used by this fixture.
test('continuation keeps its button through duplicate snapshots and background updates', async t => {
  const html = getSidebarWebviewHtml({ asWebviewUri: () => '', cspSource: '' }, { fsPath: path.resolve(__dirname, '../..') });
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    const project = { name: 'My project', path: '/isolated/project', nodes: [] };
    const snapshot = {
      command: 'sidebarProjectConversationSnapshotLoaded', projectPath: project.path,
      soloConversations: [{ id: 42, nodeId: '__solo__', agentCli: 'codex', status: 'Completed', summary: '继续完善首页',
        capabilities: { canContinue: true, canStop: false }, dataState: { runId: 'original-run', runRevision: 8 } }],
      projectConversations: [], flowConversations: [], revisionConversations: []
    };
    const deliver = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    await deliver({ command: 'projectsLoaded', projects: { projects: [project], portfolio: [project], selectedProjectPath: project.path } });
    await deliver(snapshot);
    await page.locator('[data-card-trigger-id="42"]').hover();
    await page.locator('.mini-btn-continue[data-continue-id="42"]').click();
    assert.equal((await page.locator('.mini-btn-continue[data-continue-id="42"]').textContent()).trim(), '', 'the compact entry keeps only its icon while pending');
    await deliver({ command: 'conversationActionSettled', action: 'continue', projectPath: project.path, conversationId: 42 });
    assert.equal((await page.locator('.mini-btn-continue[data-continue-id="42"]').textContent()).trim(), '', 'the compact entry keeps only its icon after delivery');
    await page.locator('[data-conversation-expand-id="42"]').click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => { window.originalButton = document.querySelector('[data-continue-id="42"]'); });
    for (let i = 0; i < 8; i++) await deliver(snapshot);
    assert.equal(await page.evaluate(() => window.originalButton === document.querySelector('[data-continue-id="42"]')), true,
      'unchanged snapshots must not rebuild the button');

    await page.locator('[data-continue-id="42"]').click();
    assert.equal(await page.evaluate(() => window.originalButton === document.querySelector('[data-continue-id="42"]')), true,
      'clicking continue must update the existing button');
    assert.equal(await page.locator('[data-continue-id="42"]').isDisabled(), true);
    await deliver({ command: 'projectIssuesLoaded', projectPath: project.path, issues: { available: true, openCount: 3 } });
    await deliver(snapshot);
    assert.equal(await page.evaluate(() => window.originalButton === document.querySelector('[data-continue-id="42"]')), true,
      'a refresh during launch must preserve the hovered action');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-continue-id="42"]').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.continue').length), 2);

    await deliver({ command: 'conversationActionSettled', action: 'continue', projectPath: project.path, conversationId: 42 });
    assert.equal(await page.locator('[data-continue-id="42"]').isDisabled(), false);
    await page.evaluate(() => { window.settledButton = document.querySelector('[data-continue-id="42"]'); });
    await deliver({ command: 'conversationActionSettled', action: 'continue', projectPath: project.path, conversationId: 42 });
    assert.equal(await page.evaluate(() => window.settledButton === document.querySelector('[data-continue-id="42"]')), true,
      'a duplicate acknowledgement must not redraw the card');

    await deliver({ ...snapshot, soloConversations: [{ ...snapshot.soloConversations[0], summary: '首页已完成', status: 'Running', dataState: { runId: 'continued-run', runRevision: 10 } }] });
    assert.match(await page.locator('.sidebar-conversation-summary-row').textContent(), /首页已完成/);
    assert.deepEqual(errors, []);
    t.diagnostic('final scripts parsed; real browser: stable button, single click, pending state, acknowledgement and new snapshot convergence');
  } finally { await browser.close(); }
});

test('same-numbered conversations keep pending and settled state isolated by project', async () => {
  const html = getSidebarWebviewHtml({ asWebviewUri: () => '', cspSource: '' }, { fsPath: path.resolve(__dirname, '../..') });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 1400 } });
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    const projects = [
      { name: 'Project A', path: '/isolated/project-a', nodes: [] },
      { name: 'Project B', path: '/isolated/project-b', nodes: [] }
    ];
    const deliver = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const snapshot = projectPath => ({
      command: 'sidebarProjectConversationSnapshotLoaded', projectPath,
      soloConversations: [{ id: 42, nodeId: '__solo__', agentCli: 'codex', status: 'Completed', summary: projectPath,
        capabilities: { canContinue: true, canStop: false }, dataState: { runId: projectPath, runRevision: 1 } }],
      projectConversations: [], flowConversations: [], revisionConversations: []
    });
    await deliver({ command: 'projectsLoaded', projects: { projects, portfolio: projects, selectedProjectPath: projects[0].path } });
    await deliver(snapshot(projects[0].path));
    await page.evaluate(() => { window.projectACardBeforeForeignSnapshot = document.querySelector('[data-select-project-path="/isolated/project-a"]'); });
    await deliver(snapshot(projects[1].path));
    assert.equal(await page.evaluate(() => window.projectACardBeforeForeignSnapshot === document.querySelector('[data-select-project-path="/isolated/project-a"]')), true,
      'a foreign project snapshot may update its cache but must not rebuild the selected project UI');
    const card = projectPath => page.locator(`[data-select-project-path="${projectPath}"]`);
    const pending = projectPath => card(projectPath).locator('[data-continue-id="42"]').evaluate(element => element.classList.contains('is-pending'));
    await card(projects[0].path).locator('[data-continue-id="42"]').click();
    assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.continue').at(-1)), {
      command: 'conversation.continue', projectPath: projects[0].path, nodeId: '__solo__', conversationId: '42'
    });
    assert.equal(await pending(projects[0].path), true);
    await deliver({ command: 'projectSelectionChanged', projectRoot: projects[1].path, generation: 1 });
    await deliver(snapshot(projects[1].path));
    assert.equal(await pending(projects[1].path), false,
      'switching projects must not copy project A pending state onto the same numeric id in project B');
    await page.evaluate(() => { window.projectBCardBeforeForeignActionResult = document.querySelector('[data-select-project-path="/isolated/project-b"]'); });
    await deliver({ command: 'sidebarActionFailed', action: 'conversation.continue', projectPath: projects[0].path, conversationId: 999, message: 'Project A failed' });
    assert.equal(await page.evaluate(() => window.projectBCardBeforeForeignActionResult === document.querySelector('[data-select-project-path="/isolated/project-b"]')), true,
      'a failure from project A must not rebuild the selected project B UI');
    await deliver({ command: 'roadmapRevisionLaunchRegistered', projectPath: projects[0].path });
    assert.equal(await page.evaluate(() => window.projectBCardBeforeForeignActionResult === document.querySelector('[data-select-project-path="/isolated/project-b"]')), true,
      'a launch acknowledgement from project A must not rebuild the selected project B UI');
    await deliver({ command: 'conversationActionSettled', action: 'continue', projectPath: projects[1].path, conversationId: 42 });
    await deliver({ command: 'projectSelectionChanged', projectRoot: projects[0].path, generation: 2 });
    await deliver({ ...snapshot(projects[0].path), soloConversations: [{ ...snapshot(projects[0].path).soloConversations[0], dataState: { runId: projects[0].path, runRevision: 2 } }] });
    assert.equal(await pending(projects[0].path), true,
      'a stale acknowledgement for project B must not release project A');
    await deliver({ command: 'conversationActionSettled', action: 'continue', projectPath: projects[0].path, conversationId: 42 });
    assert.equal(await pending(projects[0].path), false);
  } finally { await browser.close(); }
});

test('Actions and Issues launch once while refreshes cross pointer and keyboard activation', async t => {
  const html = getSidebarWebviewHtml({ asWebviewUri: () => '', cspSource: '' }, { fsPath: path.resolve(__dirname, '../..') });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    for (const [kind, selector] of [
      ['delivery', '[data-agent-fix-delivery-project-path]'], ['security', '[data-agent-fix-security-project-path]'],
      ['foundation', '[data-agent-fix-foundation-project-path]'], ['pr', '[data-agent-review-pr]'], ['issue', '[data-agent-fix-issue]']
    ]) await t.test(kind, async () => {
      const page = await browser.newPage({ viewport: { width: 600, height: 1200 } });
      try {
        await page.route('**/*', route => route.abort());
        await page.evaluate(() => {
          window.messages = [];
          window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
        });
        await page.setContent(html);
        const project = { name: 'My project', path: '/isolated/project', nodes: [],
          delivery: { available: true, recentWorkflowRuns: [{ name: 'CI', conclusion: 'failure' }] },
          security: { available: true, openCriticalHigh: 1, alerts: [{ title: 'Update dependency', severity: 'high', state: 'open' }] },
          foundation: { missingCount: 1, missing: ['README'] },
          pullRequests: { available: true, open: 1, items: [{ number: 7, title: 'Improve home', state: 'OPEN' }] },
          issues: { available: true, open: 1, items: [{ number: 13, title: 'Improve home', state: 'OPEN' }] }
        };
        const deliver = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
        await deliver({ command: 'projectsLoaded', projects: { projects: [project], portfolio: [project], selectedProjectPath: project.path, globalStore: { dataPath: '/isolated/first/.solomap-global' } } });
        if (kind === 'issue') {
          await page.locator('[data-toggle-issue-panel]').click();
          await page.locator('[data-expand-issue-number="13"]').click();
          await deliver({ command: 'issueDetailsLoaded', projectPath: project.path, ok: true, issue: { number: 13, title: 'Improve home', state: 'OPEN' }, comments: [] });
        } else await page.locator('[data-toggle-delivery-panel]').click();
        const button = page.locator(selector);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox(); assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.evaluate(selector => { window.pressedAction = document.querySelector(selector); }, selector);
        await deliver({ command: 'projectIssuesLoaded', projectPath: project.path, issues: { ...project.issues, open: 2 } });
        await page.mouse.up();
        assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').length), 1,
          'a refresh between press and release must not swallow activation');
        assert.equal(await page.evaluate(selector => window.pressedAction === document.querySelector(selector), selector), true,
          'activating an action must preserve the hovered button');
        assert.equal(await button.isDisabled(), true, 'only the launched action stays pending until terminal delivery');
        await page.mouse.move(0, 0);
        await page.locator('[data-project-conversation-input]').focus();
        await page.keyboard.type('Another independent request');
        assert.equal(await page.locator('[data-project-conversation-input]').inputValue(), 'Another independent request');
        await deliver({ command: 'projectDeliveryLoaded', projectPath: project.path, delivery: { ...project.delivery, latestRelease: 'v2' } });
        assert.equal(await button.isDisabled(), true, 'a card refresh must not release the pending action');
        const request = await page.evaluate(() => window.messages.find(message => message.command === 'conversation.runSolo'));
        assert.ok(request.launchActionId);
        await deliver({ command: 'conversationActionSettled', action: 'runSolo', projectPath: project.path, launchActionId: 'an-old-request' });
        assert.equal(await button.isDisabled(), true, 'a stale acknowledgement cannot reset this action');
        await deliver({ command: 'conversationActionSettled', action: 'runSolo', projectPath: project.path, launchActionId: request.launchActionId });
        assert.equal(await button.isDisabled(), false);
        await button.focus();
        await page.keyboard.down('Enter');
        await deliver({ command: 'projectIssuesLoaded', projectPath: project.path, issues: { ...project.issues, open: 3 } });
        await page.keyboard.up('Enter');
        assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').length), 2);
        if (kind === 'delivery') {
          const oldRequest = await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').at(-1));
          await deliver({ command: 'projectsLoaded', projects: { projects: [project], portfolio: [project], selectedProjectPath: project.path,
            globalStore: { dataPath: '/isolated/second/.solomap-global' } } });
          await page.locator('[data-toggle-delivery-panel]').click();
          assert.equal(await button.isDisabled(), false, 'changing data root releases only the previous scope UI state');
          await button.click();
          await deliver({ command: 'conversationActionSettled', action: 'runSolo', projectPath: project.path, launchActionId: oldRequest.launchActionId });
          assert.equal(await button.isDisabled(), true, 'the previous root acknowledgement cannot release the new launch');
        }
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
