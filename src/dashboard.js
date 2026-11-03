// Live dashboard: a page on the user's own computer showing everything the swarm is doing.
//
//   swarm-mcp dashboard [--swarm name] [--project folder] [--no-open]
//
// Always on http://127.0.0.1:56432 (SWARM_DASHBOARD_PORT to change), so the address never moves.
// One dashboard serves every board: the board is picked in the page or by ?swarm=&project= in the URL.
// The manager gets the link when it joins; any agent can hand it out with swarm_dashboard.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SwarmStore, listProjects, listSwarms, swarmHome } from "./store.js";

export const DASHBOARD_PORT = Number(process.env.SWARM_DASHBOARD_PORT) || 56432;
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dashboardUrl(swarm = "default", project = null) {
  const q = new URLSearchParams();
  if (swarm && swarm !== "default") q.set("swarm", swarm);
  if (project) q.set("project", project);
  return `http://127.0.0.1:${DASHBOARD_PORT}/${q.size ? `?${q}` : ""}`;
}

export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // no browser to open; the address is printed anyway
  }
}

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok && (await r.json()).swarm === true;
  } catch {
    return false;
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function boards() {
  const global = listSwarms().map((swarm) => ({ swarm, project: null, label: `${swarm} (global)` }));
  const projects = listProjects().map((p) => ({ swarm: p.swarm, project: p.root, usedAt: p.usedAt, label: `${path.basename(p.root)}${p.swarm === "default" ? "" : ` / ${p.swarm}`}` }));
  return [...projects, ...global];
}

export async function startDashboard({ swarm = "default", project = null, open = true } = {}) {
  const url = dashboardUrl(swarm, project);
  if (await alive()) {
    console.log(`Swarm dashboard already running: ${url}`);
    if (open) openBrowser(url);
    return null;
  }
  const { snapshot } = await import("./server.js"); // lazy: server.js imports this module too
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    try {
      if (u.pathname === "/api/health") return send(res, 200, "application/json", '{"swarm":true}');
      if (u.pathname === "/api/boards") return send(res, 200, "application/json", JSON.stringify(boards()));
      if (u.pathname === "/api") {
        const store = new SwarmStore(u.searchParams.get("swarm") || "default", { project: u.searchParams.get("project") || null });
        const state = await store.view();
        const system = {
          board: store.file,
          serverTime: new Date().toISOString(),
          clients: readJson(path.join(swarmHome(), "clients.json")) || {},
          hooks: readJson(path.join(swarmHome(), "hooks-seen.json")) || {},
          update: readJson(path.join(swarmHome(), "update-check.json")),
        };
        return send(res, 200, "application/json", JSON.stringify({ ...snapshot(state), system }));
      }
      if (u.pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      send(res, 404, "text/plain", "Not found");
    } catch (err) {
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", (err) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${DASHBOARD_PORT} is used by another program. Free it, or set SWARM_DASHBOARD_PORT.`) : err),
    );
    server.listen(DASHBOARD_PORT, "127.0.0.1", resolve);
  });
  console.log(`Swarm dashboard: ${url}\n(Ctrl+C to stop)`);
  if (open) openBrowser(url);
  return server;
}

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** Make sure the dashboard is running (in the background if needed) and return the link to this board. */
export async function ensureDashboard({ swarm = "default", project = null, open = false } = {}) {
  const url = dashboardUrl(swarm, project);
  if (process.env.SWARM_NO_DASHBOARD) return url; // tests: don't leave a server running
  if (!(await alive())) {
    spawn(process.execPath, [ENTRY, "dashboard", "--no-open"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 40 && !(await alive()); i++) await sleep(150);
    if (!(await alive())) return null;
  }
  if (open) openBrowser(url);
  return url;
}

// ------------------------------------------------------------------------------------------- the page
// A dispatch board: ruled ledger, one lane per agent, and the wire of everything that happens.
// Ink on paper (or paper on ink in the dark), one signal colour, tabular figures. No framework.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm · dispatch</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%231c1b18'/%3E%3Crect x='3' y='3' width='4' height='4' fill='%23c2410c'/%3E%3Crect x='9' y='3' width='4' height='4' fill='%23f2eee5'/%3E%3Crect x='3' y='9' width='4' height='4' fill='%23f2eee5'/%3E%3Crect x='9' y='9' width='4' height='4' fill='%23f2eee5'/%3E%3C/svg%3E">
<style>
:root{
  --paper:#f2eee5; --paper2:#e8e2d4; --ink:#1c1b18; --ink2:#4b473f; --mute:#8b8475; --rule:#d2c9b7; --rule2:#e1dacb;
  --signal:#c2410c; --go:#3f6b3a; --hold:#a16207; --stop:#9f1239;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --mono:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --paper:#12110e; --paper2:#1b1915; --ink:#ebe5d6; --ink2:#bdb5a3; --mute:#7f786a; --rule:#302c25; --rule2:#24211c;
  --signal:#f0782f; --go:#8db57f; --hold:#d6a23a; --stop:#e1567a;}}
:root[data-theme=dark]{
  --paper:#12110e; --paper2:#1b1915; --ink:#ebe5d6; --ink2:#bdb5a3; --mute:#7f786a; --rule:#302c25; --rule2:#24211c;
  --signal:#f0782f; --go:#8db57f; --hold:#d6a23a; --stop:#e1567a;}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink)}
body{font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.num,time,code,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
main{max-width:1440px;margin:0 auto;padding:22px 28px 48px}
@media (max-width:700px){main{padding:16px}}
.cap{font:600 11px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
button,select{font:inherit;color:inherit}
a{color:inherit}

/* masthead */
.mast{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 32px;align-items:end;padding-bottom:16px;border-bottom:3px double var(--ink)}
.bar0{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.word{font:700 13px/1 var(--sans);letter-spacing:.32em}
.word i{display:inline-block;width:9px;height:9px;background:var(--signal);margin-right:8px;vertical-align:0}
.sel{background:transparent;border:1px solid var(--rule);padding:4px 8px;border-radius:0;max-width:340px}
.live{display:inline-flex;gap:7px;align-items:center}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--go)}
.live.on .pulse{animation:p 2s ease-in-out infinite}
.live.off .pulse{background:var(--mute)} .live.err .pulse{background:var(--stop)}
@keyframes p{50%{opacity:.25}}
.tools{margin-left:auto;display:flex;gap:6px}
.btn{background:transparent;border:1px solid var(--rule);padding:3px 10px;cursor:pointer}
.btn:hover{border-color:var(--ink)}
.btn[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
h1{font:400 clamp(26px,3.4vw,42px)/1.08 var(--serif);margin:14px 0 8px;letter-spacing:-.01em;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;gap:4px 18px;color:var(--ink2);font-size:12.5px}
.meta b{font-weight:600;color:var(--ink)}
.pct{text-align:right}
.pct .big{font:500 clamp(48px,6vw,76px)/.9 var(--mono);letter-spacing:-.04em}
.pct .big small{font-size:.42em;color:var(--mute);letter-spacing:0}
.pct .sub{margin-top:8px;color:var(--ink2);font-size:12.5px}

/* segmented progress: one cell per task */
.track{display:flex;gap:2px;height:10px;margin:14px 0 6px}
.track span{flex:1;background:var(--rule2);position:relative;overflow:hidden}
.track span i{position:absolute;inset:0 auto 0 0;background:var(--signal)}
.track .done{background:var(--ink)} .track .review{background:var(--hold)} .track .blocked{background:var(--stop)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11.5px;color:var(--mute)}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;margin-right:6px;vertical-align:-1px;background:var(--c)}

.alerts{margin:18px 0 0;border:1px solid var(--signal);border-left-width:5px;padding:10px 14px}
.alerts p{margin:3px 0;color:var(--ink)} .alerts .cap{color:var(--signal)}

/* layout */
.cols{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(320px,1fr);gap:0 36px;margin-top:22px}
@media (max-width:1100px){.cols{grid-template-columns:1fr}}
section{margin-top:26px}
section>header{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--ink);padding-bottom:6px;margin-bottom:2px}
section>header h2{font:600 12px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;margin:0}
section>header .cap{margin-left:auto;letter-spacing:.06em;text-transform:none;font-weight:400;font-size:12px}
.empty{color:var(--mute);padding:14px 0;font-style:italic;font-family:var(--serif)}

/* crew lanes */
.lane{display:grid;grid-template-columns:minmax(150px,1.1fr) 92px minmax(0,2.2fr) 128px 74px;gap:14px;align-items:center;padding:11px 0;border-bottom:1px dotted var(--rule)}
@media (max-width:820px){.lane{grid-template-columns:1fr auto;}.lane .strip,.lane .seen{display:none}.lane .job{grid-column:1/-1}}
.who b{font:600 14px/1.2 var(--mono)} .who .cap{display:block;margin-top:4px;letter-spacing:.08em;font-size:10px}
.sw{display:inline-block;width:8px;height:8px;margin-right:7px;vertical-align:1px}
.state{font:700 10.5px/1 var(--sans);letter-spacing:.14em}
.state.working{color:var(--signal)} .state.waiting,.state.active{color:var(--go)} .state.stopped{color:var(--hold)} .state.left{color:var(--mute);text-decoration:line-through}
.job .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.job .t .mono{color:var(--mute)}
.rule{height:3px;background:var(--rule2);margin:6px 0 4px;position:relative}
.rule i{position:absolute;inset:0 auto 0 0;background:var(--signal)}
.job .d{font-size:11.5px;color:var(--ink2)}
.owe{color:var(--signal);font-weight:600}
.strip svg{display:block;width:128px;height:26px}
.strip rect{fill:var(--ink2)} .strip line{stroke:var(--rule)}
.seen{text-align:right;color:var(--mute);font-size:12px}

/* ledger */
table{width:100%;border-collapse:collapse}
th{font:600 10.5px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--mute);text-align:left;padding:10px 8px 8px 0}
td{padding:9px 8px 9px 0;border-top:1px dotted var(--rule);vertical-align:top}
tr.row{cursor:pointer} tr.row:hover td{background:var(--paper2)}
tr.blocked td:first-child{box-shadow:inset 3px 0 var(--stop)}
td.n{width:46px;color:var(--mute)} td.p{width:150px} td.w{width:130px;white-space:nowrap} td.s{width:96px} td.u{width:70px;color:var(--mute);text-align:right}
.st{font:700 10px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase}
.st.done{color:var(--go)} .st.in_progress{color:var(--signal)} .st.review{color:var(--hold)} .st.blocked{color:var(--stop)} .st.todo{color:var(--ink2)} .st.cancelled{color:var(--mute);text-decoration:line-through}
.tiny{font-size:11.5px;color:var(--mute)}
tr.more td{border-top:none;padding-top:0}
.detail{display:grid;grid-template-columns:110px 1fr;gap:4px 14px;padding:4px 0 14px;font-size:13px}
.detail dt{color:var(--mute);font-size:11.5px;padding-top:2px} .detail dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.detail ul{margin:0;padding-left:16px}

/* messages */
.msg{padding:10px 0;border-bottom:1px dotted var(--rule);display:grid;grid-template-columns:auto 1fr auto;gap:2px 12px}
.msg .h{font-size:12px} .msg .h b{font-family:var(--mono);font-weight:600}
.msg .c{grid-column:1/-1;font-family:var(--serif);font-size:15px;line-height:1.45;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.msg.open .c{display:block;cursor:auto}
.thread{border-bottom:1px solid var(--rule);padding-bottom:4px}
.thread .msg{border-bottom:none}
.msg.reply{margin-left:26px;padding:6px 0 6px 14px;border-left:2px solid var(--rule)}
.msg.reply .c{font-size:14px}
.msg .tag{font:700 10px/1.6 var(--sans);letter-spacing:.1em;text-transform:uppercase}
.tag.await{color:var(--signal)} .tag.ok{color:var(--go)} .tag.fyi,.tag.re{color:var(--mute)}

/* wire */
.filters{display:flex;flex-wrap:wrap;gap:6px;padding:10px 0 6px}
.chip{border:1px solid var(--rule);background:transparent;padding:2px 9px;font-size:12px;cursor:pointer}
.chip[aria-pressed=true]{border-color:var(--ink);background:var(--ink);color:var(--paper)}
.wire{list-style:none;margin:0;padding:0;max-height:640px;overflow:auto;border-top:1px dotted var(--rule)}
.wire li{display:grid;grid-template-columns:62px 16px minmax(0,1fr);gap:8px;padding:6px 4px 6px 0;border-bottom:1px dotted var(--rule2);font-size:12.5px}
.wire li time{color:var(--mute);font-size:11.5px;padding-top:1px}
.wire .g{color:var(--mute);text-align:center}
.wire li.fresh{animation:f 2.4s ease-out}
@keyframes f{from{background:color-mix(in srgb,var(--signal) 18%,transparent)}to{background:transparent}}
.wire .by{font-family:var(--mono);font-weight:600}

/* side panels */
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;padding:10px 0;font-size:12.5px}
.kv dt{color:var(--mute)} .kv dd{margin:0;text-align:right;font-family:var(--mono);overflow-wrap:anywhere}
.lock,.note{padding:8px 0;border-bottom:1px dotted var(--rule);font-size:12.5px}
.note summary{cursor:pointer;font-family:var(--mono);font-weight:600}
.note pre{white-space:pre-wrap;font:13px/1.5 var(--serif);margin:8px 0 2px;color:var(--ink2)}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--rule);display:flex;flex-wrap:wrap;gap:6px 22px;color:var(--mute);font-size:12px}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
</style>
</head>
<body>
<main>
  <div class="mast">
    <div class="bar0">
      <span class="word"><i></i>SWARM</span>
      <select class="sel" id="board" aria-label="Board"></select>
      <span class="live on cap" id="live"><span class="pulse"></span><span id="liveText">live</span></span>
      <div class="tools">
        <button class="btn cap" id="pause" aria-pressed="false">Pause</button>
        <button class="btn cap" id="theme" title="Light / dark">◐</button>
      </div>
    </div>
    <div>
      <h1 id="goal">Connecting…</h1>
      <div class="meta" id="meta"></div>
    </div>
    <div class="pct"><div class="big num" id="pct">0<small>%</small></div><div class="sub num" id="counts"></div></div>
  </div>
  <div class="track" id="track"></div>
  <div class="legend"><span style="--c:var(--ink)">done</span><span style="--c:var(--hold)">review</span><span style="--c:var(--signal)">in progress (fill = % done)</span><span style="--c:var(--stop)">blocked</span><span style="--c:var(--rule2)">not started</span></div>
  <div class="alerts" id="alerts" hidden><span class="cap">Needs attention</span><div id="alertList"></div></div>

  <div class="cols">
    <div>
      <section><header><h2>Crew</h2><span class="cap" id="crewNote"></span></header><div id="crew"></div></section>
      <section><header><h2>Ledger</h2><span class="cap">click a row for its brief, notes, files and result</span></header>
        <table><thead><tr><th>No.</th><th>Task</th><th>Owner</th><th>State</th><th>Progress</th><th style="text-align:right">Moved</th></tr></thead><tbody id="ledger"></tbody></table>
      </section>
      <section><header><h2>Conversations</h2><span class="cap" id="msgNote"></span></header><div class="filters" id="convoWho"></div><div id="messages"></div></section>
    </div>
    <div>
      <section><header><h2>Wire</h2><span class="cap" id="wireNote"></span></header>
        <div class="filters" id="kinds"></div><div class="filters" id="people" style="padding-top:0"></div>
        <ul class="wire" id="wire"></ul>
      </section>
      <section><header><h2>Locks</h2><span class="cap" id="lockNote"></span></header><div id="locks"></div></section>
      <section><header><h2>Shared notes</h2></header><div id="notes"></div></section>
      <section><header><h2>Under the hood</h2></header><dl class="kv" id="engine"></dl><div id="clients"></div></section>
    </div>
  </div>
  <footer><span id="boardPath"></span><span id="updated"></span></footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const rel = (iso) => { if (!iso) return "—"; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d"; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const INKS = ["#c2410c", "#3f6b3a", "#9f1239", "#0f766e", "#a16207", "#6b4f2a", "#7c2d12", "#57534e"];
const colorOf = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return name === "swarm" ? "var(--mute)" : INKS[h % INKS.length]; };
const GLYPH = { join: "→", leave: "←", task_created: "+", task_claimed: "▸", task_done: "✓", task_review: "◇", task_blocked: "!", task_cancelled: "×", task_todo: "↺", task_returned: "↺", task_updated: "·", message: "✉", lock: "⌗", unlock: "⌗", note: "¶", round: "↻", finish: "■", update: "⇡" };
const KINDS = { all: () => true, tasks: (t) => t.startsWith("task"), messages: (t) => t === "message", presence: (t) => t === "join" || t === "leave", files: (t) => t === "lock" || t === "unlock" };

