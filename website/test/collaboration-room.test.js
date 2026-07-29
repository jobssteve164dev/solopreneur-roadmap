import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import worker from "../src/worker.js";
import { createSessionCookie } from "../src/headlessAuth.js";
import {
  CollaborationLobby,
  CollaborationQuota,
  CollaborationRoom,
  collaborationRelayInternals,
  handleCollaborationLobbySession,
  handleCollaborationRoomCreate
} from "../src/collaborationRelay.js";

function createDurableState(getWebSockets = () => []) {
  const values = new Map();
  return {
    values,
    state: {
      storage: {
        async get(key) { return values.get(key); },
        async put(key, value) {
          if (typeof key === "object") {
            for (const [itemKey, itemValue] of Object.entries(key)) values.set(itemKey, itemValue);
          } else {
            values.set(key, value);
          }
        },
        async setAlarm(value) { values.set("alarm", value); },
        async deleteAll() { values.clear(); }
      },
      acceptWebSocket() {},
      getWebSockets
    }
  };
}

function createDurableNamespace(ClassType) {
  const instances = new Map();
  let allocations = 0;
  return {
    get allocations() { return allocations; },
    read(name, key) { return instances.get(String(name))?.storage.values.get(key); },
    idFromName(name) { allocations += 1; return String(name); },
    get(id) {
      if (!instances.has(id)) {
        const storage = createDurableState();
        instances.set(id, { object: new ClassType(storage.state), storage });
      }
      const instance = instances.get(id).object;
      return { fetch(url, init) { return instance.fetch(new Request(url, init)); } };
    }
  };
}

function createProtectedEnv() {
  return {
    SITE_ORIGIN: "https://solomap.app",
    SOLOMAP_PASSPORT_PRODUCT_SECRET: "test-collaboration-secret",
    COLLABORATION_DEVICE_REGISTRATION_LIMITER: { async limit() { return { success: true }; } },
    COLLABORATION_ROOM_CREATE_LIMITER: { async limit() { return { success: true }; } },
    COLLABORATION_LOBBY_JOIN_LIMITER: { async limit() { return { success: true }; } },
    COLLABORATION_LOBBY: createDurableNamespace(CollaborationLobby),
    COLLABORATION_ROOMS: createDurableNamespace(CollaborationRoom),
    COLLABORATION_QUOTAS: createDurableNamespace(CollaborationQuota),
    COLLABORATION_GLOBAL_QUOTA: createDurableNamespace(CollaborationQuota)
  };
}

test("the public lobby rejects signed-out users and issues only hourly tickets to accounts", async () => {
  const env = createProtectedEnv();
  const signedOut = await worker.fetch(new Request("https://solomap.app/api/collaboration/lobby/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Visitor" })
  }), env, { waitUntil() {} });
  assert.equal(signedOut.status, 401);
  assert.equal((await signedOut.json()).error, "login_required");

  const response = await handleCollaborationLobbySession(new Request("https://solomap.app/api/collaboration/lobby/session", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
    body: JSON.stringify({ nickname: "  Solo  Builder  " })
  }), env, { subjectId: "account:test-user", tier: "account" });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.sessionEndsAt - result.sessionStartedAt, 60 * 60 * 1000);
  assert.equal(result.sessionStartedAt % (60 * 60 * 1000), 0);
  const ticket = await collaborationRelayInternals.verifyLobbyTicket(env, result.ticket);
  assert.equal(ticket.nickname, "Solo Builder");
  assert.equal(ticket.memberId, result.memberId);
  assert.equal(await collaborationRelayInternals.verifyLobbyTicket(env, `${result.ticket.slice(0, -1)}x`), null);
});

