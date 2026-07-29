function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function buildCollaborationRoomPage(roomId = "", locale = "en", options = {}) {
  const zh = locale === "zh";
  const workbench = Boolean(options.workbench);
  const workbenchPath = zh ? "/zh/workbench" : "/workbench";
  const collaborationPath = `${workbenchPath}/collaboration`;
  const proPath = zh ? "/zh/pro" : "/pro";
  const displayName = String(options.displayName || "").trim();
  const copy = zh ? {
    title: "临时共创 · SoloMap",
    eyebrow: "临时共创房间",
    back: "返回 SoloMap",
    recent: "最近共创",
    recentEmpty: "这个浏览器还没有其他共创房间。",
    room: "临时共创",
    privacy: "消息在你的设备上加密，密文会随房间到期自动清理。",
    inviteLabel: "邀请码",
    invitePlaceholder: "粘贴 SoloMap 邀请码",
    waiting: "等待加入",
    nameLabel: "你的昵称",
    namePlaceholder: "输入参与者昵称",
    join: "加入共创",
    joining: "正在连接…",
    missing: "请输入完整的邀请码。",
    invalidInvite: "邀请码无效，请确认复制完整后重试。",
    connecting: "正在连接",
    connected: "已连接",
    offline: "连接已断开",
    expired: "房间已结束",
    participants: "人在线",
    expires: "后结束",
    empty: "从一个具体问题开始。聊天会消失，有价值的想法可以被带回项目。",
    messageLabel: "消息",
    messagePlaceholder: "分享一个想法、问题或审计意见…",
    send: "发送",
    copy: "复制",
    copied: "已复制",
    retry: "重新连接",
    storage: "房间列表只保存在这个浏览器。",
    error: "暂时无法加入房间，请检查邀请码或稍后重试。",
    workbench: "个人工作台",
    projects: "我的项目",
    collaboration: "共创空间",
    workspaceTitle: "加入一次正在发生的共创",
    workspaceLead: "粘贴插件生成的邀请码，即可与项目负责人实时讨论需求、反馈和审计意见。",
    workspaceBoundary: "官网只接入这次共创，不读取或上传插件中的项目、代码和 Agent 记录。",
    account: "当前账号"
  } : {
    title: "Quick co-create · SoloMap",
    eyebrow: "Quick co-create room",
    back: "Back to SoloMap",
    recent: "Recent rooms",
    recentEmpty: "No other co-create rooms are saved in this browser.",
    room: "Quick co-create",
    privacy: "Messages are encrypted on your device. Ciphertext is cleared automatically when the room ends.",
    inviteLabel: "Invite code",
    invitePlaceholder: "Paste a SoloMap invite code",
    waiting: "Waiting to join",
    nameLabel: "Your name",
    namePlaceholder: "Enter a participant name",
    join: "Join room",
    joining: "Connecting…",
    missing: "Enter the complete invite code.",
    invalidInvite: "That invite code is invalid. Copy the complete code and try again.",
    connecting: "Connecting",
    connected: "Connected",
    offline: "Disconnected",
    expired: "Room ended",
    participants: "online",
    expires: "remaining",
    empty: "Start with one concrete question. The chat disappears; useful ideas can move back into the project.",
    messageLabel: "Message",
    messagePlaceholder: "Share an idea, question, or review note…",
    send: "Send",
    copy: "Copy",
    copied: "Copied",
    retry: "Reconnect",
    storage: "Your room list stays in this browser.",
    error: "The room is unavailable. Check the invite code or try again shortly.",
    workbench: "Personal workbench",
    projects: "My projects",
    collaboration: "Co-create space",
    workspaceTitle: "Join a co-create session in progress",
    workspaceLead: "Paste an invite code from the extension to discuss requirements, feedback, and review notes with the project owner.",
    workspaceBoundary: "The website joins only this room. It does not read or upload projects, code, or Agent history from the extension.",
    account: "Signed in as"
  };

  return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(copy.title)}</title>
  <style>
    :root{color-scheme:dark;--bg:#0d0d0f;--surface:#161618;--surface-2:#1d1d20;--border:#303035;--text:#f4f1ed;--muted:#aaa4a0;--red:#ef4650;--teal:#4bd7cf;--focus:#79e5de;--danger:#ff8a91;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .brand{text-decoration:none}.workspace-nav{width:min(1180px,calc(100% - 40px));margin:0 auto;min-height:58px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.08)}.workspace-nav a{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border-radius:10px;color:var(--muted);text-decoration:none;font-size:14px;font-weight:700}.workspace-nav a:hover,.workspace-nav a:focus-visible{color:var(--text);background:var(--surface-2)}.workspace-nav a.active{color:var(--text);background:rgba(75,215,207,.1);box-shadow:inset 0 0 0 1px rgba(75,215,207,.28)}.workspace-account{color:var(--muted);font-size:13px}.workspace-intro{width:min(1180px,calc(100% - 40px));margin:0 auto;padding:32px 0 4px}.workspace-intro h1{margin:0 0 10px;font-size:clamp(28px,4vw,40px);line-height:1.15;letter-spacing:-.025em}.workspace-intro p{max-width:720px;margin:0;color:var(--muted);line-height:1.65}.workspace-intro .workspace-boundary{margin-top:8px;font-size:13px}.workbench-room .layout{min-height:calc(100dvh - 258px);padding-top:20px}.workbench-room .room-shell{min-height:620px}@media(max-width:760px){.workspace-account{max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-nav{width:calc(100% - 24px);overflow-x:auto}.workspace-nav a{flex:0 0 auto}.workspace-intro{width:calc(100% - 32px);padding-top:24px}.workbench-room .room-shell{min-height:calc(100dvh - 260px)}}
    *{box-sizing:border-box}body{margin:0;min-height:100dvh;background:radial-gradient(circle at 15% 0%,rgba(239,70,80,.13),transparent 34%),radial-gradient(circle at 100% 100%,rgba(75,215,207,.11),transparent 36%),var(--bg);color:var(--text)}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.48}a{color:inherit}.topbar{height:64px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(13,13,15,.86);backdrop-filter:blur(16px)}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.02em}.brand-mark{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--red),var(--teal));box-shadow:0 8px 24px rgba(239,70,80,.2)}.back{font-size:14px;color:var(--muted);text-decoration:none}.back:hover{color:var(--text)}.layout{width:min(1180px,100%);margin:0 auto;min-height:calc(100dvh - 64px);display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px;padding:24px}.recent{padding:18px;border:1px solid var(--border);border-radius:18px;background:rgba(22,22,24,.82);align-self:start}.recent h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}.recent-list{display:flex;flex-direction:column;gap:8px}.recent-item{width:100%;min-height:48px;padding:10px 12px;text-align:left;color:var(--text);border:1px solid transparent;border-radius:12px;background:transparent}.recent-item:hover,.recent-item:focus-visible{background:var(--surface-2);border-color:var(--border)}.recent-item.active{border-color:rgba(75,215,207,.45);background:rgba(75,215,207,.08)}.recent-name{display:block;font-weight:700;font-size:14px}.recent-meta,.recent-empty,.storage-note{display:block;color:var(--muted);font-size:12px;line-height:1.5}.storage-note{margin:16px 0 0}.room-shell{min-width:0;border:1px solid var(--border);border-radius:22px;background:rgba(22,22,24,.92);box-shadow:0 24px 80px rgba(0,0,0,.28);overflow:hidden;display:flex;flex-direction:column;min-height:calc(100dvh - 112px)}.room-head{padding:20px 22px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.eyebrow{font-size:12px;color:var(--teal);font-weight:800;text-transform:uppercase;letter-spacing:.08em}.room-head h1{font-size:24px;line-height:1.2;margin:5px 0 6px}.privacy{max-width:700px;margin:0;color:var(--muted);font-size:13px;line-height:1.55}.room-status{flex:none;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.status-dot{width:9px;height:9px;border-radius:50%;background:#7a7672}.status-dot.online{background:var(--teal);box-shadow:0 0 0 4px rgba(75,215,207,.12)}.status-dot.error{background:var(--danger)}.join-card{width:min(480px,calc(100% - 32px));margin:auto;padding:28px;border:1px solid var(--border);border-radius:18px;background:var(--surface-2)}.join-card[hidden],.chat[hidden]{display:none}.join-card label,.composer-label{display:block;font-size:13px;font-weight:750;margin-bottom:8px}.input{width:100%;min-height:48px;padding:11px 13px;color:var(--text);background:#111113;border:1px solid var(--border);border-radius:12px;outline:none}.input:focus{border-color:var(--focus);box-shadow:0 0 0 3px rgba(75,215,207,.13)}.primary{min-height:48px;padding:11px 18px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--red),#d83d75);color:#fff;font-weight:800}.join-card .primary{width:100%;margin-top:12px}.join-message{min-height:20px;margin:10px 0 0;color:var(--danger);font-size:13px;line-height:1.5}.chat{flex:1;min-height:0;display:flex;flex-direction:column}.messages{flex:1;min-height:280px;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:12px}.empty{margin:auto;max-width:520px;text-align:center;color:var(--muted);line-height:1.65}.message{max-width:min(680px,88%);padding:12px 14px;border:1px solid var(--border);border-radius:14px 14px 14px 4px;background:var(--surface-2);align-self:flex-start}.message.mine{align-self:flex-end;border-radius:14px 14px 4px 14px;background:rgba(239,70,80,.12);border-color:rgba(239,70,80,.35)}.message-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px}.message-author{font-size:12px;font-weight:800;color:var(--teal)}.message-time{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.message-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}.message-actions{display:flex;justify-content:flex-end;margin-top:8px}.message-copy{min-height:32px;padding:4px 9px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--muted);font-size:12px}.message-copy:hover,.message-copy:focus-visible{color:var(--text);border-color:#5a575c}.composer{padding:16px 20px 20px;border-top:1px solid var(--border);background:rgba(13,13,15,.5)}.composer-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.composer textarea{resize:none;min-height:52px;max-height:180px;line-height:1.45}.room-foot{display:flex;flex-wrap:wrap;gap:12px 18px;padding:0 20px 16px;color:var(--muted);font-size:12px}.reconnect{border:0;background:none;color:var(--teal);padding:0;text-decoration:underline}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}:focus-visible{outline:2px solid var(--focus);outline-offset:3px}@media(max-width:760px){.topbar{padding:0 16px}.layout{display:block;padding:12px}.recent{margin-bottom:12px;padding:14px}.recent-list{flex-direction:row;overflow:auto}.recent-item{min-width:180px}.room-active .recent{display:none}.room-shell{min-height:calc(100dvh - 164px);border-radius:18px}.room-active .room-shell{min-height:calc(100dvh - 88px)}.room-head{padding:18px;display:block}.room-status{margin-top:12px}.messages{padding:16px}.message{max-width:94%}.composer{padding:12px}.composer-row{grid-template-columns:1fr}.primary{width:100%}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body${workbench ? ' class="workbench-room"' : ""}>
  ${workbench
    ? `<header class="topbar"><a class="brand" href="${workbenchPath}"><span class="brand-mark" aria-hidden="true"></span><span>SoloMap · ${escapeHtml(copy.workbench)}</span></a><span class="workspace-account">${escapeHtml(copy.account)} · ${escapeHtml(displayName)}</span></header><nav class="workspace-nav" aria-label="${escapeHtml(copy.workbench)}"><a href="${workbenchPath}">${escapeHtml(copy.projects)}</a><a class="active" aria-current="page" href="${collaborationPath}">${escapeHtml(copy.collaboration)}</a><a href="${proPath}">SoloMap Pro</a></nav><section class="workspace-intro"><h1>${escapeHtml(copy.workspaceTitle)}</h1><p>${escapeHtml(copy.workspaceLead)}</p><p class="workspace-boundary">${escapeHtml(copy.workspaceBoundary)}</p></section>`
    : `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>SoloMap · ${escapeHtml(copy.eyebrow)}</span></div><a class="back" href="${zh ? "/zh" : "/"}">${escapeHtml(copy.back)}</a></header>`}
  <main class="layout">
    <aside class="recent" aria-labelledby="recent-title"><h2 id="recent-title">${escapeHtml(copy.recent)}</h2><div class="recent-list" id="recent-list"></div><p class="storage-note">${escapeHtml(copy.storage)}</p></aside>
    <section class="room-shell" aria-labelledby="room-title">
      <header class="room-head"><div><div class="eyebrow">${escapeHtml(copy.eyebrow)}</div><h1 id="room-title">${escapeHtml(copy.room)}</h1><p class="privacy">${escapeHtml(copy.privacy)}</p></div><div class="room-status" role="status" aria-live="polite"><span class="status-dot" id="status-dot"></span><span id="status-text">${escapeHtml(copy.connecting)}</span></div></header>
      <section class="join-card" id="join-card"><div id="invite-field"${roomId ? " hidden" : ""}><label for="invite-code">${escapeHtml(copy.inviteLabel)}</label><input class="input" id="invite-code" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(copy.invitePlaceholder)}"></div><label for="nickname">${escapeHtml(copy.nameLabel)}</label><input class="input" id="nickname" maxlength="40" autocomplete="nickname" placeholder="${escapeHtml(copy.namePlaceholder)}"><button class="primary" id="join-button" type="button">${escapeHtml(copy.join)}</button><p class="join-message" id="join-message" role="alert"></p></section>
      <section class="chat" id="chat" hidden><div class="messages" id="messages" role="log" aria-live="polite" aria-relevant="additions"><div class="empty" id="empty">${escapeHtml(copy.empty)}</div></div><form class="composer" id="composer"><label class="composer-label" for="message-input">${escapeHtml(copy.messageLabel)}</label><div class="composer-row"><textarea class="input" id="message-input" maxlength="4000" rows="2" placeholder="${escapeHtml(copy.messagePlaceholder)}"></textarea><button class="primary" id="send-button" type="submit">${escapeHtml(copy.send)}</button></div></form><footer class="room-foot"><span id="presence">0 ${escapeHtml(copy.participants)}</span><span id="countdown"></span><button class="reconnect" id="reconnect" type="button" hidden>${escapeHtml(copy.retry)}</button></footer></section>
    </section>
  </main>
  <script>
  (() => {
    let roomId = ${inlineJson(roomId)};
    const localePrefix = ${inlineJson(zh ? "/zh" : "")};
    const copy = ${inlineJson(copy)};
    const accountNickname = ${inlineJson(workbench ? displayName : "")};
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = { socket: null, key: null, relayToken: "", encryptionKey: "", expiresAt: 0, authorId: "", nickname: "", messages: new Map() };
    const joinCard = document.getElementById("join-card");
    const inviteField = document.getElementById("invite-field");
    const inviteInput = document.getElementById("invite-code");
    const nicknameInput = document.getElementById("nickname");
    const joinButton = document.getElementById("join-button");
    const joinMessage = document.getElementById("join-message");
    const chat = document.getElementById("chat");
    const messagesElement = document.getElementById("messages");
    const emptyElement = document.getElementById("empty");
    const messageInput = document.getElementById("message-input");
    const sendButton = document.getElementById("send-button");
    const statusDot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    const presence = document.getElementById("presence");
    const countdown = document.getElementById("countdown");
    const reconnect = document.getElementById("reconnect");

    function randomId(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return toBase64Url(value); }
    function toBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/g,""); }
    function fromBase64Url(value) { const base64 = value.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(base64); return Uint8Array.from(binary, character => character.charCodeAt(0)); }
    function parseInviteCode(value) { const code = String(value || "").trim(); if (!code.startsWith("SM1.")) throw new Error("invalid_invite_code"); const payload = fromBase64Url(code.slice(4)); if (payload.length < 4 || payload[0] !== 1) throw new Error("invalid_invite_code"); const lengths = [payload[1], payload[2], payload[3]]; if (4 + lengths.reduce((sum, length) => sum + length, 0) !== payload.length) throw new Error("invalid_invite_code"); let offset = 4; const values = lengths.map(length => { const result = decoder.decode(payload.slice(offset, offset + length)); offset += length; return result; }); if (!/^[A-Za-z0-9_-]{20,64}$/.test(values[0]) || !/^[A-Za-z0-9_-]{32,128}$/.test(values[1]) || !/^[A-Za-z0-9_-]{43}$/.test(values[2])) throw new Error("invalid_invite_code"); return { roomId: values[0], relayToken: values[1], encryptionKey: values[2] }; }
    function openDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open("solomap-collaboration", 1); request.onupgradeneeded = () => request.result.createObjectStore("rooms", { keyPath: "roomId" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    async function readRoom(id) { const db = await openDatabase(); return new Promise((resolve, reject) => { const request = db.transaction("rooms").objectStore("rooms").get(id); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); }); }
    async function writeRoom(room) { const db = await openDatabase(); return new Promise((resolve, reject) => { const request = db.transaction("rooms", "readwrite").objectStore("rooms").put(room); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
    async function readRooms() { const db = await openDatabase(); return new Promise((resolve, reject) => { const request = db.transaction("rooms").objectStore("rooms").getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); }); }
    function setStatus(kind, label) { statusDot.className = "status-dot" + (kind ? " " + kind : ""); statusText.textContent = label; }
    function formatRemaining(ms) { const minutes = Math.max(0, Math.ceil(ms / 60000)); if (minutes >= 60) return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m"; return minutes + "m"; }
    function updateCountdown() { if (!state.expiresAt) { countdown.textContent = ""; return; } const remaining = state.expiresAt - Date.now(); if (remaining <= 0) { countdown.textContent = copy.expired; setStatus("error", copy.expired); sendButton.disabled = true; messageInput.disabled = true; return; } countdown.textContent = formatRemaining(remaining) + " " + copy.expires; }
    async function importKey(value) { return crypto.subtle.importKey("raw", fromBase64Url(value), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
    async function encryptPayload(payload) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(roomId) }, state.key, encoder.encode(JSON.stringify(payload))); return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) }; }
    async function decryptEnvelope(envelope) { const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: encoder.encode(roomId) }, state.key, fromBase64Url(envelope.ciphertext)); const payload = JSON.parse(decoder.decode(plaintext)); if (!payload || typeof payload.text !== "string" || typeof payload.authorName !== "string") throw new Error("invalid payload"); const text = payload.text.trim().slice(0, 4000); const authorName = payload.authorName.trim().slice(0, 40); if (!text || !authorName) throw new Error("invalid payload"); const authoredAt = Number(payload.createdAt); const relayTime = Number(envelope.receivedAt || envelope.createdAt); const createdAt = Number.isFinite(authoredAt) && Math.abs(authoredAt - Date.now()) <= 2 * 24 * 60 * 60 * 1000 ? authoredAt : (Number.isFinite(relayTime) && Math.abs(relayTime - Date.now()) <= 2 * 24 * 60 * 60 * 1000 ? relayTime : Date.now()); return { authorName, text, createdAt }; }
    async function storeCurrentRoom() { await writeRoom({ roomId, relayToken: state.relayToken, encryptionKey: state.encryptionKey, expiresAt: state.expiresAt, nickname: state.nickname, authorId: state.authorId, lastActiveAt: Date.now() }); await renderRecentRooms(); }
    async function renderRecentRooms() { const list = document.getElementById("recent-list"); const rooms = (await readRooms()).filter(room => Number(room.expiresAt || 0) > Date.now()).sort((left, right) => Number(right.lastActiveAt || 0) - Number(left.lastActiveAt || 0)); list.replaceChildren(); if (!rooms.length) { const empty = document.createElement("span"); empty.className = "recent-empty"; empty.textContent = copy.recentEmpty; list.append(empty); return; } for (const room of rooms) { const button = document.createElement("button"); button.type = "button"; button.className = "recent-item" + (room.roomId === roomId ? " active" : ""); const name = document.createElement("span"); name.className = "recent-name"; name.textContent = copy.room + " · " + room.roomId.slice(-4).toUpperCase(); const meta = document.createElement("span"); meta.className = "recent-meta"; meta.textContent = formatRemaining(Number(room.expiresAt) - Date.now()) + " " + copy.expires; button.append(name, meta); button.addEventListener("click", () => { if (room.roomId === roomId) return; if (state.socket && state.socket.readyState < WebSocket.CLOSING) state.socket.close(1000, "Switch room"); roomId = room.roomId; state.relayToken = room.relayToken; state.encryptionKey = room.encryptionKey; state.expiresAt = Number(room.expiresAt || 0); state.authorId = room.authorId || randomId(16); state.nickname = room.nickname || state.nickname; state.messages.clear(); nicknameInput.value = state.nickname; inviteField.hidden = true; connect(); }); list.append(button); } }
    function renderMessages() { const ordered = [...state.messages.values()].sort((left, right) => Number(left.sequence || left.createdAt) - Number(right.sequence || right.createdAt)); messagesElement.querySelectorAll(".message").forEach(node => node.remove()); emptyElement.hidden = ordered.length > 0; for (const item of ordered) { const article = document.createElement("article"); article.className = "message" + (item.authorId === state.authorId ? " mine" : ""); const head = document.createElement("div"); head.className = "message-head"; const author = document.createElement("span"); author.className = "message-author"; author.textContent = item.authorName; const time = document.createElement("time"); time.className = "message-time"; time.dateTime = new Date(item.createdAt).toISOString(); time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); const text = document.createElement("div"); text.className = "message-text"; text.textContent = item.text; const actions = document.createElement("div"); actions.className = "message-actions"; const copyButton = document.createElement("button"); copyButton.type = "button"; copyButton.className = "message-copy"; copyButton.textContent = copy.copy; copyButton.addEventListener("click", async () => { await navigator.clipboard.writeText(item.text); copyButton.textContent = copy.copied; setTimeout(() => { copyButton.textContent = copy.copy; }, 1600); }); actions.append(copyButton); head.append(author, time); article.append(head, text, actions); messagesElement.append(article); } messagesElement.scrollTop = messagesElement.scrollHeight; }
    async function acceptEnvelope(envelope) { if (!envelope || envelope.type !== "message" || state.messages.has(envelope.id)) return; try { const payload = await decryptEnvelope(envelope); state.messages.set(envelope.id, { ...envelope, ...payload }); renderMessages(); } catch { /* A bad ciphertext cannot affect the rest of the room. */ } }
    async function connect() { if (!state.relayToken || !state.encryptionKey || !roomId) { joinMessage.textContent = copy.missing; setStatus("error", copy.offline); return; } if (!state.nickname.trim()) { nicknameInput.focus(); return; } joinButton.disabled = true; joinButton.textContent = copy.joining; joinMessage.textContent = ""; try { state.key = await importKey(state.encryptionKey); await storeCurrentRoom(); const protocol = location.protocol === "https:" ? "wss:" : "ws:"; const socketUrl = protocol + "//" + location.host + "/api/collaboration/rooms/" + encodeURIComponent(roomId) + "/socket?token=" + encodeURIComponent(state.relayToken); const socket = new WebSocket(socketUrl); state.socket = socket; setStatus("", copy.connecting); socket.addEventListener("open", () => { document.body.classList.add("room-active"); joinCard.hidden = true; chat.hidden = false; reconnect.hidden = true; sendButton.disabled = false; messageInput.disabled = false; setStatus("online", copy.connected); messageInput.focus(); }); socket.addEventListener("message", async event => { let message; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "history") { state.expiresAt = Number(message.expiresAt || state.expiresAt); for (const envelope of message.messages || []) await acceptEnvelope(envelope); await storeCurrentRoom(); updateCountdown(); return; } if (message.type === "presence") { presence.textContent = String(message.count || 0) + " " + copy.participants; return; } if (message.type === "error" && message.error === "message_rate_limited") { setStatus("error", copy.error); return; } await acceptEnvelope(message); }); socket.addEventListener("close", event => { if (event.code === 4001) { setStatus("error", copy.expired); countdown.textContent = copy.expired; reconnect.hidden = true; } else { setStatus("error", copy.offline); reconnect.hidden = false; } sendButton.disabled = true; messageInput.disabled = true; }); socket.addEventListener("error", () => { setStatus("error", copy.offline); reconnect.hidden = false; }); } catch { joinMessage.textContent = copy.error; setStatus("error", copy.offline); } finally { joinButton.disabled = false; joinButton.textContent = copy.join; } }
    async function sendMessage(event) { event.preventDefault(); const text = messageInput.value.trim(); if (!text || !state.socket || state.socket.readyState !== WebSocket.OPEN) return; sendButton.disabled = true; try { const createdAt = Date.now(); const encrypted = await encryptPayload({ authorName: state.nickname, text, createdAt }); state.socket.send(JSON.stringify({ type: "message", id: randomId(16), authorId: state.authorId, createdAt, ...encrypted })); messageInput.value = ""; await storeCurrentRoom(); } finally { sendButton.disabled = false; messageInput.focus(); } }
    async function initialize() { const saved = roomId ? await readRoom(roomId).catch(() => null) : null; const url = new URL(location.href); state.relayToken = url.searchParams.get("token") || saved?.relayToken || ""; state.encryptionKey = location.hash.slice(1) || saved?.encryptionKey || ""; state.expiresAt = Number(saved?.expiresAt || Date.now() + 72 * 60 * 60 * 1000); state.authorId = saved?.authorId || randomId(16); state.nickname = saved?.nickname || localStorage.getItem("solomap-collaboration-nickname") || accountNickname || ""; nicknameInput.value = state.nickname; if (url.searchParams.has("token")) history.replaceState({}, "", url.pathname); await renderRecentRooms(); if (roomId && (!state.relayToken || !state.encryptionKey)) { joinMessage.textContent = copy.missing; setStatus("error", copy.offline); } else if (!roomId) { setStatus("", copy.waiting); } updateCountdown(); }
    joinButton.addEventListener("click", () => { state.nickname = nicknameInput.value.trim(); if (!state.nickname) { nicknameInput.focus(); return; } if (!roomId || !state.relayToken || !state.encryptionKey) { try { const invite = parseInviteCode(inviteInput.value); roomId = invite.roomId; state.relayToken = invite.relayToken; state.encryptionKey = invite.encryptionKey; state.expiresAt = Date.now() + 72 * 60 * 60 * 1000; state.authorId = randomId(16); inviteField.hidden = true; } catch { joinMessage.textContent = copy.invalidInvite; inviteInput.focus(); return; } } localStorage.setItem("solomap-collaboration-nickname", state.nickname); connect(); });
    inviteInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); nicknameInput.focus(); } });
    nicknameInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); joinButton.click(); } });
    document.getElementById("composer").addEventListener("submit", sendMessage);
    messageInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.getElementById("composer").requestSubmit(); } });
    reconnect.addEventListener("click", connect);
    setInterval(updateCountdown, 30000);
    initialize().catch(() => { joinMessage.textContent = copy.error; setStatus("error", copy.offline); });
  })();
  </script>
</body>
</html>`;
}

export function collaborationRoomPageHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "img-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}