const params = new URLSearchParams(location.search);
let board = { swarm: params.get("swarm") || "default", project: params.get("project") || null };
let paused = false, kind = "all", people = new Set(), open = new Set(), seen = new Set(), first = true, last = null;

const root = document.documentElement;
try { const t = localStorage.getItem("swarm-theme"); if (t) root.dataset.theme = t; } catch {}
$("theme").onclick = () => { const dark = getComputedStyle(root).getPropertyValue("--paper").trim() === "#12110e"; root.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("swarm-theme", root.dataset.theme); } catch {} };
$("pause").onclick = () => { paused = !paused; $("pause").setAttribute("aria-pressed", paused); $("pause").textContent = paused ? "Resume" : "Pause"; setLive(); };
$("board").onchange = (e) => { board = JSON.parse(e.target.value); const q = new URLSearchParams(); if (board.swarm !== "default") q.set("swarm", board.swarm); if (board.project) q.set("project", board.project); history.replaceState(null, "", "?" + q); seen.clear(); first = true; people.clear(); load(); };
const openMsgs = new Set();
$("convoWho").onclick = (e) => { const b = e.target.closest("[data-w]"); if (b) { convoWho = b.dataset.w || null; convoLimit = 20; if (last) messages(last); } };
$("messages").onclick = (e) => { if (e.target.id === "more") { convoLimit += 20; return messages(last); } const m = e.target.closest(".msg"); if (!m || getSelection().toString()) return; const id = Number(m.dataset.m); openMsgs.has(id) ? openMsgs.delete(id) : openMsgs.add(id); m.classList.toggle("open"); };
$("ledger").onclick = (e) => { const tr = e.target.closest("tr.row"); if (!tr) return; const id = Number(tr.dataset.id); open.has(id) ? open.delete(id) : open.add(id); if (last) ledger(last); };