test("lobby messages are bounded per account and the hourly alarm clears all retained data", async () => {
  const storage = createDurableState();
  const lobby = new CollaborationLobby(storage.state);
  const { sessionStartedAt, sessionEndsAt } = collaborationRelayInternals.currentLobbySession();
  await storage.state.storage.put({
    session: { sessionStartedAt, sessionEndsAt },
    messages: [],
    memberUsage: {},
    nextSequence: 1
  });
  const sent = [];
  const socket = {
    deserializeAttachment() { return { memberId: "m".repeat(32), nickname: "Builder" }; },
    send(value) { sent.push(JSON.parse(value)); },
    close() {}
  };
  for (let index = 0; index < 7; index += 1) {
    await lobby.webSocketMessage(socket, JSON.stringify({
      type: "message",
      id: `message${String(index).padStart(10, "0")}`,
      text: `Idea ${index}`
    }));
  }
  assert.equal((await storage.state.storage.get("messages")).length, 6);
  assert.equal(sent.at(-1).error, "message_rate_limited");
  await lobby.alarm();
  assert.equal(storage.values.size, 0);
});

async function registerDevice(env) {
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/devices", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.10" }
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  return (await response.json()).deviceCredential;
}

test("room pages are private, encrypted browser clients with a local recent-room index", async () => {
  const response = await worker.fetch(
    new Request("https://solomap.app/zh/room/room1234567890ABCDEFGH?token=relayToken1234567890ABCDEFGHijklmnop#abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"),
    { SITE_ORIGIN: "https://solomap.app" },
    { waitUntil() {} }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self' ws: wss:/);
  const html = await response.text();
  assert.match(html, /临时共创房间/);
  assert.match(html, /noindex,nofollow,noarchive/);
  assert.match(html, /indexedDB\.open\("solomap-collaboration"/);
  assert.match(html, /crypto\.subtle\.decrypt/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /最近共创/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));

  const joinPage = await worker.fetch(
    new Request("https://solomap.app/zh/room"),
    { SITE_ORIGIN: "https://solomap.app" },
    { waitUntil() {} }
  );
  assert.equal(joinPage.status, 200);
  const joinHtml = await joinPage.text();
  assert.match(joinHtml, /粘贴 SoloMap 邀请码/);
  assert.match(joinHtml, /parseInviteCode/);
  assert.doesNotThrow(() => new vm.Script([...joinHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]));
});

test("the signed-in workbench exposes a co-create tab backed by the encrypted room client", async () => {
  const env = {
    SITE_ORIGIN: "https://solomap.app",
    SOLOMAP_PASSPORT_PRODUCT_SECRET: "test-collaboration-secret"
  };
  const signedOut = await worker.fetch(
    new Request("https://solomap.app/zh/workbench/collaboration"),
    env,
    { waitUntil() {} }
  );
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get("location"), "https://solomap.app/zh/login?return_to=%2Fzh%2Fworkbench%2Fcollaboration");

  const sessionCookie = await createSessionCookie(
    new Request("https://solomap.app/zh/workbench"),
    env,
    { id: "user-1", email: "builder@example.com", name: "独立开发者" }
  );
  const cookie = sessionCookie.split(";")[0];
  const workbench = await worker.fetch(
    new Request("https://solomap.app/zh/workbench", { headers: { cookie } }),
    env,
    { waitUntil() {} }
  );
  assert.equal(workbench.status, 200);
  const workbenchHtml = await workbench.text();
  assert.match(workbenchHtml, /href="\/zh\/workbench\/collaboration">共创空间<\/a>/);

  const response = await worker.fetch(
    new Request("https://solomap.app/zh/workbench/collaboration", { headers: { cookie } }),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self' ws: wss:/);
  const html = await response.text();
  const headerPattern = /<header class="topbar">[\s\S]*?<\/header>/;
  const normalizeLanguageLink = (value) => String(value || "").replace(/href="\/workbench(?:\/collaboration)?\?lang=en"/, 'href="/workbench?lang=en"');
  assert.equal(normalizeLanguageLink(html.match(headerPattern)?.[0]), normalizeLanguageLink(workbenchHtml.match(headerPattern)?.[0]));
  assert.match(html, /<div class="desk shell"><aside class="desk-side">/);
  assert.match(html, /<h1>共创空间<\/h1>/);
  assert.match(html, /class="active" aria-current="page"[^>]*>共创空间<\/a>/);
  assert.match(html, /<div class="room-switcher"><label for="recent-list">最近共创<\/label><select/);
  assert.doesNotMatch(html, /<aside class="recent"/);
  assert.doesNotMatch(html, /workspace-nav|workspace-account|SoloMap · 个人工作台/);
  assert.match(html, /const accountNickname = "独立开发者"/);
  assert.match(html, /粘贴 SoloMap 邀请码/);
  assert.match(html, /indexedDB\.open\("solomap-collaboration"/);
  assert.match(html, /crypto\.subtle\.decrypt/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
});

test("room creation validates credentials before allocating a Durable Object", async () => {
  let allocations = 0;
  const env = {
    COLLABORATION_ROOM_CREATE_LIMITER: { async limit() { return { success: true }; } },
    COLLABORATION_ROOMS: {
      idFromName() { allocations += 1; return "id"; },
      get() { throw new Error("must not allocate"); }
    }
  };
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "short", relayToken: "bad", expiresAt: Date.now() + 3600000 })
  }), env, { waitUntil() {} });
  assert.equal(response.status, 400);
  assert.equal(allocations, 0);
});

