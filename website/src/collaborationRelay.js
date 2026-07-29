const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES = 100;

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
    "access-control-allow-headers": "content-type"
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

export async function handleCollaborationRoomCreate(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: collaborationCorsHeaders() });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, collaborationCorsHeaders());
  }
  if (!env.COLLABORATION_ROOMS) {
    return jsonResponse({ ok: false, error: "collaboration_unavailable" }, 503, collaborationCorsHeaders());
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400, collaborationCorsHeaders());
  }

  const roomId = String(body.roomId || "");
  const relayToken = String(body.relayToken || "");
  const now = Date.now();
  const requestedExpiry = Number(body.expiresAt || 0);
  const expiresAt = Math.min(requestedExpiry, now + MAX_ROOM_LIFETIME_MS);
  if (!ROOM_ID_PATTERN.test(roomId) || !RELAY_TOKEN_PATTERN.test(relayToken)) {
    return jsonResponse({ ok: false, error: "invalid_room_credentials" }, 400, collaborationCorsHeaders());
  }
  if (!Number.isFinite(expiresAt) || expiresAt < now + 60 * 1000) {
    return jsonResponse({ ok: false, error: "invalid_expiry" }, 400, collaborationCorsHeaders());
  }

  const roomStub = env.COLLABORATION_ROOMS.get(env.COLLABORATION_ROOMS.idFromName(roomId));
  const response = await roomStub.fetch("https://collaboration.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayToken, expiresAt })
  });
  const result = await response.json();
  return jsonResponse(result, response.status, collaborationCorsHeaders());
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
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
    const receivedAt = Date.now();
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
  MAX_MESSAGES,
  MAX_ROOM_LIFETIME_MS,
  isValidCipherEnvelope,
  parseRoomId
};
