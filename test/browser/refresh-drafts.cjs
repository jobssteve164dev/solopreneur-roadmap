// Run after npm run compile; use the existing Playwright installation via NODE_PATH.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const webview = { asWebviewUri: () => '', cspSource: '' };
const uri = { fsPath: root };
const project = { path: '/fixture/a', name: 'Project A', description: 'Saved description', notes: 'Saved notes', type: 'core_product', priority: 'P1', autonomyEnabled: true, toolNetworkDisabled: true };
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
      const uiStateLoadRequestId = scopeKey => page.evaluate(scope => window.messages
        .filter(message => message.command === 'uiState.load' && message.scopeKey === scope)
        .at(-1)?.loadRequestId || '', scopeKey);
      const loadUiState = async (scopeKey, state) => send({
        command: 'uiStateLoaded', view: surface, scopeKey,
        loadRequestId: await uiStateLoadRequestId(scopeKey), state
      });
      let projectDataRoot = '/fixture/data-a';
      const projects = selected => {
        const listed = [project, { ...project, path: '/fixture/b', name: 'Project B' }];
        return send({ command: 'projectsLoaded', projects: {
          projects: listed,
          selectedProjectPath: selected,
          portfolio: listed,
          globalStore: { dataPath: projectDataRoot, portfolio: [], dependencies: [], learningCandidateCount: 0 }
        } });
      };
      await send({ command: 'settingsLoaded', settings });
      await projects(project.path);
      await page.locator('#btn-toggle-settings').click();
      if (surface === 'roadmap') {
        check(await page.locator('#project-autonomy-enabled').isChecked(), 'project autonomy authorization is visible in project settings');
        check(await page.locator('#project-tool-network-disabled').isChecked(), 'project tool network policy is visible in project settings');
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
        await page.locator('#project-autonomy-enabled').uncheck();
        await page.locator('#project-tool-network-disabled').uncheck();
      } else {
        const projectComposer = page.locator('[data-project-conversation-input]');
        await projectComposer.fill('冷启动后继续输入');
        await projectComposer.evaluate(el => {
          window.originalSidebarProjectComposer = el;
          el.focus();
          el.setSelectionRange(3, 6);
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        });
        await loadUiState('global', { portfolioFilter: 'all' });
        await loadUiState(project.path, {});
        await projects(project.path);
        check(await projectComposer.evaluate(el => el === window.originalSidebarProjectComposer), 'sidebar late startup data preserves the active composer DOM');
        check(await projectComposer.inputValue() === '冷启动后继续输入', 'sidebar late startup data preserves composing text');
        check(await projectComposer.evaluate(el => document.activeElement === el && el.selectionStart === 3 && el.selectionEnd === 6), 'sidebar late startup data preserves focus and selection');
        await projectComposer.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        await page.waitForTimeout(20);

        const activeComposer = page.locator('[data-project-conversation-input][data-project-path="/fixture/a"]');
        await activeComposer.focus();
        const pasteFeedback = await activeComposer.evaluate(el => {
          const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
          el.dispatchEvent(event);
          const composer = document.querySelector('[data-project-continue-composer]');
          return {
            text: composer?.innerText || '',
            focused: document.activeElement === composer?.querySelector('[data-project-conversation-input]'),
            sendDisabled: composer?.querySelector('[data-project-continue-send]')?.disabled
          };
        });
        check(pasteFeedback.text.includes('截图已添加'), 'sidebar paste shows immediate local acceptance while the composer remains focused');
        check(!pasteFeedback.text.includes('正在添加截图'), 'sidebar paste never exposes an indefinite loading state');
        check(pasteFeedback.focused && !pasteFeedback.sendDisabled, 'sidebar paste preserves focus and keeps Send available');
        await page.waitForFunction(() => window.messages.some(message => message.command === 'attachment.save'));
        const sidebarAttachmentSave = await page.evaluate(() => window.messages.filter(message => message.command === 'attachment.save').at(-1));
        await send({ command: 'pastedAttachmentsAccepted', targetId: sidebarAttachmentSave.targetId, projectPath: sidebarAttachmentSave.projectPath, requestId: sidebarAttachmentSave.requestId, attachmentEpoch: sidebarAttachmentSave.attachmentEpoch });
        await send({ command: 'pastedAttachmentsSaved', targetId: sidebarAttachmentSave.targetId, projectPath: sidebarAttachmentSave.projectPath, requestId: sidebarAttachmentSave.requestId, attachmentEpoch: sidebarAttachmentSave.attachmentEpoch, files: ['solomap://asset/11111111-1111-4111-8111-111111111111'] });
        check((await page.locator('[data-project-continue-composer]').innerText()).includes('截图'), 'sidebar renders the saved internal attachment with a user-facing label');
        check(!(await page.locator('[data-project-continue-composer]').innerText()).includes('solomap://asset'), 'sidebar hides internal attachment identifiers');
        const globalLoadRequestId = await uiStateLoadRequestId('global');
        await page.evaluate((loadRequestId) => {
          window.dispatchEvent(new MessageEvent('message', { data: { command: 'uiStateLoaded', view: 'sidebar', scopeKey: 'global', loadRequestId, state: { portfolioFilter: 'all' } } }));
          document.querySelector('[data-project-conversation-input][data-project-path="/fixture/a"]').blur();
          document.querySelector('[data-select-project-path="/fixture/b"]').click();
        }, globalLoadRequestId);
        await page.waitForTimeout(20);
        check(await page.locator('.portfolio-card.is-selected').getAttribute('data-select-project-path') === '/fixture/b', 'sidebar user project switch wins over queued startup refresh');
        check(await page.locator('[data-project-conversation-input]').getAttribute('data-project-path') === '/fixture/b', 'sidebar queued startup refresh cannot restore the previous project composer');
        check(await page.evaluate(() => window.messages.some(message => message.command === 'project.select' && message.projectPath === '/fixture/b')), 'sidebar project switch reaches the extension');
        await projects('/fixture/b');

        const projectBLoadRequestId = await uiStateLoadRequestId('/fixture/b');
        await page.evaluate(() => { window.messages = []; });
        const projectBComposer = page.locator('[data-project-conversation-input][data-project-path="/fixture/b"]');
        await projectBComposer.evaluate(el => {
          el.value = '';
          el.focus();
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        });
        await send({ command: 'uiStateLoaded', view: 'sidebar', scopeKey: '/fixture/b', loadRequestId: projectBLoadRequestId, state: { soloDraft: '数据库里的草稿', conversationMode: 'solo' } });
        await projectBComposer.evaluate(el => el.blur());
        await projectBComposer.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        await page.waitForTimeout(20);
        const restoredProjectBComposer = page.locator('[data-project-conversation-input][data-project-path="/fixture/b"]');
        check(await restoredProjectBComposer.getAttribute('data-conversation-mode') === 'solo', 'sidebar applies the loaded conversation mode after composition ends');
        check(await restoredProjectBComposer.inputValue() === '数据库里的草稿', 'sidebar applies the loaded database draft after composition ends');
        check(!await page.evaluate(() => window.messages.some(message => message.command === 'uiState.patch' && message.scopeKey === '/fixture/b' && message.key === 'soloDraft' && message.value === '')), 'sidebar never overwrites a loaded database draft with stale DOM input');

        const localDraftDuringLateState = await restoredProjectBComposer.evaluate((el, loadRequestId) => {
          el.value = '用户刚输入';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          window.dispatchEvent(new MessageEvent('message', { data: { command: 'uiStateLoaded', view: 'sidebar', scopeKey: '/fixture/b', loadRequestId, state: { soloDraft: '数据库旧草稿', conversationMode: 'solo' } } }));
          const value = el.value;
          el.blur();
          return value;
        }, projectBLoadRequestId);
        check(localDraftDuringLateState === '用户刚输入', 'sidebar keeps newer local input while an older database state is queued');
        await page.waitForTimeout(150);
        check(await page.locator('[data-project-conversation-input][data-project-path="/fixture/b"]').inputValue() === '用户刚输入', 'sidebar keeps newer local input after the queued database state is rendered');

        await page.locator('[data-adjust-roadmap-project-path="/fixture/b"]').evaluate(button => button.click());
        await page.waitForTimeout(150);
        await projects('/fixture/b');
        const roadmapRevisionInput = page.locator('[data-roadmap-revision-input="/fixture/b"]');
        const roadmapDraftDuringLateState = await roadmapRevisionInput.evaluate((el, loadRequestId) => {
          el.value = '用户刚输入的路线修订';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          window.dispatchEvent(new MessageEvent('message', { data: {
            command: 'uiStateLoaded',
            view: 'sidebar',
            scopeKey: '/fixture/b',
            loadRequestId,
            state: {
              'interaction.expandedRoadmapRevisionProjectPath': '/fixture/b',
              'interaction.roadmapRevisionDrafts.%2Ffixture%2Fb': '数据库旧路线修订'
            }
          } }));
          const value = el.value;
          el.blur();
          return value;
        }, projectBLoadRequestId);
        check(roadmapDraftDuringLateState === '用户刚输入的路线修订', 'sidebar keeps newer roadmap revision input while an older database state is queued');
        await page.waitForTimeout(150);
        check(await page.locator('[data-roadmap-revision-input="/fixture/b"]').inputValue() === '用户刚输入的路线修订', 'sidebar keeps newer roadmap revision input after the queued database state is rendered');

        await page.locator('[data-select-project-path="/fixture/a"]').evaluate(element => element.click());
        await projects('/fixture/a');
        check(await page.locator('.portfolio-card.is-selected').getAttribute('data-select-project-path') === '/fixture/a', 'old data root selects project A before the root switch');
        const oldRootLoadRequestId = await uiStateLoadRequestId('/fixture/b');
        projectDataRoot = '/fixture/data-b';
        await projects('/fixture/b');
        check(await page.locator('.portfolio-card.is-selected').getAttribute('data-select-project-path') === '/fixture/b', 'new data root authoritative project B replaces the old-root active selection');
        const newRootLoadRequestId = await uiStateLoadRequestId('/fixture/b');
        check(newRootLoadRequestId && newRootLoadRequestId !== oldRootLoadRequestId, 'sidebar reloads project UI state when the data root changes under the same selected path');
        await send({ command: 'uiStateLoaded', view: 'sidebar', scopeKey: '/fixture/b', loadRequestId: oldRootLoadRequestId, state: { soloDraft: '旧数据根草稿', conversationMode: 'solo' } });
        await send({ command: 'uiStateLoaded', view: 'sidebar', scopeKey: '/fixture/b', loadRequestId: newRootLoadRequestId, state: { soloDraft: '新数据根草稿', conversationMode: 'solo' } });
        await page.waitForTimeout(20);
        check(await page.locator('[data-project-conversation-input][data-project-path="/fixture/b"]').inputValue() === '新数据根草稿', 'sidebar rejects old-root UI state and applies the new-root hydration');

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
      if (surface === 'roadmap') check(save.autonomyEnabled === false, 'project save carries the explicit autonomy choice');
      if (surface === 'roadmap') check(save.toolNetworkDisabled === false, 'project save carries the explicit tool network choice');
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
        const pasteFeedback = await composer.evaluate(el => {
          const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
          el.dispatchEvent(event);
          const panel = document.querySelector('#solo-body .conversation-composer');
          return {
            text: panel?.innerText || '',
            focused: document.activeElement === panel?.querySelector('[data-solo-input]'),
            sendDisabled: panel?.querySelector('[data-send-solo]')?.disabled
          };
        });
        check(pasteFeedback.text.includes('截图已添加'), 'roadmap paste shows immediate local acceptance while the composer remains focused');
        check(!pasteFeedback.text.includes('正在添加截图'), 'roadmap paste never exposes an indefinite loading state');
        check(pasteFeedback.focused && !pasteFeedback.sendDisabled, 'roadmap paste preserves focus and keeps Send available');
        await page.waitForFunction(() => window.messages.some(message => message.command === 'attachment.save' && message.nodeId === '__solo__'));
        const roadmapAttachmentSave = await page.evaluate(() => window.messages.filter(message => message.command === 'attachment.save' && message.nodeId === '__solo__').at(-1));
        await send({ command: 'pastedAttachmentsAccepted', nodeId: roadmapAttachmentSave.nodeId, projectPath: roadmapAttachmentSave.projectPath, requestId: roadmapAttachmentSave.requestId, attachmentEpoch: roadmapAttachmentSave.attachmentEpoch });
        await send({ command: 'supplementFilesSelected', nodeId: roadmapAttachmentSave.nodeId, projectPath: roadmapAttachmentSave.projectPath, requestId: roadmapAttachmentSave.requestId, attachmentEpoch: roadmapAttachmentSave.attachmentEpoch, files: ['solomap://asset/22222222-2222-4222-8222-222222222222'] });
        check((await page.locator('#solo-body').innerText()).includes('截图'), 'roadmap renders the saved internal attachment with a user-facing label');
        check(!(await page.locator('#solo-body').innerText()).includes('solomap://asset'), 'roadmap hides internal attachment identifiers');
        await page.locator('[data-send-solo]').click();
        check(await page.locator('[data-solo-input]').inputValue() === '', 'roadmap immediate send clears the submitted draft');
        await page.locator('[data-solo-input]').fill('Keep composing');
        await composer.evaluate(el => { window.originalComposer = el; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await send({ command: 'nodeConversationsLoaded', projectPath: project.path, nodeId: '__solo__', conversations: [] });
        check(await composer.evaluate(el => el === window.originalComposer && document.activeElement === el), 'roadmap history refresh preserves composing DOM');
        await composer.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        const attachmentSaveCount = await page.evaluate(() => window.messages.filter(message => message.command === 'attachment.save' && message.nodeId === '__solo__').length);
        await composer.evaluate(el => {
          const file = new File([new Uint8Array([4, 5, 6])], 'second.png', { type: 'image/png' });
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
          el.dispatchEvent(event);
        });
        await page.waitForFunction(count => window.messages.filter(message => message.command === 'attachment.save' && message.nodeId === '__solo__').length > count, attachmentSaveCount);
        const runCountBeforeQueuedSend = await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').length);
        await page.locator('[data-send-solo]').click({ delay: 80 });
        check(await page.evaluate(count => window.messages.filter(message => message.command === 'conversation.runSolo').length === count, runCountBeforeQueuedSend), 'roadmap send waits for the accepted image without losing the click');
        check((await page.locator('#solo-body').innerText()).includes('图片保存后自动发送'), 'roadmap clearly explains that the queued send will continue automatically');
        await page.locator('[data-solo-input]').fill('New draft after click');
        const queuedRoadmapAttachment = await page.evaluate(() => window.messages.filter(message => message.command === 'attachment.save' && message.nodeId === '__solo__').at(-1));
        await projects('/fixture/b');
        await send({ command: 'pastedAttachmentsAccepted', nodeId: queuedRoadmapAttachment.nodeId, projectPath: queuedRoadmapAttachment.projectPath, requestId: queuedRoadmapAttachment.requestId, attachmentEpoch: queuedRoadmapAttachment.attachmentEpoch });
        await send({ command: 'supplementFilesSelected', nodeId: queuedRoadmapAttachment.nodeId, projectPath: queuedRoadmapAttachment.projectPath, requestId: queuedRoadmapAttachment.requestId, attachmentEpoch: queuedRoadmapAttachment.attachmentEpoch, files: ['solomap://asset/33333333-3333-4333-8333-333333333333'] });
        await page.waitForFunction(count => window.messages.filter(message => message.command === 'conversation.runSolo').length === count + 1, runCountBeforeQueuedSend);
        const queuedRun = await page.evaluate(() => window.messages.filter(message => message.command === 'conversation.runSolo').at(-1));
        check(queuedRun.userMessage === 'Keep composing', 'roadmap automatic send keeps the original user message');
        check(queuedRun.projectPath === project.path, 'roadmap automatic send remains bound to the project where the user clicked Send');
        check(queuedRun.supplementFiles.length === 1, 'roadmap automatic send includes the saved screenshot exactly once');
        await projects(project.path);
        check(!(await page.locator('#solo-body').innerText()).includes('图片保存后自动发送'), 'roadmap clears the queued status after the automatic send');
        check(await page.locator('[data-solo-input]').inputValue() === 'New draft after click', 'roadmap automatic send preserves text entered after the user clicked Send');
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