test("room creation forwards only room credentials and expiry to the room object", async () => {
  let forwarded;
  const env = {
    COLLABORATION_ROOM_CREATE_LIMITER: { async limit() { return { success: true }; } },
    COLLABORATION_QUOTAS: createDurableNamespace(CollaborationQuota),
    COLLABORATION_GLOBAL_QUOTA: createDurableNamespace(CollaborationQuota),
    COLLABORATION_ROOMS: {
      idFromName(roomId) { return "id:" + roomId; },
      get(id) {
        return {
          async fetch(url, init) {
            forwarded = { id, url, body: JSON.parse(init.body) };
            return new Response(JSON.stringify({ ok: true, expiresAt: forwarded.body.expiresAt }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        };
      }
    }
  };
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const body = {
    roomId: "room1234567890ABCDEFGH",
    relayToken: "relayToken1234567890ABCDEFGHijklmnop",
    expiresAt
  };
  const response = await handleCollaborationRoomCreate(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, { subjectId: "account:test-user", tier: "account" });
  assert.equal(response.status, 200);
  assert.equal(forwarded.id, "id:" + body.roomId);
  assert.equal(forwarded.url, "https://collaboration.internal/initialize");
  assert.deepEqual(forwarded.body, { relayToken: body.relayToken, expiresAt });
});

test("anonymous devices receive signed credentials and a two-hour room quota", async () => {
  const env = createProtectedEnv();
  const credential = await registerDevice(env);
  assert.match(credential, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const now = Date.now();
  const roomId = "room1234567890ABCDEFGH";
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: {
      "authorization": `Device ${credential}`,
      "cf-connecting-ip": "203.0.113.10",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      roomId,
      relayToken: "relayToken1234567890ABCDEFGHijklmnop",
      expiresAt: now + 24 * 60 * 60 * 1000
    })
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tier, "anonymous");
  assert.equal(result.quota.maxActiveRooms, 1);
  assert.equal(result.quota.maxDailyRooms, 3);
  assert.equal(result.quota.maxLifetimeMs, 2 * 60 * 60 * 1000);
  assert.ok(result.expiresAt <= now + 2 * 60 * 60 * 1000 + 1000);

  const second = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: {
      "authorization": `Device ${credential}`,
      "cf-connecting-ip": "203.0.113.10",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      roomId: "room2234567890ABCDEFGH",
      relayToken: "relayToken2234567890ABCDEFGHijklmnop",
      expiresAt: now + 60 * 60 * 1000
    })
  }), env, { waitUntil() {} });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "active_room_limit");
});

