const SITE_ORIGIN = "https://solomap.app";
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap";
const OPEN_VSX_URL = "https://open-vsx.org/extension/SZLK/solopreneur-roadmap";
const GITHUB_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap";
const FEEDBACK_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new?template=seed-user-feedback.yml";
const DOCS_URL = "https://github.com/jobssteve164dev/solopreneur-roadmap#readme";
const SCREENSHOT_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/docs/assets/solomap_red_terminal.png";
const LOGO_URL = "https://raw.githubusercontent.com/jobssteve164dev/solopreneur-roadmap/main/resources/logo.png";

const securityHeaders = {
  "content-security-policy": [
    "default-src 'none'",
    "img-src 'self' https://raw.githubusercontent.com data:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "connect-src 'none'",
    "script-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; "),
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
}

function textResponse(body, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "content-type": contentType,
      "cache-control": "public, max-age=300"
    }
  });
}

function buildPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloMap - Local-first roadmap and strategy cockpit for AI-built projects</title>
  <meta name="description" content="SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents in VS Code.">
  <meta property="og:title" content="SoloMap">
  <meta property="og:description" content="Keep your AI-built projects moving with a local-first roadmap and strategy cockpit in VS Code.">
  <meta property="og:image" content="${SCREENSHOT_URL}">
  <meta property="og:url" content="${SITE_ORIGIN}">
  <meta name="twitter:card" content="summary_large_image">
  <style>
    :root {
      color-scheme: dark;
      --ink: #f6f0e8;
      --muted: #bfb5a7;
      --soft: #ded4c8;
      --bg: #11100e;
      --panel: #1a1714;
      --line: rgba(246, 240, 232, 0.16);
      --red: #ef3e46;
      --cyan: #49d6d0;
      --green: #a5d66d;
      --shadow: rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    a { color: inherit; text-decoration: none; }
    img { display: block; max-width: 100%; }
    .shell { width: min(1160px, calc(100% - 40px)); margin: 0 auto; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--line);
      background: rgba(17, 16, 14, 0.9);
      backdrop-filter: blur(18px);
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 68px;
      gap: 20px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .brand img { width: 34px; height: 34px; border-radius: 8px; }
    .links {
      display: flex;
      align-items: center;
      gap: 20px;
      color: var(--soft);
      font-size: 14px;
    }
    .links a:hover { color: var(--ink); }
    .install-link {
      color: #11100e;
      background: var(--ink);
      padding: 9px 13px;
      border-radius: 8px;
      font-weight: 720;
    }
    .hero {
      min-height: calc(100vh - 68px);
      display: grid;
      align-items: center;
      padding: 58px 0 36px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(420px, 1.08fr);
      gap: 46px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      gap: 8px;
      color: var(--cyan);
      border: 1px solid rgba(73, 214, 208, 0.36);
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      max-width: 720px;
      font-size: clamp(46px, 8vw, 86px);
      line-height: 0.94;
      letter-spacing: 0;
    }
    .hero-copy {
      margin: 22px 0 0;
      max-width: 650px;
      color: var(--soft);
      font-size: 19px;
    }
    .cn-line {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 17px;
    }
    .cta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 30px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      border-radius: 8px;
      padding: 0 18px;
      font-weight: 760;
      border: 1px solid var(--line);
    }
    .button.primary { background: var(--red); border-color: var(--red); color: white; }
    .button.secondary { color: #11100e !important; background: #f6f0e8; }
    .button.ghost { color: var(--soft); }
    .button:hover { transform: translateY(-1px); }
    .proof {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 24px;
      color: var(--muted);
      font-size: 13px;
    }
    .proof span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(255, 255, 255, 0.035);
    }
    .screenshot-wrap {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #080807;
      box-shadow: 0 28px 80px var(--shadow);
      overflow: hidden;
    }
    .screenshot-wrap img {
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: cover;
    }
    .section {
      padding: 78px 0;
      border-top: 1px solid var(--line);
    }
    .section-head {
      display: grid;
      grid-template-columns: minmax(0, 0.7fr) minmax(320px, 0.3fr);
      gap: 32px;
      align-items: end;
      margin-bottom: 30px;
    }
    h2 {
      margin: 0;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 1;
      letter-spacing: 0;
    }
    .section-head p,
    .section > .shell > p.lead {
      margin: 0;
      color: var(--soft);
      font-size: 17px;
    }
    .grid-3,
    .grid-4 {
      display: grid;
      gap: 14px;
    }
    .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 22px;
      min-height: 170px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .card p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
    }
    .step {
      position: relative;
      padding-top: 54px;
    }
    .step::before {
      content: attr(data-step);
      position: absolute;
      top: 18px;
      left: 22px;
      color: #11100e;
      background: var(--cyan);
      border-radius: 999px;
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      font-size: 13px;
      font-weight: 800;
    }
    .trust-band {
      display: grid;
      grid-template-columns: minmax(0, 0.48fr) minmax(0, 0.52fr);
      gap: 14px;
      align-items: stretch;
    }
    .trust-copy {
      border-radius: 8px;
      border: 1px solid rgba(165, 214, 109, 0.34);
      background: rgba(165, 214, 109, 0.07);
      padding: 28px;
    }
    .trust-copy p { color: var(--soft); font-size: 18px; margin: 12px 0 0; }
    .trust-list {
      display: grid;
      gap: 14px;
    }
    .trust-list div {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.035);
    }
    .pro {
      display: grid;
      grid-template-columns: minmax(0, 0.62fr) minmax(320px, 0.38fr);
      gap: 14px;
      align-items: stretch;
    }
    .price {
      border: 1px solid rgba(239, 62, 70, 0.42);
      border-radius: 8px;
      padding: 28px;
      background: rgba(239, 62, 70, 0.08);
    }
    .price strong {
      display: block;
      font-size: 44px;
      line-height: 1;
      margin: 10px 0 14px;
      letter-spacing: 0;
    }
    .feature-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .feature-list span {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: var(--soft);
      background: rgba(255, 255, 255, 0.035);
    }
    .install-panel {
      display: grid;
      grid-template-columns: minmax(0, 0.54fr) minmax(0, 0.46fr);
      gap: 16px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      background: #171411;
    }
    .install-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    footer {
      border-top: 1px solid var(--line);
      padding: 30px 0;
      color: var(--muted);
      font-size: 14px;
    }
    .footer-row {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      flex-wrap: wrap;
    }
    .footer-links {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
    }
    @media (max-width: 920px) {
      .links a:not(.install-link) { display: none; }
      .hero { min-height: auto; padding-top: 44px; }
      .hero-grid,
      .section-head,
      .trust-band,
      .pro,
      .install-panel {
        grid-template-columns: 1fr;
      }
      .grid-3,
      .grid-4,
      .feature-list {
        grid-template-columns: 1fr;
      }
      .screenshot-wrap img { aspect-ratio: 4 / 3; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 28px, 1160px); }
      .brand span { font-size: 15px; }
      .install-link { padding: 8px 10px; }
      h1 { font-size: 46px; }
      .hero-copy { font-size: 17px; }
      .button { width: 100%; }
      .install-actions { grid-template-columns: 1fr; }
      .section { padding: 58px 0; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <nav class="shell nav" aria-label="Primary">
      <a class="brand" href="/" aria-label="SoloMap home">
        <img src="${LOGO_URL}" width="34" height="34" alt="">
        <span>SoloMap</span>
      </a>
      <div class="links">
        <a href="#product">Product</a>
        <a href="#pro">Pro</a>
        <a href="${DOCS_URL}">Docs</a>
        <a href="${GITHUB_URL}">GitHub</a>
        <a class="install-link" href="${MARKETPLACE_URL}">Install</a>
      </div>
    </nav>
  </header>

  <main>
    <section class="hero">
      <div class="shell hero-grid">
        <div>
          <div class="eyebrow">Local-first VS Code extension</div>
          <h1>Keep your AI-built projects moving.</h1>
          <p class="hero-copy">SoloMap is a local-first roadmap and strategy cockpit for indie developers building with AI agents in VS Code.</p>
          <p class="cn-line">让 AI Agent 负责执行，让 SoloMap 负责不丢方向。</p>
          <div class="cta-row">
            <a class="button primary" href="${MARKETPLACE_URL}">Install from VS Code Marketplace</a>
            <a class="button secondary" href="${OPEN_VSX_URL}">Get it on Open VSX</a>
            <a class="button ghost" href="${GITHUB_URL}">View on GitHub</a>
          </div>
          <div class="proof" aria-label="Product highlights">
            <span>Works in your workspace</span>
            <span>Bring your own Agent CLI</span>
            <span>Free core workflow</span>
          </div>
        </div>
        <figure class="screenshot-wrap" aria-label="SoloMap running in VS Code">
          <img src="${SCREENSHOT_URL}" width="1024" height="1024" alt="SoloMap roadmap and Agent terminal running inside Visual Studio Code">
        </figure>
      </div>
    </section>

    <section class="section" id="product">
      <div class="shell">
        <div class="section-head">
          <h2>AI can write code. It does not keep your product on track.</h2>
          <p>SoloMap keeps plans, Agent runs, next actions, and project memory in the place where you already work.</p>
        </div>
        <div class="grid-3">
          <article class="card">
            <h3>Scattered context</h3>
            <p>Project plans, AI chats, terminal output, TODOs, and code changes stop living as disconnected fragments.</p>
          </article>
          <article class="card">
            <h3>Clear next step</h3>
            <p>Come back days later and see what needs attention without rereading every chat and file.</p>
          </article>
          <article class="card">
            <h3>Beyond only Build</h3>
            <p>Roadmaps can keep Sell, Learn, Improve, feedback, and delivery signals visible while code keeps moving.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head">
          <h2>From idea to shipped progress, without losing the thread.</h2>
          <p>Four actions are enough to start with one real project.</p>
        </div>
        <div class="grid-4">
          <article class="card step" data-step="1">
            <h3>Add your local project</h3>
            <p>Choose a workspace folder and let SoloMap create the project operating surface there.</p>
          </article>
          <article class="card step" data-step="2">
            <h3>Create a roadmap</h3>
            <p>Describe the outcome and get a set of executable steps you can revise as reality changes.</p>
          </article>
          <article class="card step" data-step="3">
            <h3>Run your AI agent</h3>
            <p>Start your local Agent CLI from the right roadmap step with the context already attached.</p>
          </article>
          <article class="card step" data-step="4">
            <h3>Come back and continue</h3>
            <p>See today's priorities, project status, and recent progress when you reopen VS Code.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell trust-band">
        <div class="trust-copy">
          <h2>Local-first by default.</h2>
          <p>SoloMap's core workflow does not require a hosted backend. Roadmaps, task records, and project memory stay in your workspace first.</p>
        </div>
        <div class="trust-list">
          <div>Your project roadmap and memory stay with your local project.</div>
          <div>You bring the AI Agent CLI you already use.</div>
          <div>GitHub signals are pulled when you connect or refresh them.</div>
        </div>
      </div>
    </section>

    <section class="section" id="pro">
      <div class="shell pro">
        <div>
          <div class="section-head" style="display:block;margin-bottom:22px">
            <h2>Free moves one project forward. Pro helps run your one-person company.</h2>
          </div>
          <div class="feature-list">
            <span>Strategy cockpit</span>
            <span>Multi-project scoring</span>
            <span>Portfolio health</span>
            <span>Ability compounding</span>
            <span>Market and delivery diagnosis</span>
            <span>Early access roadmap input</span>
          </div>
        </div>
        <aside class="price" aria-label="Pro Early Access">
          <span>Pro Early Access</span>
          <strong>$29/year</strong>
          <p>Get early access to the strategy cockpit and help shape the Pro roadmap. The Free core workflow stays available.</p>
          <div class="cta-row">
            <a class="button primary" href="${FEEDBACK_URL}">Join Pro Early Access</a>
          </div>
        </aside>
      </div>
    </section>

    <section class="section" id="install">
      <div class="shell install-panel">
        <div>
          <h2>Try SoloMap with one project first.</h2>
          <p class="lead">If it helps you keep momentum, tell us what the strategy cockpit should show next.</p>
        </div>
        <div class="install-actions">
          <a class="button primary" href="${MARKETPLACE_URL}">VS Code Marketplace</a>
          <a class="button secondary" href="${OPEN_VSX_URL}">Open VSX</a>
          <a class="button ghost" href="${GITHUB_URL}">GitHub repository</a>
          <a class="button ghost" href="${FEEDBACK_URL}">Send feedback</a>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell footer-row">
      <div>SoloMap · solomap.app · SZLK</div>
      <div class="footer-links">
        <a href="${GITHUB_URL}">GitHub</a>
        <a href="${MARKETPLACE_URL}">VS Code Marketplace</a>
        <a href="${OPEN_VSX_URL}">Open VSX</a>
        <a href="${FEEDBACK_URL}">Feedback</a>
        <a href="/privacy-local-first">Privacy / Local-first note</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

function buildLocalFirstPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloMap Local-first Note</title>
  <style>
    body { margin: 0; background: #11100e; color: #f6f0e8; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
    main { width: min(760px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0; }
    a { color: #49d6d0; }
    h1 { font-size: clamp(36px, 7vw, 64px); line-height: 1; margin: 0 0 22px; letter-spacing: 0; }
    p, li { color: #ded4c8; font-size: 18px; }
    ul { padding-left: 22px; }
  </style>
</head>
<body>
  <main>
    <a href="/">Back to SoloMap</a>
    <h1>Local-first note</h1>
    <p>SoloMap's core workflow keeps roadmap state, task records, and project memory in your local workspace by default. It does not require a hosted SoloMap backend to run the main project workflow.</p>
    <ul>
      <li>Your AI provider usage depends on the local Agent CLI you choose.</li>
      <li>GitHub data is used when you connect or refresh GitHub-backed signals.</li>
      <li>Feedback is sent only when you open or submit a feedback issue yourself.</li>
    </ul>
  </main>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.SITE_ORIGIN || SITE_ORIGIN;

    if (url.pathname === "/health") {
      return textResponse("ok");
    }

    if (url.pathname === "/robots.txt") {
      return textResponse(`User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml
`);
    }

    if (url.pathname === "/sitemap.xml") {
      return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/privacy-local-first</loc></url>
</urlset>
`, "application/xml; charset=utf-8");
    }

    if (url.pathname === "/privacy-local-first") {
      return htmlResponse(buildLocalFirstPage());
    }

    if (url.pathname !== "/") {
      return htmlResponse(buildPage(), 404);
    }

    return htmlResponse(buildPage());
  }
};
