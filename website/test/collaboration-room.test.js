import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import worker from "../src/worker.js";
import { CollaborationRoom, collaborationRelayInternals } from "../src/collaborationRelay.js";

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
});

test("room creation validates credentials before allocating a Durable Object", async () => {
  let allocations = 0;
  const env = {
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
  const response = await worker.fetch(new Request("https://solomap.app/api/collaboration/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(forwarded.id, "id:" + body.roomId);
  assert.equal(forwarded.url, "https://collaboration.internal/initialize");
  assert.deepEqual(forwarded.body, { relayToken: body.relayToken, expiresAt });
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