test("forged anonymous device credentials are rejected before quota or room allocation", async () => {
  const env = createProtectedEnv();
  const credential = await registerDevice(env);
  const forged = credential.slice(0, -1) + (credential.endsWith("A") ? "B" : "A");
  const before = env.COLLABORATION_QUOTAS.allocations + env.COLLABORATION_ROOMS.allocations;
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: {
      "authorization": `Device ${forged}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      roomId: "room1234567890ABCDEFGH",
      relayToken: "relayToken1234567890ABCDEFGHijklmnop",
      expiresAt: Date.now() + 60 * 60 * 1000
    })
  }), env, { waitUntil() {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "device_registration_required");
  assert.equal(env.COLLABORATION_QUOTAS.allocations + env.COLLABORATION_ROOMS.allocations, before);
});

test("account and Pro creators receive materially different room lifetimes", async () => {
  const now = Date.now();
  const requestedExpiry = now + 72 * 60 * 60 * 1000;
  const accountEnv = createProtectedEnv();
  const accountResponse = await handleCollaborationRoomCreate(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "room1234567890ABCDEFGH",
      relayToken: "relayToken1234567890ABCDEFGHijklmnop",
      expiresAt: requestedExpiry
    })
  }), accountEnv, { subjectId: "account:one", tier: "account" });
  assert.equal(accountResponse.status, 200);
  const account = await accountResponse.json();
  assert.equal(account.quota.maxActiveRooms, 5);
  assert.equal(account.quota.maxDailyRooms, 20);
  assert.ok(account.expiresAt <= now + 24 * 60 * 60 * 1000 + 1000);

  const proEnv = createProtectedEnv();
  const proResponse = await handleCollaborationRoomCreate(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "room2234567890ABCDEFGH",
      relayToken: "relayToken2234567890ABCDEFGHijklmnop",
      expiresAt: requestedExpiry
    })
  }), proEnv, { subjectId: "pro:one", tier: "pro" });
  assert.equal(proResponse.status, 200);
  const pro = await proResponse.json();
  assert.equal(pro.quota.maxActiveRooms, 20);
  assert.equal(pro.quota.maxDailyRooms, 100);
  assert.ok(pro.expiresAt > now + 71 * 60 * 60 * 1000);
});

test("a failed duplicate-room attack cannot remove another device's global capacity reservation", async () => {
  const env = createProtectedEnv();
  const firstDevice = await registerDevice(env);
  const secondDevice = await registerDevice(env);
  const roomId = "room1234567890ABCDEFGH";
  const create = (credential, relayToken) => worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: {
      "authorization": `Device ${credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ roomId, relayToken, expiresAt: Date.now() + 60 * 60 * 1000 })
  }), env, { waitUntil() {} });
  const first = await create(firstDevice, "relayToken1234567890ABCDEFGHijklmnop");
  assert.equal(first.status, 200);
  assert.equal(env.COLLABORATION_GLOBAL_QUOTA.read("anonymous-global", "rooms").length, 1);

  const duplicate = await create(secondDevice, "otherToken1234567890ABCDEFGHijklmnop");
  assert.equal(duplicate.status, 409);
  assert.equal(env.COLLABORATION_GLOBAL_QUOTA.read("anonymous-global", "rooms").length, 1);
});

test("device registration and room creation fail closed when rate protection is unavailable or exceeded", async () => {
  const env = createProtectedEnv();
  delete env.COLLABORATION_DEVICE_REGISTRATION_LIMITER;
  const unavailable = await worker.fetch(new Request("https://solomap.app/api/collaboration/devices", { method: "POST" }), env, { waitUntil() {} });
  assert.equal(unavailable.status, 503);

  env.COLLABORATION_DEVICE_REGISTRATION_LIMITER = { async limit() { return { success: false }; } };
  const limited = await worker.fetch(new Request("https://solomap.app/api/collaboration/devices", { method: "POST" }), env, { waitUntil() {} });
  assert.equal(limited.status, 429);
});

test("quota objects enforce both active and rolling daily room limits", async () => {
  const storage = createDurableState();
  const quota = new CollaborationQuota(storage.state);
  const now = Date.now();
  const limits = { maxActiveRooms: 5, maxDailyRooms: 2, maxLifetimeMs: 60 * 60 * 1000 };
  for (const roomId of ["room1234567890ABCDEFGH", "room2234567890ABCDEFGH"]) {
    const response = await quota.reserve({ roomId, expiresAt: now + 30 * 60 * 1000, now, quota: limits });
    assert.equal(response.status, 200);
  }
  const rejected = await quota.reserve({ roomId: "room3234567890ABCDEFGH", expiresAt: now + 30 * 60 * 1000, now, quota: limits });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error, "daily_room_limit");
});

