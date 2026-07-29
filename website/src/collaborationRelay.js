const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_ROOM_LIFETIME_MS = 72 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES = 100;
const MAX_CONNECTIONS = 12;
const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_RATE_LIMIT_STRIKES = 3;
const MAX_CREATE_BODY_BYTES = 4 * 1024;
const DEVICE_CREDENTIAL_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
const DEVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{40,512}\.[A-Za-z0-9_-]{40,128}$/;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const COLLABORATION_QUOTAS = Object.freeze({
  anonymous: Object.freeze({ tier: "anonymous", maxActiveRooms: 1, maxDailyRooms: 3, maxLifetimeMs: 2 * 60 * 60 * 1000 }),
  account: Object.freeze({ tier: "account", maxActiveRooms: 5, maxDailyRooms: 20, maxLifetimeMs: 24 * 60 * 60 * 1000 }),
  pro: Object.freeze({ tier: "pro", maxActiveRooms: 20, maxDailyRooms: 100, maxLifetimeMs: MAX_ROOM_LIFETIME_MS })
});

const GLOBAL_ANONYMOUS_QUOTA = Object.freeze({
  tier: "anonymous-global",
  maxActiveRooms: 500,
  maxDailyRooms: 1500,
  maxLifetimeMs: COLLABORATION_QUOTAS.anonymous.maxLifetimeMs
});

const MAX_DAILY_DEVICE_REGISTRATIONS = 2000;

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function collaborationCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type"
  };
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashRelayToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function getDeviceCredentialSecret(env) {
  return String(env.COLLABORATION_DEVICE_SECRET || env.SOLOMAP_PASSPORT_PRODUCT_SECRET || "");
}

async function signDeviceCredential(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function issueDeviceCredential(env, now = Date.now()) {
  const secret = getDeviceCredentialSecret(env);
  if (!secret) throw new Error("collaboration_device_secret_missing");
  const deviceId = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({
    purpose: "solomap_collaboration_device",
    deviceId,
    issuedAt: now,
    expiresAt: now + DEVICE_CREDENTIAL_LIFETIME_MS
  })));
  return `${payload}.${await signDeviceCredential(secret, payload)}`;
}

async function verifyDeviceCredential(env, credential, now = Date.now()) {
  if (!DEVICE_CREDENTIAL_PATTERN.test(String(credential || ""))) return null;
  const secret = getDeviceCredentialSecret(env);
  if (!secret) return null;
  try {
    const [payload, signature] = String(credential).split(".");
    const expected = fromBase64Url(await signDeviceCredential(secret, payload));
    const actual = fromBase64Url(signature);
    if (!timingSafeEqual(expected, actual)) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (parsed.purpose !== "solomap_collaboration_device" || !/^[A-Za-z0-9_-]{32}$/.test(String(parsed.deviceId || ""))) return null;
    if (!Number.isFinite(Number(parsed.expiresAt)) || Number(parsed.expiresAt) <= now) return null;
    return { subjectId: `device:${parsed.deviceId}`, tier: "anonymous" };
  } catch {
    return null;
  }
}

async function parseBoundedJson(request, maxBytes = MAX_CREATE_BODY_BYTES) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("request_too_large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("request_too_large");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("invalid_json");
  }
}

async function consumeRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function") return { configured: false, success: false };
  const result = await binding.limit({ key });
  return { configured: true, success: Boolean(result?.success) };
}

function requestSourceKey(request, action) {
  const address = String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  return `${action}:${address || "unknown"}`;
}

