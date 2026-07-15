const DEFAULT_PASSPORT_URL = "https://passport.szlk.ai";
const SESSION_COOKIE = "__Host-solomap_session";
const LOCAL_SESSION_COOKIE = "solomap_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function passportHeadlessRequest(env, path, body) {
  const secret = String(env.SOLOMAP_PASSPORT_PRODUCT_SECRET || "");
  if (!secret) throw authError(500, "auth_not_configured", "SoloMap 登录服务尚未配置完成");
  const baseUrl = String(env.SOLOMAP_PASSPORT_URL || DEFAULT_PASSPORT_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-szlk-product": "solomap",
      "x-szlk-secret": secret
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true || !payload.data) {
    throw authError(response.status || 502, payload?.code || payload?.error?.code || "passport_request_failed", payload?.message || payload?.error?.message || "登录服务暂时不可用");
  }
  return payload.data;
}

export async function createSessionCookie(request, env, user) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const payload = encode(JSON.stringify({
    purpose: "solomap_web_session",
    id: String(user.id || ""),
    email: String(user.email || ""),
    name: String(user.name || ""),
    expiresAt
  }));
  const signature = encode(await hmac(String(env.SOLOMAP_PASSPORT_PRODUCT_SECRET || ""), payload));
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${secure ? SESSION_COOKIE : LOCAL_SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ].filter(Boolean).join("; ");
}

export async function readSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  let value = "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE || name === LOCAL_SESSION_COOKIE) value = rest.join("=");
  }
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !env.SOLOMAP_PASSPORT_PRODUCT_SECRET) return null;
  const expected = encode(await hmac(String(env.SOLOMAP_PASSPORT_PRODUCT_SECRET), payload));
  if (!safeEqual(expected, signature)) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (session.purpose !== "solomap_web_session" || Date.parse(session.expiresAt || "") <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:";
  return `${secure ? SESSION_COOKIE : LOCAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=0; Expires=${new Date(0).toUTCString()}`;
}

export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw authError(403, "invalid_origin", "请求来源无效");
}

export function safeReturnTo(value, fallback = "/workbench") {
  const path = String(value || fallback);
  return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}

function authError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function encode(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