function setLive(err) { const el = $("live"); el.className = "live cap " + (err ? "err" : paused ? "off" : "on"); $("liveText").textContent = err ? "disconnected" : paused ? "paused" : "live"; }

async function loadBoards() {
  try {
    const list = await (await fetch("/api/boards", { cache: "no-store" })).json();
    const key = (b) => JSON.stringify({ swarm: b.swarm, project: b.project || null });
    const cur = key(board);
    if (!list.some((b) => key(b) === cur)) list.unshift({ ...board, label: (board.project ? board.project.split(/[\\/]/).pop() : board.swarm) + " (this board)" });
    $("board").innerHTML = list.map((b) => '<option value="' + esc(key(b)) + '"' + (key(b) === cur ? " selected" : "") + ">" + esc(b.label) + "</option>").join("");
  } catch {}
}

async function load() {
  if (paused) return;
  const q = new URLSearchParams({ swarm: board.swarm }); if (board.project) q.set("project", board.project);
  let d;
  try { d = await (await fetch("/api?" + q, { cache: "no-store" })).json(); } catch { setLive(true); return; }
  if (d.error) { setLive(true); $("goal").textContent = d.error; return; }
  setLive(false); last = d; render(d); first = false;
}

function render(d) {
  const t = d.totals;
  document.title = t.percent + "% · " + (d.goal || "Swarm");
  $("goal").textContent = d.goal || "No goal yet: waiting for a manager";
  $("meta").innerHTML = [
    d.project ? "<span>Project <b class=mono>" + esc(d.project) + "</b></span>" : "<span>Global board <b class=mono>" + esc(d.swarm) + "</b></span>",
    "<span>Round <b class=num>" + d.round + "</b></span>",
    "<span>Started <b>" + rel(d.createdAt) + " ago</b></span>",
    d.finished ? '<span style="color:var(--go)"><b>Finished ' + rel(d.finishedAt) + " ago</b></span>" : "",
  ].join("");
  $("pct").innerHTML = t.percent + "<small>%</small>";
  $("counts").textContent = t.done + "/" + t.tasks + " done · " + t.inProgress + " moving · " + t.review + " in review · " + t.todo + " queued" + (t.blocked ? " · " + t.blocked + " blocked" : "");
  const live = d.tasks.filter((x) => x.status !== "cancelled");
  $("track").innerHTML = live.length ? live.map((x) => '<span class="' + x.status + '" title="#' + x.id + " " + esc(x.title) + " — " + x.status.replace("_", " ") + '">' + (x.status === "in_progress" ? '<i style="width:' + x.progress + '%"></i>' : "") + "</span>").join("") : "<span></span>";
  $("alerts").hidden = !d.alerts.length; $("alertList").innerHTML = d.alerts.map((a) => "<p>" + esc(a) + "</p>").join("");
  crew(d); ledger(d); messages(d); wire(d); side(d);
  $("boardPath").innerHTML = "Board file <code>" + esc(d.system.board) + "</code>";
  $("updated").textContent = "last activity " + rel(d.updatedAt) + " ago · refreshed " + clock(d.system.serverTime);
}

