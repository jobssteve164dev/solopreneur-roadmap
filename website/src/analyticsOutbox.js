const CLOUDAPI_ANALYTICS_URL = "https://cloudapi.szlk.ai/v1/analytics/events";
const MAX_ATTEMPTS = 10;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function retryDelay(attempt) {
  return Math.min(3_600_000, 30_000 * (2 ** Math.min(attempt, 7)));
}

export class AnalyticsOutbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/events") return json({ error: "Not found" }, 404);
    const payload = await request.json();
    if (!payload?.event_id || !payload?.event_name || !payload?.anonymous_id) return json({ error: "Invalid event" }, 400);
    const key = `event:${payload.event_id}`;
    if (!await this.state.storage.get(key)) {
      await this.state.storage.put(key, { payload, attempts: 0, nextAttemptAt: Date.now() });
    }
    await this.drain([key]);
    return json({ accepted: true }, 202);
  }

  async alarm() {
    await this.drain();
  }

  async drain(onlyKeys = null) {
    const now = Date.now();
    const records = onlyKeys
      ? new Map((await Promise.all(onlyKeys.map(async (key) => [key, await this.state.storage.get(key)]))).filter(([, value]) => value))
      : await this.state.storage.list({ prefix: "event:" });
    let nextAlarm = null;
    for (const [key, record] of records) {
      if (record.nextAttemptAt > now) {
        nextAlarm = nextAlarm === null ? record.nextAttemptAt : Math.min(nextAlarm, record.nextAttemptAt);
        continue;
      }
      try {
        if (!this.env.CLOUDAPI_PROJECT_KEY) throw new Error("CLOUDAPI_PROJECT_KEY missing");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        let response;
        try {
          response = await fetch(CLOUDAPI_ANALYTICS_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.CLOUDAPI_PROJECT_KEY}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(record.payload),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (response.status !== 202) throw new Error(`Cloudapi analytics returned ${response.status}`);
        await this.state.storage.delete(key);
      } catch (error) {
        const attempts = Number(record.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.state.storage.put(key, { ...record, attempts, terminal: true, lastError: String(error).slice(0, 300) });
          continue;
        }
        const nextAttemptAt = Date.now() + retryDelay(attempts);
        await this.state.storage.put(key, { ...record, attempts, nextAttemptAt, lastError: String(error).slice(0, 300) });
        nextAlarm = nextAlarm === null ? nextAttemptAt : Math.min(nextAlarm, nextAttemptAt);
      }
    }
    if (nextAlarm !== null) await this.state.storage.setAlarm(nextAlarm);
  }
}

function hasAnalyticsConsent(request) {
  return /(?:^|;\s*)solomap_analytics_consent=yes(?:;|$)/.test(request.headers.get("cookie") || "");
}

function optionalString(value, maxLength) {
  return typeof value === "string" && value ? value.slice(0, maxLength) : undefined;
}

export async function handleAnalyticsEvent(request, env) {
  if (!hasAnalyticsConsent(request)) return json({ error: "Analytics consent required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const anonymousId = optionalString(body.anonymous_id, 200);
  const page = optionalString(body.page, 500);
  if (body.event_name !== "page_view" || !anonymousId || !page) return json({ error: "Invalid page view" }, 400);
  const eventId = typeof body.event_id === "string" && /^[0-9a-f-]{36}$/i.test(body.event_id)
    ? body.event_id
    : crypto.randomUUID();
  const payload = {
    event_id: eventId,
    event_name: "page_view",
    anonymous_id: `web:${anonymousId}`,
    occurred_at: new Date().toISOString(),
    source: "solomap.web",
    channel: "web",
    page,
    properties: {
      collection_scope: "analytics_consent",
      page_title: optionalString(body.page_title, 300),
      referrer: optionalString(body.referrer, 1000)
    }
  };
  const id = env.ANALYTICS_OUTBOX.idFromName("solomap-web");
  return env.ANALYTICS_OUTBOX.get(id).fetch("https://analytics-outbox/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function buildAnalyticsClientScript(locale) {
  const copy = locale === "zh"
    ? { text: "允许 SoloMap 使用匿名访问统计，帮助我们改进网站？", accept: "允许统计", reject: "仅必要功能" }
    : { text: "Allow anonymous usage analytics to help improve SoloMap?", accept: "Allow analytics", reject: "Necessary only" };
  return `<script>(()=>{const c="solomap_analytics_consent",read=()=>document.cookie.split("; ").find(v=>v.startsWith(c+"="))?.split("=")[1],set=v=>{document.cookie=c+"="+v+"; Path=/; Max-Age=15552000; SameSite=Lax; Secure"},track=()=>{if(read()!=="yes")return;let id=localStorage.getItem("solomap_visitor_id");if(!id){id=crypto.randomUUID();localStorage.setItem("solomap_visitor_id",id)}fetch("/api/analytics/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event_id:crypto.randomUUID(),event_name:"page_view",anonymous_id:id,page:location.pathname,page_title:document.title,referrer:document.referrer})}).catch(()=>{})};if(!read()){const n=document.createElement("div");n.className="consent-banner";n.innerHTML='<p>${copy.text}</p><div><button data-choice="no">${copy.reject}</button><button class="primary" data-choice="yes">${copy.accept}</button></div>';n.addEventListener("click",e=>{const v=e.target?.dataset?.choice;if(!v)return;set(v);n.remove();if(v==="yes")track()});const h=document.querySelector(".topbar");h?h.after(n):document.body.prepend(n)}else track()})()</script>`;
}
