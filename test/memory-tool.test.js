const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'resources', 'tools', 'solomap-memory.cjs');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runTool(workspace, globalRoot, query, extra = []) {
  const result = spawnSync(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--global', globalRoot,
    '--query', query,
    '--json',
    ...extra
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('memory retrieve returns scoped high-value sections with precise locations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(memoryRoot, 'profile.md'), '# Profile\n\n## Communication\n\n- 默认先给结论。\n');
  write(path.join(memoryRoot, 'operating-rules.md'), '# Rules\n\n## Webview startup\n\n- Webview 首屏不能等待外部网络。\n');
  write(path.join(memoryRoot, 'projects', 'demo-app.md'), '# Demo\n\n## Sidebar launch boundary\n\n侧边栏对话必须复用统一启动链路，不能抢跑历史查询。\n');
  write(path.join(memoryRoot, 'projects', 'other-app.md'), '# Other\n\n侧边栏对话使用另一套旧链路。\n');
  write(path.join(memoryRoot, 'patterns', 'webview.md'), '# Webview\n\n## First paint\n\n侧边栏对话启动后再加载历史查询，不能与统一启动链并发。\n');
  write(path.join(memoryRoot, 'domains', 'billing.md'), '# Billing\n\nStripe subscription recovery.\n');

  const output = runTool(workspace, globalRoot, '侧边栏对话启动链路和历史查询');
  assert.ok(output.payload.results.length >= 2);
  const projectResult = output.payload.results.find((result) => result.source === 'project');
  assert.ok(projectResult);
  assert.match(projectResult.file, /projects[\\/]demo-app\.md$/);
  assert.ok(projectResult.lineStart > 0);
  assert.match(projectResult.reason, /命中/);
  assert.doesNotMatch(JSON.stringify(output), /other-app\.md/);
  assert.doesNotMatch(JSON.stringify(output), /Stripe subscription/);
});

test('memory retrieve supports source filters and rejects generic queries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-filter-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(memoryRoot, 'projects', 'demo-app.md'), '# Demo\n\n## Auth decision\n\nOAuth 回调必须绑定 nonce。\n');
  write(path.join(memoryRoot, 'decisions', 'auth.md'), '# Auth\n\n## OAuth callback\n\nOAuth 回调必须验证 nonce 和 state。\n');

  const filtered = runTool(workspace, globalRoot, 'OAuth 回调 nonce', ['--sources', 'decisions']);
  assert.equal(filtered.payload.results.length, 1);
  assert.equal(filtered.payload.results[0].source, 'decisions');

  const generic = runTool(workspace, globalRoot, 'https://example.com SoloMap 项目记忆系统');
  assert.deepEqual(generic.payload.results, []);
  assert.match(generic.payload.message, /具体功能/);
});