function crew(d) {
  const now = Date.now(), H = 3600e3;
  const buckets = (name) => { const b = new Array(30).fill(0); for (const e of d.activity) { if (e.by !== name) continue; const age = now - Date.parse(e.at); if (age < H) b[29 - Math.floor(age / 120e3)]++; } return b; };
  const order = { working: 0, waiting: 1, active: 2, stopped: 3, left: 4 };
  const agents = [...d.agents].sort((a, b) => order[a.presence] - order[b.presence] || a.name.localeCompare(b.name));
  $("crewNote").textContent = agents.filter((a) => a.presence === "working").length + " working · " + agents.filter((a) => a.presence === "waiting" || a.presence === "active").length + " ready · " + agents.filter((a) => a.presence === "stopped").length + " silent · " + agents.filter((a) => a.presence === "left").length + " left";
  $("crew").innerHTML = agents.map((a) => {
    const b = buckets(a.name), max = Math.max(1, ...b);
    const bars = b.map((n, i) => n ? '<rect x="' + (i * 128 / 30 + .5) + '" y="' + (24 - Math.max(2, n / max * 22)) + '" width="' + (128 / 30 - 1.5) + '" height="' + Math.max(2, n / max * 22) + '"/>' : "").join("");
    const job = a.task
      ? '<div class="t"><span class="mono">#' + a.task.id + "</span> " + esc(a.task.title) + '</div><div class="rule"><i style="width:' + a.task.progress + '%"></i></div><div class="d num">' + a.task.progress + "%" + (a.task.eta ? " · eta " + esc(a.task.eta) : "") + " · claimed " + rel(a.task.claimedAt) + " ago · last update " + rel(a.task.progressAt) + " ago</div>"
      : '<div class="d">' + esc(a.state) + (a.waitingUntil ? " · waiting in a call until " + clock(a.waitingUntil) : "") + "</div>";
    const extra = [a.owes.length ? '<span class="owe">owes a reply to ' + a.owes.map((n) => "#" + n).join(", ") + "</span>" : "", a.unread ? a.unread + " unread" : ""].filter(Boolean).join(" · ");
    return '<div class="lane"><div class="who"><b><span class="sw" style="background:' + colorOf(a.name) + '"></span>' + esc(a.name) + '</b><span class="cap">' + esc(a.role) + (a.client ? " · " + esc(a.client) : "") + '</span></div><div class="state ' + a.presence + '">' + a.presence.toUpperCase() + '</div><div class="job">' + job + (extra ? '<div class="d">' + extra + "</div>" : "") + '</div><div class="strip" title="activity, last hour"><svg viewBox="0 0 128 26" preserveAspectRatio="none"><line x1="0" y1="25.5" x2="128" y2="25.5"/>' + bars + '</svg></div><div class="seen num" title="last seen">' + rel(a.lastSeen) + "</div></div>";
  }).join("") || '<div class="empty">Nobody has joined this board yet.</div>';
}

