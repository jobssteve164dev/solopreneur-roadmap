// Run after npm run compile; use the existing Playwright installation via NODE_PATH.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const webview = { asWebviewUri: () => '', cspSource: '' };
const uri = { fsPath: root };
const project = { path: '/fixture/a', name: 'Project A', description: 'Saved description', notes: 'Saved notes', type: 'core_product', priority: 'P1' };
const settings = { cliPath: 'agy', language: 'zh', globalPrompt: 'Saved prompt', agentModelPreferences: {} };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    for (const surface of ['roadmap', 'sidebar']) {
      const html = surface === 'roadmap'
        ? require('../../out/roadmapWebview.js').getWebviewHtml(webview, { extensionUri: uri })
        : require('../../out/sidebarWebview.js').getSidebarWebviewHtml(webview, uri);
      for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.abort());
      await page.evaluate(() => {
        window.messages = [];
        window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
      });
      await page.setContent(html);
      await page.addStyleTag({ content: require('node:fs').readFileSync(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.css'), 'utf8') });
      const send = message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
      const projects = selected => send({ command: 'projectsLoaded', projects: { projects: [project, { ...project, path: '/fixture/b', name: 'Project B' }], selectedProjectPath: selected, portfolio: [] } });
      await send({ command: 'settingsLoaded', settings });
      await projects(project.path);
      await page.locator('#btn-toggle-settings').click();
      if (surface === 'roadmap') {
        await page.locator('#project-type-select [data-solo-trigger]').click();
        await page.locator('#project-type-select [data-solo-option-value="content"]').click();
        await projects(project.path);
        check(await page.locator('#project-type-select').getAttribute('data-value') === 'content', 'project category survives background refresh');
        await page.locator('#project-name-input').fill('Draft A');
        await page.locator('#project-name-input').evaluate(el => { el.focus(); el.setSelectionRange(2, 4); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await projects(project.path);
        check(await page.locator('#project-name-input').inputValue() === 'Draft A', 'project text survives refresh during composition');
        check(await page.locator('#project-name-input').evaluate(el => document.activeElement === el && el.selectionStart === 2 && el.selectionEnd === 4), 'project focus and selection survive refresh');
        await page.locator('#project-name-input').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        await projects('/fixture/b');
        check(await page.locator('#project-name-input').inputValue() === 'Project B', 'switch shows target project settings');
        await projects(project.path);
        check(await page.locator('#project-name-input').inputValue() === 'Draft A', 'return restores project draft');
      } else {
        await page.locator('#setting-language [data-solo-trigger]').click();
        await page.locator('#setting-language [data-solo-option-value="en"]').click();
        await send({ command: 'settingsLoaded', settings });
        check(await page.locator('#setting-language').getAttribute('data-value') === 'en', 'sidebar custom selection survives settings push');
        await page.locator('#setting-global-prompt').fill('Draft prompt');
      }
      const input = page.locator(surface === 'roadmap' ? '#project-name-input' : '#setting-global-prompt');
      const draft = surface === 'roadmap' ? 'Draft A' : 'Draft prompt';
      await page.locator('#btn-close-settings').click();
      await send({ command: 'settingsLoaded', settings });
      await projects(project.path);
      await page.locator('#btn-toggle-settings').click();
      check(await input.inputValue() === draft, surface + ' close/reopen retains unsaved draft');
      await page.locator('#btn-save-settings').focus();
      await page.locator('#btn-save-settings').press('Enter');
      const saved = await page.evaluate(() => window.messages.filter(m => m.command === 'settings.update' || m.command === 'project.updateMetadata'));
      const save = saved.find(m => m.command === (surface === 'roadmap' ? 'project.updateMetadata' : 'settings.update'));
      if (surface === 'roadmap') check(!saved.some(m => m.command === 'settings.update'), 'project save only writes project settings');
      await page.locator('#btn-toggle-settings').click();
      await input.fill('Newer draft');
      await send({ command: 'settingsLoaded', settings });
      await send({ command: surface === 'roadmap' ? 'projectMetadataSaved' : 'settingsSaved', requestId: save.requestId, projectPath: project.path, settings });
      await projects(project.path);
      await send({ command: 'settingsLoaded', settings });
      check(await input.inputValue() === 'Newer draft', surface + ' save acknowledgement preserves subsequent edits');
      if (surface === 'sidebar') {
        await page.locator('#btn-review-global-prompt').focus();
        await page.locator('#btn-review-global-prompt').press('Enter');
        await input.fill('Edited during review');
        await page.locator('#setting-global-data-path').fill('/draft/data');
        await send({ command: 'globalPromptReviewCompleted', success: true, globalPrompt: 'Reviewed prompt' });
        await send({ command: 'settingsLoaded', settings });
        check(await input.inputValue() === 'Edited during review', 'prompt review preserves newer prompt edits');
        check(await page.locator('#setting-global-data-path').inputValue() === '/draft/data', 'prompt review does not clear unrelated dirty settings');
      }
      if (surface === 'roadmap') {
        await page.locator('#btn-close-settings').click();
        await page.locator('#btn-toggle-solo').click();
        const composer = page.locator('[data-solo-input]');
        await composer.fill('Keep composing');
        await composer.evaluate(el => { window.originalComposer = el; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await send({ command: 'nodeConversationsLoaded', projectPath: project.path, nodeId: '__solo__', conversations: [] });
        check(await composer.evaluate(el => el === window.originalComposer && document.activeElement === el), 'roadmap history refresh preserves composing DOM');
        await composer.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        await page.locator('[data-send-solo]').click({ delay: 80 });
        check(await page.evaluate(() => window.messages.some(m => m.command === 'conversation.runSolo' && m.userMessage === 'Keep composing')), 'first send click survives deferred history refresh');
        await page.locator('[data-solo-input]').fill('Keep composing');
        await projects('/fixture/b');
        await page.locator('#btn-toggle-solo').click();
        check(await page.locator('[data-solo-input]').inputValue() === '', 'new project does not inherit another project conversation draft');
        await page.locator('[data-solo-input]').fill('B draft');
        await projects(project.path);
        check(await page.locator('#solo-panel').evaluate(el => el.classList.contains('active')), 'return restores the selected conversation tab');
        await page.locator('#btn-toggle-solo').click();
        check(await page.locator('[data-solo-input]').inputValue() === 'Keep composing', 'roadmap project switch restores conversation draft');
      }
      if (surface === 'roadmap') {
        await send({ command: 'flowStateLoaded', projectPath: project.path, state: { hasProAccess: true, flow: null, history: [] } });
        await page.locator('#btn-toggle-flow').click();
        await page.locator('[data-flow-goal-input]').fill('Flow goal');
        await page.locator('[data-send-flow]').click();
        check(await page.locator('[data-flow-goal-input]').inputValue() === '', 'Flow send clears its submitted draft');
        const oldFlow = { command: 'flowStateLoaded', projectPath: project.path, state: { hasProAccess: true, flow: { id: 'flow-a', goal: 'Only project A goal', status: 'running', loops: [] }, history: [] } };
        await send(oldFlow);
        await projects('/fixture/b');
        await page.locator('#btn-toggle-flow').click();
        check(!(await page.locator('#flow-body').innerText()).includes('Only project A goal'), 'project B never displays project A Flow');
        await send(oldFlow);
        check(!(await page.locator('#flow-body').innerText()).includes('Only project A goal'), 'late project A Flow cannot replace project B');

      }
      check(errors.length === 0, surface + ' runtime errors: ' + errors.join('; '));
      await page.close();
    }
    console.log(JSON.stringify({ failures }));
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
