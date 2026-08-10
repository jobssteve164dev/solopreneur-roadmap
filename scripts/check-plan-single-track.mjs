import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const files = [
  'src/proAccount.ts',
  'src/webviewSharedRuntime.ts',
  'src/extension.ts',
  'src/sidebarWebview.ts',
  'website/src/worker.js',
  'website/src/collaborationRelay.js'
];
const forbidden = [
  { pattern: /entitlements\.(?:pro|solomap_pro)/, reason: 'generic local Pro entitlement alias' },
  { pattern: /\[STRATEGY_PYRAMID_FEATURE,\s*["']solomap_pro["']\]/, reason: 'invented paid entitlement fallback' },
  { pattern: /metadata\?\.maxDevices/, reason: 'local catalog compatibility field' },
  { pattern: /const COLLABORATION_QUOTAS\s*=/, reason: 'local customer quota matrix' },
  { pattern: /collaborationQuota(?:Anonymous|Account|Pro)/, reason: 'local customer-visible quota copy' },
  { pattern: /maxDevices:\s*getProDeviceLimit/, reason: 'duplicated Checkout plan quota' }
];

const failures = [];
for (const relativePath of files) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) failures.push(`${relativePath}: ${rule.reason}`);
  }
}

if (failures.length) {
  console.error(`SoloMap plan single-track guard failed:\n${failures.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('SoloMap plan single-track guard passed.');