function ledger(d) {
  const rows = [...d.tasks].sort((a, b) => (a.status === "cancelled") - (b.status === "cancelled") || a.id - b.id);
  $("ledger").innerHTML = rows.map((x) => {
    const progress = x.status === "in_progress" ? '<div class="rule" style="margin-top:7px"><i style="width:' + x.progress + '%"></i></div><div class="tiny num">' + x.progress + "%" + (x.eta ? " · " + esc(x.eta) : "") + "</div>" : '<span class="tiny num">' + (x.status === "done" ? "100%" : x.status === "todo" && x.waitingOnDeps ? "waits on " + x.dependsOn.map((n) => "#" + n).join(", ") : "—") + "</span>";
    let html = '<tr class="row ' + x.status + '" data-id="' + x.id + '"><td class="n num">#' + x.id + "</td><td>" + esc(x.title) + (x.priority === "high" ? ' <span class="tiny" style="color:var(--signal)">high</span>' : "") + (x.files.length ? '<div class="tiny">' + x.files.length + " file" + (x.files.length > 1 ? "s" : "") + " changed</div>" : "") + '</td><td class="w mono">' + (x.assignee ? '<span class="sw" style="background:' + colorOf(x.assignee) + '"></span>' + esc(x.assignee) : '<span class="tiny">open</span>') + '</td><td class="s"><span class="st ' + x.status + '">' + x.status.replace("_", " ") + '</span></td><td class="p">' + progress + '</td><td class="u num">' + rel(x.updatedAt) + "</td></tr>";
    if (open.has(x.id)) html += '<tr class="more"><td></td><td colspan="5"><dl class="detail">' +
      (x.description ? "<dt>Brief</dt><dd>" + esc(x.description) + "</dd>" : "") +
      "<dt>Created</dt><dd>" + rel(x.createdAt) + " ago by " + esc(x.createdBy) + (x.claimedAt ? " · claimed " + rel(x.claimedAt) + " ago" : "") + "</dd>" +
      (x.dependsOn.length ? "<dt>Depends on</dt><dd class=mono>" + x.dependsOn.map((n) => "#" + n).join(", ") + "</dd>" : "") +
      (x.result ? "<dt>Result</dt><dd>" + esc(x.result) + "</dd>" : "") +
      (x.files.length ? "<dt>Files</dt><dd><ul>" + x.files.map((f) => "<li><code>" + esc(f) + "</code></li>").join("") + "</ul></dd>" : "") +
      (x.notes.length ? "<dt>Notes</dt><dd><ul>" + x.notes.map((n) => "<li><span class=tiny>" + esc(n.by) + " · " + rel(n.at) + " ago</span><br>" + esc(n.text) + "</li>").join("") + "</ul></dd>" : "") +
      "</dl></td></tr>";
    return html;
  }).join("") || '<tr><td colspan="6" class="empty">No tasks on the board yet.</td></tr>';
}