test("room creation rejects oversized request bodies before quota or room allocation", async () => {
  const env = createProtectedEnv();
  const credential = await registerDevice(env);
  const before = env.COLLABORATION_QUOTAS.allocations + env.COLLABORATION_ROOMS.allocations;
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "authorization": `Device ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(5000) })
  }), env, { waitUntil() {} });
  assert.equal(response.status, 413);
  assert.equal(env.COLLABORATION_QUOTAS.allocations + env.COLLABORATION_ROOMS.allocations, before);
});

test("relay accepts only bounded ciphertext envelopes", () => {
  const valid = {
    type: "message",
    id: "message1234567890AB",
    authorId: "author1234567890ABCD",
    iv: "1234567890ABCDEF",
    ciphertext: "ciphertext_123",
    createdAt: Date.now()
  };
  assert.equal(collaborationRelayInternals.isValidCipherEnvelope(valid), true);
  assert.equal(collaborationRelayInternals.isValidCipherEnvelope({ ...valid, ciphertext: "plain text" }), false);
  assert.equal(collaborationRelayInternals.isValidCipherEnvelope({ ...valid, id: "short" }), false);
});

test("an existing room cannot be reclaimed with another relay token", async () => {
  const values = new Map();
  const state = {
    storage: {
      async get(key) { return values.get(key); },
      async put(value) { for (const [key, item] of Object.entries(value)) values.set(key, item); },
      async setAlarm(value) { values.set("alarm", value); },
      async deleteAll() { values.clear(); }
    },
    getWebSockets() { return []; }
  };
  const room = new CollaborationRoom(state);
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const firstToken = "relayToken1234567890ABCDEFGHijklmnop";
  const otherToken = "otherToken1234567890ABCDEFGHijklmnop";
  const create = await room.initialize(new Request("https://collaboration.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayToken: firstToken, expiresAt })
  }));
  assert.equal(create.status, 200);
  const retry = await room.initialize(new Request("https://collaboration.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayToken: otherToken, expiresAt })
  }));
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), { ok: false, error: "room_already_exists" });
});

test("a room accepts at most twelve concurrent participants", async () => {
  const sockets = Array.from({ length: 12 }, () => ({}));
  const storage = createDurableState(() => sockets);
  const room = new CollaborationRoom(storage.state);
  const token = "relayToken1234567890ABCDEFGHijklmnop";
  await room.initialize(new Request("https://collaboration.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayToken: token, expiresAt: Date.now() + 60 * 60 * 1000 })
  }));
  const response = await room.connect(new Request(`https://solomap.app/api/collaboration/rooms/room1234567890ABCDEFGH/socket?token=${token}`, {
    headers: { upgrade: "websocket" }
  }));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "room_connection_limit");
});

test("a noisy WebSocket is rate-limited and closed after repeated bursts", async () => {
  const storage = createDurableState();
  const room = new CollaborationRoom(storage.state);
  const token = "relayToken1234567890ABCDEFGHijklmnop";
  await room.initialize(new Request("https://collaboration.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayToken: token, expiresAt: Date.now() + 60 * 60 * 1000 })
  }));
  let attachment = {};
  const sent = [];
  const closed = [];
  const socket = {
    deserializeAttachment() { return attachment; },
    serializeAttachment(value) { attachment = value; },
    send(value) { sent.push(JSON.parse(value)); },
    close(code, reason) { closed.push({ code, reason }); }
  };
  for (let index = 0; index < 23; index += 1) {
    await room.webSocketMessage(socket, JSON.stringify({
      type: "message",
      id: `message${String(index).padStart(12, "0")}`,
      authorId: "author1234567890ABCD",
      iv: "1234567890ABCDEF",
      ciphertext: "ciphertext_123",
      createdAt: Date.now()
    }));
  }
  assert.equal(sent.filter((message) => message.error === "message_rate_limited").length, 3);
  assert.deepEqual(closed, [{ code: 4008, reason: "Message rate exceeded" }]);
});