async function quotaRequest(binding, subjectId, path, payload) {
  if (!binding) return jsonResponse({ ok: false, error: "quota_unavailable" }, 503);
  const stub = binding.get(binding.idFromName(subjectId));
  return stub.fetch(`https://collaboration-quota.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function rollbackReservation(env, creator, roomId, creatorCreated, globalReservationId = "", globalCreated = false) {
  const tasks = [];
  if (creatorCreated) tasks.push(quotaRequest(env.COLLABORATION_QUOTAS, creator.subjectId, "/rollback", { roomId }));
  if (creator.tier === "anonymous" && globalCreated && globalReservationId) {
    tasks.push(quotaRequest(env.COLLABORATION_GLOBAL_QUOTA, "anonymous-global", "/rollback", { roomId: globalReservationId }));
  }
  await Promise.allSettled(tasks);
}

function parseRoomId(pathname) {
  const match = pathname.match(/^\/api\/collaboration\/rooms\/([A-Za-z0-9_-]{20,64})\/socket$/);
  return match ? match[1] : "";
}

function isValidCipherEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type !== "message" || !MESSAGE_ID_PATTERN.test(String(value.id || ""))) return false;
  if (!MESSAGE_ID_PATTERN.test(String(value.authorId || ""))) return false;
  if (!/^[A-Za-z0-9_-]{16}$/.test(String(value.iv || ""))) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(String(value.ciphertext || ""))) return false;
  if (String(value.ciphertext || "").length > MAX_MESSAGE_BYTES) return false;
  return Number.isFinite(Number(value.createdAt));
}

export async function handleCollaborationDeviceRegistration(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: collaborationCorsHeaders() });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, collaborationCorsHeaders());
  }
  const rateLimit = await consumeRateLimit(env.COLLABORATION_DEVICE_REGISTRATION_LIMITER, requestSourceKey(request, "device"));
  if (!rateLimit.configured) return jsonResponse({ ok: false, error: "protection_unavailable" }, 503, collaborationCorsHeaders());
  if (!rateLimit.success) return jsonResponse({ ok: false, error: "device_registration_limited" }, 429, collaborationCorsHeaders());
  const globalResponse = await quotaRequest(env.COLLABORATION_GLOBAL_QUOTA, "anonymous-global", "/register-device", {
    now: Date.now(),
    maxDailyRegistrations: MAX_DAILY_DEVICE_REGISTRATIONS
  });
  const globalResult = await globalResponse.json();
  if (!globalResponse.ok || !globalResult.ok) return jsonResponse(globalResult, globalResponse.status, collaborationCorsHeaders());
  try {
    return jsonResponse({
      ok: true,
      deviceCredential: await issueDeviceCredential(env),
      tier: "anonymous",
      quota: COLLABORATION_QUOTAS.anonymous
    }, 200, collaborationCorsHeaders());
  } catch {
    return jsonResponse({ ok: false, error: "collaboration_unavailable" }, 503, collaborationCorsHeaders());
  }
}

export async function handleCollaborationRoomCreate(request, env, accountCreator = null) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: collaborationCorsHeaders() });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, collaborationCorsHeaders());
  }
  if (!env.COLLABORATION_ROOMS) {
    return jsonResponse({ ok: false, error: "collaboration_unavailable" }, 503, collaborationCorsHeaders());
  }

  const rateLimit = await consumeRateLimit(env.COLLABORATION_ROOM_CREATE_LIMITER, requestSourceKey(request, "room"));
  if (!rateLimit.configured) return jsonResponse({ ok: false, error: "protection_unavailable" }, 503, collaborationCorsHeaders());
  if (!rateLimit.success) return jsonResponse({ ok: false, error: "room_creation_limited" }, 429, collaborationCorsHeaders());

  let body;
  try {
    body = await parseBoundedJson(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_json";
    return jsonResponse({ ok: false, error: code }, code === "request_too_large" ? 413 : 400, collaborationCorsHeaders());
  }

  const roomId = String(body.roomId || "");
  const relayToken = String(body.relayToken || "");
  const now = Date.now();
  const requestedExpiry = Number(body.expiresAt || 0);
  if (!ROOM_ID_PATTERN.test(roomId) || !RELAY_TOKEN_PATTERN.test(relayToken)) {
    return jsonResponse({ ok: false, error: "invalid_room_credentials" }, 400, collaborationCorsHeaders());
  }
  if (!Number.isFinite(requestedExpiry) || requestedExpiry < now + 60 * 1000) {
    return jsonResponse({ ok: false, error: "invalid_expiry" }, 400, collaborationCorsHeaders());
  }

  let creator = accountCreator;
  if (!creator) {
    const authorization = String(request.headers.get("authorization") || "");
    const deviceCredential = authorization.replace(/^Device\s+/i, "");
    creator = await verifyDeviceCredential(env, deviceCredential);
  }
  const quota = creator ? COLLABORATION_QUOTAS[creator.tier] : null;
  if (!creator || !quota) {
    return jsonResponse({ ok: false, error: "device_registration_required" }, 401, collaborationCorsHeaders());
  }
  const expiresAt = Math.min(requestedExpiry, now + quota.maxLifetimeMs);

  const reservationResponse = await quotaRequest(env.COLLABORATION_QUOTAS, creator.subjectId, "/reserve", {
    roomId,
    expiresAt,
    now,
    quota
  });
  const reservation = await reservationResponse.json();
  if (!reservationResponse.ok || !reservation.ok) {
    return jsonResponse(reservation, reservationResponse.status, collaborationCorsHeaders());
  }

  const creatorReservationCreated = !reservation.existing;
  let globalReservationId = "";
  let globalReservationCreated = false;
  if (creator.tier === "anonymous") {
    globalReservationId = await hashRelayToken(`${creator.subjectId}:${roomId}`);
    const globalResponse = await quotaRequest(env.COLLABORATION_GLOBAL_QUOTA, "anonymous-global", "/reserve", {
      roomId: globalReservationId,
      expiresAt,
      now,
      quota: GLOBAL_ANONYMOUS_QUOTA
    });
    const globalReservation = await globalResponse.json();
    if (!globalResponse.ok || !globalReservation.ok) {
      await rollbackReservation(env, creator, roomId, creatorReservationCreated);
      return jsonResponse(globalReservation, globalResponse.status, collaborationCorsHeaders());
    }
    globalReservationCreated = !globalReservation.existing;
  }

  const roomStub = env.COLLABORATION_ROOMS.get(env.COLLABORATION_ROOMS.idFromName(roomId));
  try {
    const response = await roomStub.fetch("https://collaboration.internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relayToken, expiresAt })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      await rollbackReservation(env, creator, roomId, creatorReservationCreated, globalReservationId, globalReservationCreated);
      return jsonResponse(result, response.status, collaborationCorsHeaders());
    }
    return jsonResponse({
      ...result,
      tier: creator.tier,
      quota: {
        tier: quota.tier,
        maxActiveRooms: quota.maxActiveRooms,
        maxDailyRooms: quota.maxDailyRooms,
        maxLifetimeMs: quota.maxLifetimeMs,
        activeRooms: Number(reservation.activeRooms || 0),
        remainingDailyRooms: Number(reservation.remainingDailyRooms || 0)
      }
    }, response.status, collaborationCorsHeaders());
  } catch {
    await rollbackReservation(env, creator, roomId, creatorReservationCreated, globalReservationId, globalReservationCreated);
    return jsonResponse({ ok: false, error: "room_initialization_failed" }, 502, collaborationCorsHeaders());
  }
}

export async function handleCollaborationSocket(request, env) {
  const roomId = parseRoomId(new URL(request.url).pathname);
  if (!roomId || !env.COLLABORATION_ROOMS) {
    return jsonResponse({ ok: false, error: "room_not_found" }, 404);
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ ok: false, error: "websocket_required" }, 426);
  }
  const roomStub = env.COLLABORATION_ROOMS.get(env.COLLABORATION_ROOMS.idFromName(roomId));
  return roomStub.fetch(request);
}

export class CollaborationQuota {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    if (path === "/reserve") return this.reserve(body);
    if (path === "/rollback") return this.rollback(body);
    if (path === "/register-device") return this.registerDevice(body);
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  async reserve(body) {
    const roomId = String(body.roomId || "");
    const now = Number(body.now || Date.now());
    const requestedExpiry = Number(body.expiresAt || 0);
    const quota = body.quota || {};
    const maxActiveRooms = Math.max(1, Math.floor(Number(quota.maxActiveRooms || 0)));
    const maxDailyRooms = Math.max(1, Math.floor(Number(quota.maxDailyRooms || 0)));
    const maxLifetimeMs = Math.max(60 * 1000, Number(quota.maxLifetimeMs || 0));
    if (!ROOM_ID_PATTERN.test(roomId) || !Number.isFinite(requestedExpiry) || requestedExpiry <= now || requestedExpiry > now + maxLifetimeMs) {
      return jsonResponse({ ok: false, error: "invalid_reservation" }, 400);
    }

    const storedRooms = await this.state.storage.get("rooms") || [];
    const rooms = storedRooms.filter((room) => Number(room.expiresAt || 0) > now);
    const existing = rooms.find((room) => room.roomId === roomId);
    const storedCreations = await this.state.storage.get("creations") || [];
    const creations = storedCreations.filter((entry) => Number(entry.createdAt || 0) > now - QUOTA_WINDOW_MS);
    if (existing) {
      return jsonResponse({
        ok: true,
        expiresAt: existing.expiresAt,
        activeRooms: rooms.length,
        remainingDailyRooms: Math.max(0, maxDailyRooms - creations.length),
        existing: true
      });
    }
    if (rooms.length >= maxActiveRooms) return jsonResponse({ ok: false, error: "active_room_limit" }, 429);
    if (creations.length >= maxDailyRooms) return jsonResponse({ ok: false, error: "daily_room_limit" }, 429);

    rooms.push({ roomId, expiresAt: requestedExpiry });
    creations.push({ roomId, createdAt: now });
    await this.state.storage.put({ rooms, creations });
    if (typeof this.state.storage.setAlarm === "function") {
      await this.state.storage.setAlarm(Math.min(...rooms.map((room) => room.expiresAt)));
    }
    return jsonResponse({
      ok: true,
      expiresAt: requestedExpiry,
      activeRooms: rooms.length,
      remainingDailyRooms: Math.max(0, maxDailyRooms - creations.length)
    });
  }

  async rollback(body) {
    const roomId = String(body.roomId || "");
    if (!ROOM_ID_PATTERN.test(roomId)) return jsonResponse({ ok: false, error: "invalid_reservation" }, 400);
    const rooms = (await this.state.storage.get("rooms") || []).filter((room) => room.roomId !== roomId);
    const creations = (await this.state.storage.get("creations") || []).filter((entry) => entry.roomId !== roomId);
    await this.state.storage.put({ rooms, creations });
    return jsonResponse({ ok: true });
  }

  async registerDevice(body) {
    const now = Number(body.now || Date.now());
    const maxDailyRegistrations = Math.max(1, Math.floor(Number(body.maxDailyRegistrations || 0)));
    if (!Number.isFinite(now) || !Number.isFinite(maxDailyRegistrations)) {
      return jsonResponse({ ok: false, error: "invalid_registration" }, 400);
    }
    const registrations = (await this.state.storage.get("deviceRegistrations") || [])
      .filter((createdAt) => Number(createdAt) > now - QUOTA_WINDOW_MS);
    if (registrations.length >= maxDailyRegistrations) {
      return jsonResponse({ ok: false, error: "anonymous_capacity_reached" }, 429);
    }
    registrations.push(now);
    await this.state.storage.put("deviceRegistrations", registrations);
    return jsonResponse({ ok: true, remaining: Math.max(0, maxDailyRegistrations - registrations.length) });
  }

  async alarm() {
    const now = Date.now();
    const rooms = (await this.state.storage.get("rooms") || []).filter((room) => Number(room.expiresAt || 0) > now);
    const creations = (await this.state.storage.get("creations") || []).filter((entry) => Number(entry.createdAt || 0) > now - QUOTA_WINDOW_MS);
    const registrations = (await this.state.storage.get("deviceRegistrations") || []).filter((createdAt) => Number(createdAt) > now - QUOTA_WINDOW_MS);
    await this.state.storage.put({ rooms, creations, deviceRegistrations: registrations });
    if (rooms.length && typeof this.state.storage.setAlarm === "function") {
      await this.state.storage.setAlarm(Math.min(...rooms.map((room) => room.expiresAt)));
    }
  }
}

export class CollaborationRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/initialize" && request.method === "POST") {
      return this.initialize(request);
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.connect(request);
    }
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  async initialize(request) {
    const body = await request.json();
    const relayToken = String(body.relayToken || "");
    const expiresAt = Number(body.expiresAt || 0);
    const now = Date.now();
    if (!RELAY_TOKEN_PATTERN.test(relayToken) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_ROOM_LIFETIME_MS) {
      return jsonResponse({ ok: false, error: "invalid_room" }, 400);
    }
    const existing = await this.state.storage.get("room");
    if (existing && existing.expiresAt > now) {
      if (await hashRelayToken(relayToken) !== existing.tokenHash) {
        return jsonResponse({ ok: false, error: "room_already_exists" }, 409);
      }
      return jsonResponse({ ok: true, expiresAt: existing.expiresAt, existing: true });
    }
    if (existing) await this.expireRoom();
    const room = {
      tokenHash: await hashRelayToken(relayToken),
      createdAt: now,
      expiresAt
    };
    await this.state.storage.put({ room, messages: [], nextSequence: 1 });
    await this.state.storage.setAlarm(expiresAt);
    return jsonResponse({ ok: true, expiresAt });
  }

  async connect(request) {
    const room = await this.state.storage.get("room");
    if (!room) return jsonResponse({ ok: false, error: "room_not_found" }, 404);
    if (room.expiresAt <= Date.now()) {
      await this.expireRoom();
      return jsonResponse({ ok: false, error: "room_expired" }, 410);
    }
    const token = String(new URL(request.url).searchParams.get("token") || "");
    if (!RELAY_TOKEN_PATTERN.test(token) || await hashRelayToken(token) !== room.tokenHash) {
      return jsonResponse({ ok: false, error: "invalid_room_token" }, 403);
    }
    if (this.state.getWebSockets().length >= MAX_CONNECTIONS) {
      return jsonResponse({ ok: false, error: "room_connection_limit" }, 429);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    if (typeof server.serializeAttachment === "function") {
      server.serializeAttachment({ messageTimes: [], rateLimitStrikes: 0 });
    }
    const messages = await this.state.storage.get("messages") || [];
    server.send(JSON.stringify({ type: "history", messages, expiresAt: room.expiresAt }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    const room = await this.state.storage.get("room");
    if (!room || room.expiresAt <= Date.now()) {
      socket.close(4001, "Room expired");
      await this.expireRoom();
      return;
    }
    const now = Date.now();
    const attachment = typeof socket.deserializeAttachment === "function" ? socket.deserializeAttachment() || {} : {};
    const messageTimes = Array.isArray(attachment.messageTimes)
      ? attachment.messageTimes.map(Number).filter((createdAt) => Number.isFinite(createdAt) && createdAt > now - MESSAGE_RATE_WINDOW_MS)
      : [];
    if (messageTimes.length >= MAX_MESSAGES_PER_WINDOW) {
      const rateLimitStrikes = Number(attachment.rateLimitStrikes || 0) + 1;
      if (typeof socket.serializeAttachment === "function") socket.serializeAttachment({ messageTimes, rateLimitStrikes });
      socket.send(JSON.stringify({ type: "error", error: "message_rate_limited" }));
      if (rateLimitStrikes >= MAX_RATE_LIMIT_STRIKES) socket.close(4008, "Message rate exceeded");
      return;
    }
    messageTimes.push(now);
    if (typeof socket.serializeAttachment === "function") socket.serializeAttachment({ messageTimes, rateLimitStrikes: 0 });
    const serialized = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
    if (new TextEncoder().encode(serialized).byteLength > MAX_MESSAGE_BYTES) {
      socket.send(JSON.stringify({ type: "error", error: "message_too_large" }));
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(serialized);
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }));
      return;
    }
    if (!isValidCipherEnvelope(envelope)) {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }));
      return;
    }

    const messages = await this.state.storage.get("messages") || [];
    if (messages.some((message) => message.id === envelope.id)) return;
    const sequence = Number(await this.state.storage.get("nextSequence") || 1);
    const receivedAt = now;
    const authoredAt = Number(envelope.createdAt);
    const stored = {
      type: "message",
      id: envelope.id,
      authorId: envelope.authorId,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      createdAt: Math.max(receivedAt - MAX_ROOM_LIFETIME_MS, Math.min(authoredAt, receivedAt + 5 * 60 * 1000)),
      receivedAt,
      sequence
    };
    const nextMessages = [...messages, stored].slice(-MAX_MESSAGES);
    await this.state.storage.put({ messages: nextMessages, nextSequence: sequence + 1 });
    this.broadcast(stored);
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }

  async alarm() {
    await this.expireRoom();
  }

  broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        // Closed sockets are removed by the runtime.
      }
    }
  }

  broadcastPresence() {
    queueMicrotask(() => this.broadcast({ type: "presence", count: this.state.getWebSockets().length }));
  }

  async expireRoom() {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(4001, "Room expired");
      } catch {
        // The socket may already be closed.
      }
    }
    await this.state.storage.deleteAll();
  }
}

export const collaborationRelayInternals = {
  COLLABORATION_QUOTAS,
  GLOBAL_ANONYMOUS_QUOTA,
  MAX_CONNECTIONS,
  MAX_MESSAGES,
  MAX_ROOM_LIFETIME_MS,
  issueDeviceCredential,
  isValidCipherEnvelope,
  parseRoomId,
  verifyDeviceCredential
};