// Conversations: each message with the replies to it nested underneath, newest activity first.
let convoWho = null, convoLimit = 20;
function messages(d) {
  const missingFor = (m) => { const want = m.to[0] === "all" ? d.agents.map((a) => a.name).filter((n) => n !== m.from) : m.to; return want.filter((n) => !m.repliedBy.includes(n)); };
  const byId = new Map(d.messages.map((m) => [m.id, m]));
  const threads = new Map();
  for (const m of [...d.messages].reverse()) {
    let root = m.id; // follow reply-to-a-reply chains back to the message that started it
    for (let r = m, hops = 0; r.replyTo && byId.has(r.replyTo) && hops < 50; hops++) root = (r = byId.get(r.replyTo)).id;
    if (!threads.has(root)) threads.set(root, { root: byId.get(root) || m, replies: [], lastAt: m.at, people: new Set() });
    const t = threads.get(root);
    if (m.id !== root) t.replies.push(m);
    t.lastAt = m.at > t.lastAt ? m.at : t.lastAt;
    t.people.add(m.from); m.to.forEach((n) => t.people.add(n));
  }
  let list = [...threads.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  const names = [...new Set(d.messages.flatMap((m) => [m.from, ...m.to]))].filter((n) => n !== "all");
  if (convoWho) list = list.filter((t) => t.people.has(convoWho) || t.people.has("all"));
  const waiting = d.messages.filter((m) => m.needsReply && !m.replyTo && missingFor(m).length).length;
  $("msgNote").textContent = threads.size + " conversations · " + d.messages.length + " messages · " + waiting + " awaiting a reply";
  $("convoWho").innerHTML = '<button class="chip cap" data-w="" aria-pressed="' + !convoWho + '">everyone</button>' + names.map((n) => '<button class="chip mono" data-w="' + esc(n) + '" aria-pressed="' + (convoWho === n) + '"><span class="sw" style="background:' + colorOf(n) + '"></span>' + esc(n) + "</button>").join("");
  const bubble = (m, reply) => {
    let tag;
    if (reply) tag = '<span class="tag re">reply to #' + m.replyTo + "</span>";
    else if (!m.needsReply) tag = '<span class="tag fyi">notice</span>';
    else { const missing = missingFor(m); tag = missing.length ? '<span class="tag await">awaiting ' + esc(missing.join(", ")) + "</span>" : '<span class="tag ok">answered</span>'; }
    return '<div class="msg' + (reply ? " reply" : "") + (openMsgs.has(m.id) ? " open" : "") + '" data-m="' + m.id + '"><div class="h"><span class="num tiny">#' + m.id + '</span> <b style="color:' + colorOf(m.from) + '">' + esc(m.from) + "</b> → " + esc(m.to.join(", ")) + '</div><div class="tiny num">' + clock(m.at) + "</div>" + tag + '<div class="c">' + esc(m.content) + "</div></div>";
  };
  $("messages").innerHTML = list.slice(0, convoLimit).map((t) => '<div class="thread">' + bubble(t.root, false) + t.replies.map((r) => bubble(r, true)).join("") + "</div>").join("") +
    (list.length > convoLimit ? '<button class="btn cap" id="more" style="margin-top:12px">Show ' + Math.min(20, list.length - convoLimit) + " more of " + (list.length - convoLimit) + "</button>" : "") ||
    '<div class="empty">No conversations yet.</div>';
}

function wire(d) {
  const names = [...new Set(d.activity.map((e) => e.by))];
  $("kinds").innerHTML = Object.keys(KINDS).map((k) => '<button class="chip cap" data-k="' + k + '" aria-pressed="' + (kind === k) + '">' + k + "</button>").join("");
  $("people").innerHTML = names.map((n) => '<button class="chip mono" data-p="' + esc(n) + '" aria-pressed="' + people.has(n) + '"><span class="sw" style="background:' + colorOf(n) + '"></span>' + esc(n) + "</button>").join("");
  $("kinds").onclick = (e) => { const k = e.target.closest("[data-k]"); if (k) { kind = k.dataset.k; wire(last); } };
  $("people").onclick = (e) => { const p = e.target.closest("[data-p]"); if (p) { people.has(p.dataset.p) ? people.delete(p.dataset.p) : people.add(p.dataset.p); wire(last); } };
  const list = d.activity.filter((e) => KINDS[kind](e.type) && (!people.size || people.has(e.by)));
  $("wireNote").textContent = list.length + " of " + d.activity.length + " events · " + d.seq.event + " total";
  $("wire").innerHTML = list.map((e) => { const fresh = !first && !seen.has(e.id); return '<li' + (fresh ? ' class="fresh"' : "") + '><time>' + clock(e.at) + '</time><span class="g">' + (GLYPH[e.type] || "·") + '</span><span><span class="by" style="color:' + colorOf(e.by) + '">' + esc(e.by) + "</span> " + esc(e.text.startsWith(e.by + " ") ? e.text.slice(e.by.length + 1) : e.text) + "</span></li>"; }).join("") || '<li><span></span><span></span><span class="empty">Nothing yet.</span></li>';
  for (const e of d.activity) seen.add(e.id);
}

function side(d) {
  $("lockNote").textContent = d.locks.length ? d.locks.length + " held" : "";
  $("locks").innerHTML = d.locks.map((l) => '<div class="lock"><code>' + esc(l.path) + '</code><div class="tiny"><span class="sw" style="background:' + colorOf(l.by) + '"></span>' + esc(l.by) + (l.taskId ? " · for #" + l.taskId : "") + " · held " + rel(l.at) + "</div></div>").join("") || '<div class="empty">No files locked.</div>';
  $("notes").innerHTML = d.notes.map((n) => '<details class="note"><summary>' + esc(n.key) + ' <span class="tiny">· ' + esc(n.by) + " · " + rel(n.at) + " ago</span></summary><pre>" + esc(n.value) + "</pre></details>").join("") || '<div class="empty">No shared notes.</div>';
  const s = d.system, up = s.update;
  const rows = [
    ["board revision", d.rev], ["events / messages / tasks", d.seq.event + " / " + d.seq.message + " / " + d.seq.task],
    ["archived rounds", d.archivedRounds], ["agents waiting in a call", d.agents.filter((a) => a.waitingUntil).length],
    ["replies owed", d.agents.reduce((n, a) => n + a.owes.length, 0)], ["unread messages", d.agents.reduce((n, a) => n + a.unread, 0)],
    ["swarm-mcp", up ? (up.behind ? up.behind + " update(s) available" : "up to date") + " · checked " + rel(up.checkedAt) + " ago" : "not checked yet"],
  ];
  $("engine").innerHTML = rows.map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>").join("");
  const hooks = Object.entries(s.hooks || {});
  const hookHtml = '<div class="cap" style="margin:8px 0 2px">Hooks actually running</div><dl class="kv">' +
    (hooks.length ? hooks.map(([app, h]) => "<dt>" + esc(app) + "</dt><dd>" + Object.keys(h.kinds).join(", ") + " · " + rel(h.lastAt) + " ago" + (h.hasSession ? "" : " · no conversation id!") + "</dd>").join("") : "<dt>none yet</dt><dd>no app has run a swarm hook</dd>") +
    '</dl><div class="tiny" style="margin-bottom:8px">An app missing here doesn\'t run the hooks: its busy agents only get messages at their next swarm call.</div>';
  const clients = Object.entries(s.clients);
  $("clients").innerHTML = hookHtml + (clients.length ? '<div class="cap" style="margin:8px 0 2px">Learned wait per app</div><dl class="kv">' + clients.map(([name, c]) => "<dt>" + esc(name) + "</dt><dd>" + (c.normal || 45) + "s" + (c.limit ? " · cap " + c.limit + "s" : "") + (c.lastCancel ? " · cancelled at " + c.lastCancel + "s" : "") + "</dd>").join("") + "</dl>" : "");
}

loadBoards(); load();
setInterval(load, 2000); setInterval(loadBoards, 15000);
setInterval(() => { if (last && !paused) { $("updated").textContent = "last activity " + rel(last.updatedAt) + " ago · refreshed " + clock(last.system.serverTime); } }, 1000);
</script>
</body>
</html>`;
