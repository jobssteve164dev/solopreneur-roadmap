// Run after npm run compile; use the existing Playwright installation via NODE_PATH.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const webview = { asWebviewUri: () => '', cspSource: '' };
const uri = { fsPath: root };
const projects = [
  { path: '/fixture/a', name: 'Project A', delivery: { available: true, recentWorkflowRuns: [] } },
  { path: '/fixture/b', name: 'Project B' }
];

(async () => {
  const html = require('../../out/sidebarWebview.js').getSidebarWebviewHtml(webview, uri);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 1000 } });
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
    const codiconFont = fs.readFileSync(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf')).toString('base64');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.css'), 'utf8')
      .replace(/url\("\.\/codicon\.ttf[^\"]*"\)/, 'url("data:font/ttf;base64,' + codiconFont + '")') });
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
    const sourcePanel = page.locator('[data-source-panel="/fixture/a"]');
    const sourceToggle = page.locator('[data-toggle-source-panel="/fixture/a"]');
    assert.equal(await sourcePanel.count(), 1, 'the selected project exposes one Source panel');
    assert.equal(await sourceToggle.getAttribute('aria-expanded'), 'false', 'Source starts collapsed');
    await page.waitForFunction(() => window.messages.some(message => message.command === 'source.read'), null, { timeout: 2000 });
    const sourceReads = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read'));
    assert.equal(sourceReads.length, 1, 'the selected project loads Source once without expanding it');
    assert.equal(sourceReads[0].projectPath, '/fixture/a');
    assert.ok(sourceReads[0].requestId);
    assert.equal(sourceReads[0].sourceEpoch, 0);
    const selectedCardBeforeSource = await page.locator('.portfolio-card.is-selected').elementHandle();
    const composerBeforeSource = await page.locator('[data-project-conversation-input]').elementHandle();
    await page.locator('[data-project-conversation-input]').fill('分支读取期间保留输入');
    await page.locator('[data-project-conversation-input]').focus();
    await loadProjects();
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').length), 1,
      'ordinary project updates reuse the pending read');
    await send({
      command: 'sourceSnapshotResolved',
      projectPath: '/fixture/a',
      requestId: sourceReads[0].requestId,
      sourceEpoch: 0,
      snapshot: {
        available: true,
        currentBranch: 'main',
        detachedHead: '',
        branches: [{ name: 'main', current: true }, { name: 'feature/source', current: false }]
      }
    });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'main');
    assert.equal(await sourceToggle.getAttribute('aria-expanded'), 'false', 'current branch is visible while Source stays collapsed');
    assert.equal(await page.locator('[data-source-current-branch]').isVisible(), true);
    assert.equal(await selectedCardBeforeSource.evaluate(element => element.isConnected), true, 'Source readback preserves the selected card');
    assert.equal(await composerBeforeSource.evaluate(element => element.isConnected && document.activeElement === element), true,
      'Source readback preserves the active conversation input');
    assert.equal(await page.locator('[data-project-conversation-input]').inputValue(), '分支读取期间保留输入');
    const sourceAppearance = await sourcePanel.evaluate(element => {
      const style = getComputedStyle(element);
      const actions = getComputedStyle(document.querySelector('[data-delivery-action-panel]'));
      const toggle = getComputedStyle(element.querySelector('[data-toggle-source-panel]'));
      const issueToggle = getComputedStyle(document.querySelector('[data-toggle-issue-panel]'));
      return { radius: style.borderRadius, padding: style.padding, actionsRadius: actions.borderRadius, actionsPadding: actions.padding,
        toggleWidth: toggle.width, toggleHeight: toggle.height, issueToggleWidth: issueToggle.width, issueToggleHeight: issueToggle.height };
    });
    assert.equal(sourceAppearance.radius, sourceAppearance.actionsRadius, 'Source shares Actions card corners');
    assert.equal(sourceAppearance.padding, sourceAppearance.actionsPadding, 'Source shares Actions card spacing');
    assert.equal(sourceAppearance.toggleWidth, sourceAppearance.issueToggleWidth, 'Source shares Issues disclosure width');
    assert.equal(sourceAppearance.toggleHeight, sourceAppearance.issueToggleHeight, 'Source shares Issues disclosure height');
    const sourceIcon = await sourcePanel.locator('.codicon-source-control').evaluate(element => getComputedStyle(element, '::before').content);
    const actionIcon = await page.locator('[data-delivery-action-panel] .codicon-rocket').evaluate(element => getComputedStyle(element, '::before').content);
    assert.notEqual(sourceIcon, actionIcon, 'Source keeps its branch icon while Actions keeps its rocket icon');
    assert.match(await sourceToggle.getAttribute('aria-label'), /main/, 'keyboard users can read the full branch from the disclosure');
    if (process.env.SOURCE_CARD_SCREENSHOT_DIR) {
      await page.locator('.portfolio-card.is-selected').screenshot({ path: path.join(process.env.SOURCE_CARD_SCREENSHOT_DIR, 'source-collapsed.png') });
    }
    await sourceToggle.click();
    assert.equal(await sourceToggle.getAttribute('aria-expanded'), 'true', 'Source expands immediately');
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').length), 1,
      'expansion reuses the automatically loaded snapshot');
    assert.equal(await page.locator('[data-source-branch]').count(), 2);
    if (process.env.SOURCE_CARD_SCREENSHOT_DIR) {
      await page.locator('.portfolio-card.is-selected').screenshot({ path: path.join(process.env.SOURCE_CARD_SCREENSHOT_DIR, 'source-expanded.png') });
    }
    const sourceSearch = page.locator('[data-source-search]');
    await sourceSearch.fill('feature');
    assert.equal(await page.locator('[data-source-branch]:visible').count(), 1, 'branch search filters locally without another Git request');
    assert.equal(
      await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').length),
      1,
      'local search does not request another Source snapshot'
    );
    const sourceSearchBeforeStatus = await sourceSearch.elementHandle();
    await send({
      command: 'sourceStatusResolved', projectPath: '/fixture/a', requestId: sourceReads[0].requestId, sourceEpoch: 0,
      status: { changedFiles: 2, upstream: 'origin/main', ahead: 1, behind: 0, statusLoaded: true }
    });
    assert.equal(await sourceSearchBeforeStatus.evaluate(element => element.isConnected), true, 'status enhancement keeps Source controls stable');
    assert.equal(await sourceSearch.inputValue(), 'feature');
    assert.match(await page.locator('[data-source-status]').textContent(), /2 个文件有改动/);
    await send({
      command: 'sourceStatusResolved', projectPath: '/fixture/a', requestId: sourceReads[0].requestId, sourceEpoch: 0,
      status: { changedFiles: 0, upstream: '', ahead: 0, behind: 0, statusLoaded: false, statusError: true }
    });
    assert.match(await page.locator('[data-source-status]').textContent(), /工作区状态暂时无法读取/);
    assert.doesNotMatch(await page.locator('[data-source-status]').textContent(), /工作区已同步/);
    await page.locator('[data-refresh-source]').click();
    const refreshRead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').at(-1));
    assert.notEqual(refreshRead.requestId, sourceReads[0].requestId);
    await page.locator('[data-switch-source-branch="feature/source"]').click();
    const switchAction = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').at(-1));
    assert.equal(switchAction.branch, 'feature/source');
    assert.equal(switchAction.sourceEpoch, 1, 'a branch mutation advances the Source epoch');
    await send({
      command: 'sourceSnapshotResolved', projectPath: '/fixture/a', requestId: refreshRead.requestId,
      sourceEpoch: 0, snapshot: { available: true, currentBranch: 'stale', detachedHead: '', branches: [{ name: 'stale', current: true }] }
    });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'main', 'a pre-mutation read cannot overwrite Source after the epoch advances');
    await sourceSearch.focus();
    const sourceSearchHandle = await sourceSearch.elementHandle();
    await send({
      command: 'sourceActionSettled', action: 'switch', success: true, projectPath: '/fixture/a',
      requestId: switchAction.requestId, sourceEpoch: 1,
      snapshot: {
        available: true, currentBranch: 'feature/source', detachedHead: '',
        branches: [{ name: 'feature/source', current: true }, { name: 'main', current: false }]
      }
    });
    assert.equal(await sourceSearchHandle.evaluate(element => element.isConnected), true, 'Source results keep the active search node stable');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-source-search')), true, 'Source results preserve search focus');
    assert.equal(await sourceSearch.inputValue(), 'feature');
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'feature/source');

    await page.locator('[data-toggle-source-create]').click();
    const createInput = page.locator('[data-source-create-input]');
    await createInput.fill('feature/new-card');
    await page.locator('[data-create-source-branch]').click();
    const createAction = await page.evaluate(() => window.messages.filter(message => message.command === 'source.createBranch').at(-1));
    assert.equal(createAction.branch, 'feature/new-card');
    assert.equal(createAction.sourceEpoch, 2);
    await page.evaluate(() => { window.messages = []; });
    await send({
      command: 'sourceActionSettled', action: 'create', success: true, projectPath: '/fixture/a',
      requestId: createAction.requestId, sourceEpoch: 2,
      snapshot: {
        available: true, currentBranch: 'feature/new-card', detachedHead: '',
        branches: [{ name: 'feature/new-card', current: true }, { name: 'feature/source', current: false }, { name: 'main', current: false }]
      }
    });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'feature/new-card');
    assert.equal(await page.locator('[data-source-create-row]').isHidden(), true, 'successful creation closes the local form');
    await page.waitForTimeout(160);
    const sourceStatePatches = await page.evaluate(() => window.messages
      .filter(message => message.command === 'uiState.patch')
      .flatMap(message => message.patches || [{ key: message.key, value: message.value }]));
    assert.equal(sourceStatePatches.some(patch => patch.key.endsWith('sourceCreateDraft') && patch.value === ''), true,
      'successful creation persists the cleared Source draft');

    const pointerSwitchCount = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').length);
    const pointerSwitchButton = page.locator('[data-switch-source-branch="feature/source"]');
    const pointerSwitchBox = await pointerSwitchButton.boundingBox();
    assert.ok(pointerSwitchBox);
    await page.mouse.move(pointerSwitchBox.x + pointerSwitchBox.width / 2, pointerSwitchBox.y + pointerSwitchBox.height / 2);
    await page.mouse.down();
    await send({
      command: 'sourceStatusResolved', projectPath: '/fixture/a', requestId: createAction.requestId, sourceEpoch: 2,
      status: { changedFiles: 1, upstream: '', ahead: 0, behind: 0, statusLoaded: true, statusError: false }
    });
    await page.mouse.up();
    await page.waitForTimeout(20);
    const pointerSwitchAction = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').at(-1));
    assert.equal(
      await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').length),
      pointerSwitchCount + 1,
      'a status enhancement between pointerdown and click cannot swallow a branch switch'
    );
    assert.equal(pointerSwitchAction.branch, 'feature/source');
    assert.equal(pointerSwitchAction.sourceEpoch, 3);
    await send({
      command: 'sourceActionSettled', action: 'switch', success: true, projectPath: '/fixture/a',
      requestId: pointerSwitchAction.requestId, sourceEpoch: 3,
      snapshot: {
        available: true, currentBranch: 'feature/source', detachedHead: '', statusLoaded: false,
        branches: [{ name: 'feature/source', current: true }, { name: 'main', current: false }]
      }
    });

    await sourceSearch.fill('');
    await page.locator('[data-refresh-source]').click();
    const keyboardRead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').at(-1));
    const keyboardSwitchCount = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').length);
    await page.locator('[data-switch-source-branch="main"]').focus();
    await page.keyboard.down('Space');
    await send({
      command: 'sourceSnapshotResolved', projectPath: '/fixture/a', requestId: keyboardRead.requestId, sourceEpoch: 3,
      snapshot: {
        available: true, currentBranch: 'feature/source', detachedHead: '', statusLoaded: false,
        branches: [{ name: 'feature/source', current: true }, { name: 'main', current: false }]
      }
    });
    await page.keyboard.up('Space');
    await page.waitForTimeout(20);
    const keyboardSwitchAction = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').at(-1));
    assert.equal(
      await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').length),
      keyboardSwitchCount + 1,
      'a Source snapshot between Space keydown and keyup cannot swallow keyboard activation'
    );
    assert.equal(keyboardSwitchAction.branch, 'main');
    assert.equal(keyboardSwitchAction.sourceEpoch, 4);
    await send({
      command: 'sourceActionSettled', action: 'switch', success: true, projectPath: '/fixture/a',
      requestId: keyboardSwitchAction.requestId, sourceEpoch: 4,
      snapshot: {
        available: true, currentBranch: 'main', detachedHead: '', statusLoaded: false,
        branches: [{ name: 'main', current: true }, { name: 'feature/source', current: false }]
      }
    });

    await page.locator('[data-source-search]').fill('');
    await page.locator('[data-refresh-source]').click();
    const abaRead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').at(-1));
    const selectB = page.locator('[data-select-project-path="/fixture/b"]');
    await selectB.click();
    const selectBMessage = await page.evaluate(() => window.messages.filter(message => message.command === 'project.select').at(-1));
    await send({ command: 'projectSelectionChanged', projectRoot: '/fixture/b', generation: 1, interactionId: selectBMessage.interactionId });
    await page.waitForFunction(() => window.messages.some(message => message.command === 'source.read' && message.projectPath === '/fixture/b'));
    const sourceBRead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read' && message.projectPath === '/fixture/b').at(-1));
    assert.equal(sourceBRead.projectGeneration, 1, 'automatic reads wait for the selected project generation');
    await send({ command: 'sourceSnapshotResolved', projectPath: '/fixture/b', requestId: sourceBRead.requestId, projectGeneration: 1,
      sourceEpoch: 0, error: 'action_failed' });
    assert.match(await page.locator('[data-source-current-branch]').textContent(), /暂时无法读取/,
      'a failed automatic read settles the collapsed loading badge');
    await send({ command: 'projectsLoaded', projects: { projects, portfolio: projects, selectedProjectPath: '/fixture/b', projectGeneration: 1 } });
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'source.read' && message.projectPath === '/fixture/b').length), 1,
      'a failed automatic read does not loop on background updates');
    await page.locator('[data-toggle-source-panel="/fixture/b"]').click();
    await page.locator('[data-refresh-source]').click();
    const retryBRead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read' && message.projectPath === '/fixture/b').at(-1));
    assert.notEqual(retryBRead.requestId, sourceBRead.requestId, 'manual refresh retries a failed automatic read');
    await send({ command: 'sourceSnapshotResolved', projectPath: '/fixture/b', requestId: retryBRead.requestId, projectGeneration: 1,
      sourceEpoch: 0, snapshot: { available: true, currentBranch: '', detachedHead: 'abc1234', branches: [] } });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'HEAD abc1234');
    await page.locator('[data-toggle-source-panel="/fixture/b"]').click();
    assert.equal(await page.locator('[data-source-current-branch]').isVisible(), true, 'detached HEAD remains visible when collapsed');
    await page.locator('[data-select-project-path="/fixture/a"]').click();
    const selectAMessage = await page.evaluate(() => window.messages.filter(message => message.command === 'project.select').at(-1));
    await send({ command: 'projectSelectionChanged', projectRoot: '/fixture/a', generation: 2, interactionId: selectAMessage.interactionId });
    await page.waitForFunction(() => window.messages.some(message => message.command === 'source.read' && message.projectGeneration === 2));
    const returnedARead = await page.evaluate(() => window.messages.filter(message => message.command === 'source.read' && message.projectGeneration === 2).at(-1));
    await send({
      command: 'sourceSnapshotResolved', projectPath: '/fixture/a', requestId: abaRead.requestId,
      projectGeneration: 0, sourceEpoch: 4,
      snapshot: { available: true, currentBranch: 'stale-aba', detachedHead: '', branches: [{ name: 'stale-aba', current: true }] }
    });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'main', 'A→B→A rejects the earlier A generation');
    await send({ command: 'sourceSnapshotResolved', projectPath: '/fixture/b', requestId: sourceBRead.requestId, projectGeneration: 1,
      sourceEpoch: 0, snapshot: { available: true, currentBranch: 'other-project', detachedHead: '', branches: [] } });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'main', 'a late automatic read cannot change another project');
    await send({ command: 'sourceSnapshotResolved', projectPath: '/fixture/a', requestId: returnedARead.requestId, projectGeneration: 2,
      sourceEpoch: 4, snapshot: { available: true, currentBranch: 'main', detachedHead: '',
        branches: [{ name: 'main', current: true }, { name: 'feature/source', current: false }] } });
    assert.equal(await page.locator('[data-refresh-source]').isDisabled(), false, 'the current generation read settles loading');

    await page.locator('[data-switch-source-branch="feature/source"]').click();
    const failedSwitch = await page.evaluate(() => window.messages.filter(message => message.command === 'source.switchBranch').at(-1));
    await send({
      command: 'sourceActionSettled', action: 'switch', success: false, error: 'result_unknown', projectPath: '/fixture/a',
      requestId: failedSwitch.requestId, projectGeneration: 2, sourceEpoch: 5,
      snapshot: {
        available: true, currentBranch: 'feature/source', detachedHead: '', statusLoaded: false,
        branches: [{ name: 'feature/source', current: true }, { name: 'main', current: false }]
      }
    });
    assert.equal(await page.locator('[data-source-current-branch]').textContent(), 'feature/source', 'a failed mutation still applies its authoritative readback');
    assert.match(await page.locator('[data-source-status]').textContent(), /源代码管理中检查工作区/);
    assert.doesNotMatch(await page.locator('[data-source-status]').textContent(), /文件保持不变/);
    await page.locator('[data-open-source-scm]').click();
    assert.deepEqual(
      await page.evaluate(() => window.messages.filter(message => message.command === 'source.openScm').map(message => ({ command: message.command, projectPath: message.projectPath }))),
      [{ command: 'source.openScm', projectPath: '/fixture/a' }]
    );
    const currentSourceToggle = page.locator('[data-toggle-source-panel="/fixture/a"]');
    await currentSourceToggle.click();
    assert.equal(await currentSourceToggle.getAttribute('aria-expanded'), 'false', 'Source collapses without changing the loaded snapshot');

    await page.evaluate(() => { window.messages = []; });
    await loadProjects([{ ...projects[1], description: 'background update' }], [projects[1].path]);
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'source.read').length), 0,
      'background project updates do not restart settled Source reads');
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
    await button.scrollIntoViewIfNeeded();
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
    const projectSelections = await page.evaluate(() => window.messages.filter(message => message.command === 'project.select'));
    assert.equal(projectSelections.length, 1, 'the shared card guard must preserve project selection actions too');
    assert.equal(projectSelections[0].projectPath, projects[1].path);
    assert.match(projectSelections[0].interactionId, /^sidebar-project-/,
      'project selection keeps the foreground interaction identity used for host acknowledgement');

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

    console.log(JSON.stringify({ collapsedBranchLoadsAutomatically: true, sourceMatchesAdjacentCards: true, stableUiStateLoads: true, pointerActionSurvivesRefresh: true, keyboardActionWorks: true, focusedInputSurvivesRefresh: true, securityActionEscapesRender: true }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
