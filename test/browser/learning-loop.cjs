// Exercises the generated Sidebar against an isolated real database, then its real feedback consumer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { chromium } = require('playwright');
const { UnifiedDataStore } = require('../../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../../out/runtimeDataOperations.js');
const { refreshProjectRegistry } = require('../../out/projectRegistry.js');
const { buildProjectPortfolioSummary } = require('../../out/projectPortfolio.js');
const { createGlobalEngineeringSnapshotPlaceholder } = require('../../out/globalEngineeringStore.js');
const runtime = require('../../out/autonomousRuntime.js');
const { readTodayReviewFromDatabase } = require('../../out/dailyReview.js');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
};
const { getSidebarWebviewHtml } = require('../../out/sidebarWebview.js');
Module._load = originalLoad;

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-browser-'));
  fs.mkdirSync(path.join(base, '.git'));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root), operation = createRuntimeDataOperations(store);
  const call = (name, input = {}) => operation({ operation: name, input });
  let browser;
  try {
    const projects = [{ name: '发布验证', path: project, priority: 'P1' }];
    await refreshProjectRegistry(root, () => ({ legacyProjects: projects, legacyHiddenProjects: [] }), call);
    const { projectId } = await call('register_project', { root: project });
    fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
    fs.writeFileSync(path.join(project, '.solopreneur/roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,验证安装包,,Build,,,,Pending,,\n2,发布版本,,Build,1,,,Pending,,\n');
    await call('accept_roadmap_csv', { root: project });
    store.write({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: 'browser-candidate', data: { status: 'candidate', summary: '发布后观察真实结果' } });
    store.write({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: 'browser-approved', data: { status: 'approved', summary: '先验证安装包', do_this: '安装并启动最终包', applies_when: '准备发布版本' } });
    const roadmap = await call('read_roadmap', { root: project });
    const portfolio = [buildProjectPortfolioSummary(projects[0], { coreOnly: true, roadmapNodesByProjectPath: new Map([[project, roadmap.nodes]]), learningOverview: await call('read_learning_overview') })];
    const globalStore = createGlobalEngineeringSnapshotPlaceholder(root, portfolio);
    await runtime.runCognitiveShadowDecisionCycle({ globalDataPath: root, projects, operation, engine: { id: 'browser-planner', async plan(input) {
      assert.equal(input.candidates[0].learning[0].doThis, '安装并启动最终包');
      return { candidateId: input.candidates[0].id, reason: '先验证安装包，再发布版本。' };
    } } });
    await runtime.persistShadowRuntimeState(root, operation);
    const review = await readTodayReviewFromDatabase(root, projects, operation);
    assert.equal(review.stale, undefined);
    const repo = path.resolve(__dirname, '../..'), uri = { fsPath: repo, toString: () => `file://${repo}` };
    const html = getSidebarWebviewHtml({ cspSource: 'self', asWebviewUri: value => value }, uri);
    let scripts = 0;
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) { new vm.Script(match[1], { filename: `generated-sidebar-${scripts}.js` }); scripts++; }
    }
    assert.ok(scripts > 0);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors = [], messages = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('solomapPostMessage', message => messages.push(message));
    await page.evaluate(() => {
      let state = {};
      window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; }, postMessage: value => window.solomapPostMessage(value) });
    });
    await page.setContent(html);
    await page.evaluate(data => window.postMessage({ command: 'projectsLoaded', projects: data }, '*'), { projects, selectedProjectPath: project, portfolio, globalStore });
    await page.evaluate(review => window.postMessage({ command: 'dailyReviewLoaded', review }, '*'), review);
    assert.match(await page.locator('.global-focus-foot').textContent(), /学习候选: 1/);
    assert.match(await page.locator('.global-focus-foot').textContent(), /阻断: 1/);
    if (process.env.SOLOMAP_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.SOLOMAP_BROWSER_SCREENSHOT, fullPage: true });
    const input = page.locator('[data-project-conversation-input]');
    await input.fill('验证发布结果');
    await input.evaluate(element => {
      window.__learningInput = element;
      element.dispatchEvent(new CompositionEvent('compositionstart', { data: '发布' }));
    });
    await page.evaluate(data => window.postMessage({ command: 'projectsLoaded', projects: data }, '*'), { projects, selectedProjectPath: project, portfolio: [{ ...portfolio[0], learningCandidateCount: 2 }], globalStore: { ...globalStore, learningCandidateCount: 2 }, updatedProjectPaths: [project] });
    assert.equal(await input.evaluate(element => element === window.__learningInput && element === document.activeElement), true);
    assert.equal(await input.inputValue(), '验证发布结果');
    await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { data: '发布' })));
    await input.blur();
    await page.waitForFunction(() => document.querySelector('.global-focus-foot')?.textContent.includes('学习候选: 2'));
    assert.equal(await input.inputValue(), '验证发布结果', 'flushing the deferred update after composition must also preserve the draft');
    await page.locator('[data-global-focus-project]').click();
    const feedback = messages.find(message => message.command === 'recordTodayShadowFeedback');
    assert.ok(feedback);
    await runtime.recordShadowDecisionFeedback(root, feedback, operation);
    assert.equal(store.rows("SELECT count(*) AS n FROM learning_events WHERE source_type='today_feedback'")[0].n, 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scripts, candidateCount: globalStore.learningCandidateCount, blockers: globalStore.dependencies.length, focusedDraftPreserved: true, feedback: feedback.outcome, pageErrors: errors.length }));
  } finally {
    await browser?.close();
    await operation.close(); store.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
