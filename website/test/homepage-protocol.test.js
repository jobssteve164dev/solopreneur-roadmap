import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };

async function homepage(path) {
  const response = await worker.fetch(
    new Request(`https://solomap.app${path}`, { headers: { "user-agent": "Googlebot" } }),
    { SITE_ORIGIN: "https://solomap.app" },
    ctx
  );
  return { response, html: await response.text() };
}

test("bilingual homepages present the human-Agent working agreement as the primary product", async () => {
  const cases = [
    ["/", "Give every Agent a clear way to work with you.", "Human-AI Agent Working Agreement for VS Code | SoloMap"],
    ["/zh", "让每一个 Agent，都按你的目标工作。", "独道 SoloMap - 人与 AI Agent 的本地优先工作协议"]
  ];

  for (const [path, heading, title] of cases) {
    const { response, html } = await homepage(path);
    assert.equal(response.status, 200);
    assert.match(html, /<body class="protocol-home">/);
    assert.match(html, new RegExp(`<title>${title}</title>`));
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.match(html, /<table class="comparison-table">/);
    assert.match(html, /<thead>/);
    assert.match(html, /class="solomap-col" data-label=/);
    assert.match(html, /FAQPage/);
    assert.doesNotMatch(html, /Let AI Agents Code|AI 负责编写代码/);
  }
});

test("the comparison matrix has explicit desktop headers and mobile card labels", async () => {
  const { html } = await homepage("/");
  assert.match(html, /<th scope="col">Decision<\/th>/);
  assert.match(html, /<th scope="col" class="solomap-col">SoloMap working agreement<\/th>/);
  assert.match(html, /data-label="Agent chat alone"/);
  assert.match(html, /\.comparison-table td::before\s*\{[\s\S]*content: attr\(data-label\)/);
  assert.match(html, /\.comparison-table thead \{ display: none; \}/);
});

test("the protocol milestone component distinguishes achieved, current, next, and final vision", async () => {
  const cases = [
    ["/", "Where the working agreement stands today.", "A durable protocol for human-Agent work."],
    ["/zh", "这份工作协议，现在走到哪里。", "一套可持续的人与 Agent 工作协议。"]
  ];

  for (const [path, heading, vision] of cases) {
    const { html } = await homepage(path);
    assert.match(html, /<section class="section protocol-progress" id="progress">/);
    assert.match(html, new RegExp(`<h2>${heading}</h2>`));
    assert.match(html, /<ol class="milestone-list" aria-label=/);
    assert.equal((html.match(/class="milestone-item milestone-achieved"/g) || []).length, 2);
    assert.equal((html.match(/class="milestone-item milestone-current" aria-current="step"/g) || []).length, 1);
    assert.equal((html.match(/class="milestone-item milestone-next"/g) || []).length, 1);
    assert.match(html, new RegExp(`<h3>${vision}</h3>`));
    assert.match(html, /\.protocol-home \.section-head \{ grid-template-columns: 1fr; gap: 18px; \}/);
  }
});

test("generated homepage inline scripts are valid JavaScript and place mobile consent in document flow", async () => {
  const { html } = await homepage("/");
  const scripts = [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter(Boolean);

  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  assert.match(html, /const h=document\.querySelector\("\.topbar"\);h\?h\.after\(n\):document\.body\.prepend\(n\)/);
  assert.match(html, /\.consent-banner \{[\s\S]*position: relative;/);
});

test("the LLM index uses the same working-agreement positioning as the homepage", async () => {
  const response = await worker.fetch(
    new Request("https://solomap.app/llms.txt"),
    { SITE_ORIGIN: "https://solomap.app" },
    ctx
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /local-first human-Agent working agreement/);
  assert.match(text, /reviewable evidence rather than an Agent claim/);
  assert.doesNotMatch(text, /local-first roadmap and strategy cockpit for AI-built projects/);
});
