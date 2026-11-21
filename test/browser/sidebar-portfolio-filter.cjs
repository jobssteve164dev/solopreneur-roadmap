const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { getSidebarWebviewHtml } = require('../../out/sidebarWebview.js');

const projects = Array.from({ length: 57 }, (_, index) => ({
  path: `/fixture/project-${index}`,
  name: `Project ${index}`,
  globalPriority: index < 7 ? 'P99' : 'P2',
  totalNodes: 1,
  failedNodes: index === 9 ? 1 : 0,
  overallStatus: index === 7 ? 'Completed' : index === 8 ? 'Running' : 'Pending'
}));
const selectedProjectPath = projects[7].path;
const settings = { language: 'zh', cliPath: 'agy', agentModelPreferences: {} };

test('sidebar view switches stay local during stale hydration and background refreshes', async t => {
  const html = getSidebarWebviewHtml({ asWebviewUri: () => '', cspSource: '' }, { fsPath: path.resolve(__dirname, '../..') });
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}) });
    });
    await page.setContent(html);
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const refresh = (dataPath, updatedProjectPaths, selection = selectedProjectPath) => send({ command: 'projectsLoaded', projects: {
      projects, selectedProjectPath: selection, portfolio: projects, globalStore: { dataPath, portfolio: [], dependencies: [] }, updatedProjectPaths
    } });
    const readId = scopeKey => page.evaluate(scope => window.messages.filter(message => message.command === 'uiState.load'
      && message.scopeKey === scope).at(-1)?.loadRequestId, scopeKey);
    const hydrate = (scopeKey, loadRequestId, state) => send({ command: 'uiStateLoaded', view: 'sidebar', scopeKey, loadRequestId, state });
    const filter = key => page.locator(`[data-portfolio-filter="${key}"]`);
    const selected = () => page.locator('[data-portfolio-filter].active').getAttribute('data-portfolio-filter');
    const cardPaths = () => page.locator('[data-select-project-path]').evaluateAll(cards => cards.map(card => card.getAttribute('data-select-project-path')));

    await send({ command: 'settingsLoaded', settings });
    await refresh('/fixture/data-a', undefined, '');
    const globalRead = await readId('global');
    await filter('completed').click();
    assert.deepEqual(await cardPaths(), [selectedProjectPath], 'click immediately shows local cards before any persistence response');
    await hydrate('global', globalRead, { portfolioFilter: 'all' });
    await refresh('/fixture/data-a');
    await hydrate(selectedProjectPath, await readId(selectedProjectPath), { 'interaction.activePortfolioFilter': 'frozen' });
    await refresh('/fixture/data-a', [selectedProjectPath]);
    await t.test('a project snapshot cannot restore a stale global view', async () => {
      assert.deepEqual(await cardPaths(), [selectedProjectPath]);
      assert.equal(await selected(), 'completed');
    });

    await t.test('a settings refresh between press and release preserves the pointer click', async () => {
      await filter('completed').click();
      const frozen = await filter('frozen').boundingBox();
      await page.mouse.move(frozen.x + frozen.width / 2, frozen.y + frozen.height / 2);
      await page.mouse.down();
      await send({ command: 'settingsLoaded', settings: { ...settings, language: 'en' } });
      await page.mouse.up();
      assert.equal(await selected(), 'frozen');
      assert.deepEqual(await cardPaths(), projects.slice(0, 7).map(project => project.path));
      await page.getByRole('button', { name: 'Frozen', exact: true, pressed: true }).waitFor();
    });

    await t.test('background callbacks preserve keyboard activation and focus', async () => {
      await filter('active').focus();
      await page.keyboard.down('Space');
      await refresh('/fixture/data-a', [projects[8].path]);
      await send({ command: 'settingsLoaded', settings });
      await page.keyboard.up('Space');
      assert.equal(await selected(), 'active');
      assert.deepEqual(await cardPaths(), projects.slice(8, 10).map(project => project.path));
      assert.equal(await filter('active').evaluate(button => document.activeElement === button), true);
    });

    await refresh('/fixture/data-a');
    await filter('failed').click();
    assert.deepEqual(await cardPaths(), [projects[9].path]);
    await filter('all').click();
    assert.deepEqual(await cardPaths(), projects.slice(7).map(project => project.path));
    await page.waitForFunction(() => window.messages.some(message => message.command === 'uiState.patch'
      && message.scopeKey === 'global' && message.key === 'portfolioFilter' && message.value === 'all'));
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.command === 'uiState.load').length), 2);
    assert.equal(await page.evaluate(() => window.messages.some(message => message.command === 'uiState.patch'
      && message.patches?.some(patch => patch.key === 'interaction.activePortfolioFilter'))), false, 'only the global preference is written');

    await refresh('/fixture/data-b');
    const newRead = await readId('global');
    assert.notEqual(newRead, globalRead);
    await hydrate('global', globalRead, { portfolioFilter: 'active' });
    await hydrate('global', newRead, { portfolioFilter: 'frozen' });
    await hydrate('global', newRead, { portfolioFilter: 'all' });
    await hydrate(selectedProjectPath, await readId(selectedProjectPath), { interactionState: { activePortfolioFilter: 'all' } });
    assert.equal(await selected(), 'frozen', 'a new data root restores its saved view once');
    assert.deepEqual(await cardPaths(), projects.slice(0, 7).map(project => project.path));

    await t.test('a new data root uses its own preference or the default', async () => {
      await refresh('/fixture/data-c');
      await hydrate('global', await readId('global'), {});
      assert.equal(await selected(), 'all');

      await filter('frozen').click();
      await refresh('/fixture/data-d');
      await hydrate('global', await readId('global'), { portfolioFilter: ['frozen'] });
      assert.equal(await selected(), 'all');

      await refresh('/fixture/data-e');
      await filter('all').click();
      await hydrate('global', await readId('global'), { portfolioFilter: 'frozen' });
      assert.equal(await selected(), 'all', 'an explicit click on the default wins over late hydration');
    });

    assert.deepEqual(errors, []);
    t.diagnostic('57 local cards, pointer and keyboard activation, snapshot and delta refresh, stale and new-root hydration');
  } finally {
    await browser.close();
  }
});
