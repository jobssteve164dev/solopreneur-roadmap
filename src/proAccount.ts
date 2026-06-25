import * as crypto from 'crypto';

export interface ProAccountStatus {
  authenticated: boolean;
  allowed: boolean;
  email?: string;
  expiresAt?: string;
}

export interface PassportGrantCache {
  grant: string;
  email: string;
  userId: string;
  entitlements: string[];
  deviceLimit?: number;
  expiresAt: string;
  checkedAt: string;
}

export interface PassportVerifyResult {
  allowed: boolean;
  reason?: string;
  grant?: string;
  email?: string;
  userId?: string;
  entitlements?: string[];
  deviceLimit?: number;
  expiresAt?: string;
}

export interface PassportDeviceStartResult {
  ok: boolean;
  reason?: string;
  deviceCode?: string;
  loginUrl?: string;
  expiresIn?: number;
}

export const passportProduct = 'solomap';
export const strategyPyramidFeature = 'strategy_pyramid';
export const flowModeFeature = 'flow_mode';
export const passportGrantOfflineGraceMs = 14 * 24 * 60 * 60 * 1000;

export function normalizeProAccountStatus(value: unknown): ProAccountStatus {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ProAccountStatus>;
  return {
    authenticated: Boolean(source.authenticated),
    allowed: Boolean(source.allowed),
    email: String(source.email || ''),
    expiresAt: String(source.expiresAt || '')
  };
}

export function readLocalProEntitlements(): Record<string, boolean> {
  const value = String(process.env.SOLOMAP_PRO || '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'pro'].includes(value)) {
    return {};
  }
  return {
    pro: true,
    strategy_pyramid: true,
    flow_mode: true
  };
}

export function hasProEntitlement(
  settings: { proEntitlements?: Record<string, boolean>; proAccount?: ProAccountStatus } | undefined,
  featureKey: string
): boolean {
  const entitlements = settings?.proEntitlements || {};
  const localEntitlements = readLocalProEntitlements();
  const hasLocalPro = Boolean(
    localEntitlements.pro
    || localEntitlements[featureKey]
    || localEntitlements[strategyPyramidFeature]
    || localEntitlements[flowModeFeature]
  );
  const expiresAt = String(settings?.proAccount?.expiresAt || '').trim();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!hasLocalPro && Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    return false;
  }
  const normalizedFeature = featureKey === 'strategyPyramid' ? strategyPyramidFeature : featureKey;
  return Boolean(entitlements[normalizedFeature] || entitlements[featureKey] || entitlements.pro || entitlements.solomap_pro);
}

export function clearProEntitlements(entitlements: Record<string, boolean> = {}): Record<string, boolean> {
  const nextEntitlements = { ...entitlements };
  delete nextEntitlements.pro;
  delete nextEntitlements.solomap_pro;
  delete nextEntitlements[strategyPyramidFeature];
  delete nextEntitlements.strategyPyramid;
  delete nextEntitlements[flowModeFeature];
  delete nextEntitlements.flowMode;
  return nextEntitlements;
}

export function grantContainsFeature(grant: Pick<PassportGrantCache, 'entitlements' | 'expiresAt' | 'checkedAt'>): boolean {
  const entitlements = new Set((grant.entitlements || []).map((item) => String(item || '').trim()));
  const expiresAtMs = Date.parse(grant.expiresAt || '');
  const checkedAtMs = Date.parse(grant.checkedAt || '');
  if (!entitlements.has(strategyPyramidFeature) && !entitlements.has('solomap_pro') && !entitlements.has('pro')) {
    return false;
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return false;
  }
  if (!Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > passportGrantOfflineGraceMs) {
    return false;
  }
  return true;
}

export function buildProAccountStatus(result: PassportVerifyResult | PassportGrantCache | null | undefined): ProAccountStatus {
  const source = (result || {}) as Partial<PassportVerifyResult & PassportGrantCache>;
  const allowed = Boolean((source as PassportVerifyResult).allowed) || grantContainsFeature({
    entitlements: Array.isArray(source.entitlements) ? source.entitlements : [],
    expiresAt: String(source.expiresAt || ''),
    checkedAt: (source as PassportGrantCache).checkedAt || new Date().toISOString()
  });
  return {
    authenticated: Boolean(source.email || source.userId || allowed),
    allowed,
    email: String(source.email || ''),
    expiresAt: String(source.expiresAt || '')
  };
}

export function getPassportBaseUrl(): string {
  return String(process.env.SOLOMAP_PASSPORT_BASE_URL || 'https://solomap.app').replace(/\/+$/, '');
}

export function createPassportAuthNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function buildPassportProUrl(mode: 'callback' | 'device', authNonce: string, callbackUri = ''): string {
  const url = new URL('/pro', getPassportBaseUrl());
  url.searchParams.set('product', passportProduct);
  url.searchParams.set('feature', strategyPyramidFeature);
  url.searchParams.set('source', 'vscode');
  url.searchParams.set('mode', mode);
  url.searchParams.set('auth_nonce', authNonce);
  if (mode === 'callback' && callbackUri) {
    url.searchParams.set('callback', callbackUri);
  }
  return url.toString();
}

export function buildPassportVerifyUrl(): string {
  return new URL('/api/passport/verify', getPassportBaseUrl()).toString();
}

export function buildPassportDeviceStartUrl(): string {
  return new URL('/api/passport/device/start', getPassportBaseUrl()).toString();
}

export function buildPassportDeviceVerifyUrl(): string {
  return new URL('/api/passport/device/verify', getPassportBaseUrl()).toString();
}

export async function verifyPassportGrant(
  grant: string,
  options: {
    authNonce?: string | null;
    callbackUri?: string | null;
    deviceCode?: string | null;
    fetcher?: typeof fetch;
  } = {}
): Promise<PassportVerifyResult> {
  if (!grant) {
    return { allowed: false, reason: 'missing_grant' };
  }
  try {
    const fetchImpl = options.fetcher || fetch;
    const response = await fetchImpl(buildPassportVerifyUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: passportProduct,
        feature: strategyPyramidFeature,
        grant,
        code: grant,
        authNonce: options.authNonce || '',
        callback: options.callbackUri || '',
        deviceCode: options.deviceCode || ''
      })
    });
    if (!response.ok) {
      return { allowed: false, reason: `verify_http_${response.status}` };
    }
    const body = await response.json() as PassportVerifyResult;
    return {
      allowed: Boolean(body.allowed),
      reason: String(body.reason || ''),
      grant: String(body.grant || ''),
      email: String(body.email || ''),
      userId: String(body.userId || ''),
      entitlements: Array.isArray(body.entitlements) ? body.entitlements.map((item) => String(item || '')).filter(Boolean) : [],
      expiresAt: String(body.expiresAt || '')
    };
  } catch (error) {
    console.warn('Failed to verify SoloMap Pro grant:', error);
    return { allowed: false, reason: 'verify_failed' };
  }
}
