const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { chromium } = require('playwright');
const { openAnalysisOwner } = require('../analysis-fixture.js');

test('final strategy page confirms local readiness and preserves editing before background delivery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-browser-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const globalRoot = path.join(root, '.solomap-global');
  await openAnalysisOwner(t, globalRoot, [{ name: 'Current product', path: project }]);
  const snapshot = await require('../../out/strategyPyramid.js').buildStrategyPyramidSnapshotData([{ name: 'Current product', path: project }], globalRoot, project, false);
  let renderer = require('../../out/strategyPyramidWebview.js');
  if (process.env.SOLOMAP_STRATEGY_BROWSER_BASELINE) {
    const { execFileSync } = require('node:child_process');
    const source = execFileSync('git', ['show', process.env.SOLOMAP_STRATEGY_BROWSER_BASELINE + ':src/strategyPyramidWebview.ts'], { encoding: 'utf8' });
    const compiled = require('typescript').transpileModule(source, { compilerOptions: { module: require('typescript').ModuleKind.CommonJS } }).outputText;
    const historical = new (require('node:module').Module)(__filename);
    historical._compile(compiled, __filename); renderer = historical.exports;
  }
  const context = { extensionUri: { fsPath: path.resolve(__dirname, '../..') } };
  const webview = { asWebviewUri: () => '', cspSource: '' };
  const local = renderer.getStrategyPyramidWebviewHtml(webview, context, { ...snapshot, engineStatus: 'updating' }, { traceId: 'browser-trace' });
  for (const script of local.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.setDefaultTimeout(3000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.messages = []; window.savedView = {};
      window.apiAcquisitions = 0;
      window.acquireVsCodeApi = () => {
        if (++window.apiAcquisitions !== 1) throw new Error('VS Code API acquired twice');
        return { postMessage: message => window.messages.push(message), getState: () => window.savedView, setState: value => { window.savedView = value; } };
      };
    });
    const started = performance.now(); await page.setContent(local);
    await page.waitForFunction(() => window.messages.some(m => m.command === 'strategy.rendered'), undefined, { timeout: 2000 });
    assert.equal(await page.locator('[data-tab="portfolio"]').count(), 1);
    assert.ok(performance.now() - started < 2000);
    await page.locator('[data-tab="portfolio"]').click();
    await page.locator('.p-card[data-p-index="0"]').click();
    await page.locator('#field-abilities').fill('正在编辑的能力');
    await page.locator('#field-abilities').evaluate(el => { window.originalInput = el; el.focus(); el.setSelectionRange(1, 4); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { command: 'strategy.updateAvailable', traceId: 'browser-trace' } })));
    assert.equal(await page.locator('#field-abilities').inputValue(), '正在编辑的能力');
    assert.equal(await page.locator('#field-abilities').evaluate(el => el === window.originalInput && document.activeElement === el && el.selectionStart === 1 && el.selectionEnd === 4), true);
    assert.equal(await page.evaluate(() => window.messages.some(m => m.command === 'strategy.applyUpdate')), false);
    await page.locator('#field-abilities').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await page.locator('#btn-close-drawer').click();
    await page.waitForFunction(() => window.messages.some(m => m.command === 'strategy.applyUpdate'), undefined, { timeout: 2000 });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { command: 'strategy.updateAvailable', traceId: 'browser-trace' } })));
    await page.waitForFunction(() => window.messages.filter(m => m.command === 'strategy.applyUpdate').length >= 2);
    assert.equal(await page.evaluate(() => window.savedView.tab), 'portfolio');
    const finalHtml = renderer.getStrategyPyramidWebviewHtml(webview, context, { ...snapshot, decisionSource: 'cognitive', engineStatus: 'completed', mainJudgment: '先验证现有产品的真实转化' }, { traceId: 'browser-next' });
    for (const script of finalHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    await page.locator('.p-card[data-p-index="0"]').click();
    await page.locator('#field-abilities').fill('源检查等待期间重新编辑');
    await page.locator('#field-abilities').evaluate(el => { window.resumedInput = el; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    const deliver = () => page.evaluate(html => window.dispatchEvent(new MessageEvent('message', { data: { command: 'strategy.update', traceId: 'browser-trace', html } })), finalHtml);
    await deliver();
    assert.equal(await page.locator('#field-abilities').evaluate(el => el === window.resumedInput && el.value === '源检查等待期间重新编辑'), true);
    assert.equal(await page.evaluate(() => window.messages.some(m => m.command === 'strategy.rendered' && m.phase === 'complete')), false);
    await page.locator('#field-abilities').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await page.locator('#btn-close-drawer').click();
    await page.waitForFunction(() => window.messages.filter(m => m.command === 'strategy.applyUpdate').length >= 3);
    await deliver();
    await page.waitForFunction(() => window.messages.some(m => m.command === 'strategy.rendered' && m.phase === 'complete'), undefined, { timeout: 2000 });
    assert.equal(await page.locator('.tab-btn.active').getAttribute('data-tab'), 'portfolio');
    assert.match(await page.locator('body').textContent(), /先验证现有产品的真实转化/);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { command: 'strategy.updateAvailable', traceId: 'browser-next' } })));
    await page.waitForFunction(() => window.messages.some(m => m.command === 'strategy.applyUpdate' && m.traceId === 'browser-next'));
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.command === 'strategy.applyUpdate' && m.traceId === 'browser-next').length), 1);
    assert.equal(await page.evaluate(() => window.apiAcquisitions), 1);
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ finalScriptParsed: true, browserInitialization: true, editingPreserved: true, pendingUpdateDelivered: true }));
  } finally { await browser.close(); }
});
