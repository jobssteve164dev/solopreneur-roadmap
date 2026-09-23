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
  authenticated?: boolean;
  allowed: boolean;
  verificationUnavailable?: boolean;
  reason?: string;
  grant?: string;
  email?: string;
  userId?: string;
  entitlements?: string[];
  deviceLimit?: number;
  expiresAt?: string;
}

const unavailableVerificationReasons = new Set([
  'verify_failed',
  'passport_access_unavailable',
  'missing_product_secret',
  'missing_passport_verify_url',
  'passport_verify_not_configured'
]);

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

export function normalizeProAccountStatus(value: unknown): ProAccountStatus {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ProAccountStatus>;
  const expiresAt = String(source.expiresAt || '');
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const authenticated = Boolean(source.authenticated) && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  return {
    authenticated,
    allowed: authenticated && Boolean(source.allowed),
    email: authenticated ? String(source.email || '') : '',
    expiresAt: authenticated ? expiresAt : ''
  };
}

export function hasProEntitlement(
  settings: { proEntitlements?: Record<string, boolean>; proAccount?: ProAccountStatus } | undefined,
  featureKey: string
): boolean {
  const entitlements = settings?.proEntitlements || {};
  const expiresAt = String(settings?.proAccount?.expiresAt || '').trim();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return false;
  }
  const normalizedFeature = featureKey === 'strategyPyramid' ? strategyPyramidFeature : featureKey;
  return Boolean(entitlements[normalizedFeature]);
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

export function buildProAccountStatus(result: PassportVerifyResult | PassportGrantCache | null | undefined): ProAccountStatus {
  const source = (result || {}) as Partial<PassportVerifyResult & PassportGrantCache>;
  const expiresAt = String(source.expiresAt || '');
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const hasExplicitAuthentication = typeof source.authenticated === 'boolean';
  const claimedAuthentication = hasExplicitAuthentication
    ? source.authenticated === true
    : Boolean(source.email || source.userId);
  const authenticated = claimedAuthentication && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  const allowed = authenticated && Boolean((source as PassportVerifyResult).allowed);
  return {
    authenticated,
    allowed,
    email: authenticated ? String(source.email || '') : '',
    expiresAt: authenticated ? expiresAt : ''
  };
}

export function isPassportVerificationUnavailable(result: PassportVerifyResult | null | undefined): boolean {
  if (result?.verificationUnavailable === true) return true;
  const reason = String(result?.reason || '').trim().toLowerCase();
  if (unavailableVerificationReasons.has(reason)) return true;
  if (/(?:unavailable|timeout|temporar|upstream|rate[_-]?limit|overload|gateway|network|internal[_-]?error)/.test(reason)) {
    return true;
  }
  const httpMatch = reason.match(/^(?:verify|passport(?:_access)?)_http_(\d{3})$/);
  if (!httpMatch) return false;
  return !new Set([400, 401, 403, 410, 422]).has(Number(httpMatch[1]));
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

export function buildPassportAccountUrl(authNonce: string, callbackUri: string): string {
  const url = new URL('/api/account/start', getPassportBaseUrl());
  url.searchParams.set('source', 'vscode');
  url.searchParams.set('auth_nonce', authNonce);
  url.searchParams.set('callback', callbackUri);
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
    const authenticated = typeof body.authenticated === 'boolean'
      ? body.authenticated
      : Boolean(body.allowed || body.email || body.userId);
    return {
      authenticated,
      allowed: Boolean(body.allowed),
      verificationUnavailable: body.verificationUnavailable === true,
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
