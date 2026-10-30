// Live dashboard: a page on the user's own computer (127.0.0.1 only) showing the board as it changes.
//
//   swarm-mcp dashboard [--port 4777] [--swarm default] [--no-open]
//
// Agents can open it for the user with swarm_report(dashboard=true), which starts it in the background.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SwarmStore, listSwarms, swarmHome } from "./store.js";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const infoFile = () => path.join(swarmHome(), "dashboard.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // no browser to open; the address is printed anyway
  }
}

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startDashboard({ port = 4777, swarm = "default", open = true } = {}) {
  const { snapshot } = await import("./server.js"); // lazy: server.js imports this module too
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname === "/api/health") return send(res, 200, "application/json", '{"ok":true}');
      if (url.pathname === "/api") {
        const name = url.searchParams.get("swarm") || swarm;
        const state = await new SwarmStore(name).view();
        return send(res, 200, "application/json", JSON.stringify({ ...snapshot(state), swarms: listSwarms(), now: new Date().toISOString() }));
      }
      if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      send(res, 404, "text/plain", "Not found");
    } catch (err) {
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
  });
  for (let p = port; p < port + 20; p++) {
    if (await alive(p)) {
      // Already running (maybe another agent started it): just show it.
      const url = `http://127.0.0.1:${p}/?swarm=${encodeURIComponent(swarm)}`;
      console.log(`Dashboard already running: ${url}`);
      if (open) openBrowser(url);
      return null;
    }
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    const url = `http://127.0.0.1:${p}/?swarm=${encodeURIComponent(swarm)}`;
    fs.mkdirSync(swarmHome(), { recursive: true });
    fs.writeFileSync(infoFile(), JSON.stringify({ port: p, pid: process.pid, startedAt: new Date().toISOString() }));
    console.log(`Swarm dashboard: ${url}\n(Ctrl+C to stop)`);
    if (open) openBrowser(url);
    return server;
  }
  throw new Error(`No free port between ${port} and ${port + 19}`);
}

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** For swarm_report(dashboard=true): reuse a running dashboard or start one in the background; returns its address. */
export async function ensureDashboard(swarm) {
  try {
    const info = JSON.parse(fs.readFileSync(infoFile(), "utf8"));
    if (await alive(info.port)) {
      const url = `http://127.0.0.1:${info.port}/?swarm=${encodeURIComponent(swarm)}`;
      openBrowser(url);
      return url;
    }
  } catch {
    // not running yet
  }
  const before = fs.existsSync(infoFile()) ? fs.statSync(infoFile()).mtimeMs : 0;
  spawn(process.execPath, [ENTRY, "dashboard", "--swarm", swarm], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try {
      if (fs.statSync(infoFile()).mtimeMs > before) {
        const { port } = JSON.parse(fs.readFileSync(infoFile(), "utf8"));
        return `http://127.0.0.1:${port}/?swarm=${encodeURIComponent(swarm)}`;
      }
    } catch {
      // not written yet
    }
  }
  return null;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm dashboard</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2128; --muted:#636c76; --line:#e2e5e9; --accent:#2f6feb; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --track:#eaeef2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --card:#161b22; --text:#e6edf3; --muted:#8d96a0; --line:#2a313a; --accent:#4c8dff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --track:#21262d; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:20px 16px 40px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; justify-content:space-between; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 10px; }
  .muted { color:var(--muted); } .small { font-size:12px; }
  .grid { display:grid; gap:12px; } .cols { grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); }
  .two { grid-template-columns: minmax(0,2fr) minmax(0,1fr); } @media (max-width:860px){ .two { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; min-width:0; }
  .stat b { display:block; font-size:24px; } .bar { height:8px; background:var(--track); border-radius:99px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--accent); border-radius:99px; transition:width .4s; }
  .big .bar { height:12px; } .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid var(--line); white-space:nowrap; }
  .s-done { color:var(--ok); border-color:var(--ok); } .s-in_progress { color:var(--accent); border-color:var(--accent); } .s-review { color:var(--warn); border-color:var(--warn); }
  .s-blocked { color:var(--bad); border-color:var(--bad); } .s-cancelled { color:var(--muted); text-decoration:line-through; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:7px 6px; border-top:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; border-top:none; } td.n { width:44px; color:var(--muted); }
  .agent { display:flex; flex-direction:column; gap:6px; } .agent .top { display:flex; justify-content:space-between; gap:8px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:var(--muted); vertical-align:middle; }
  .dot.ok { background:var(--ok); } .dot.work { background:var(--accent); } .dot.warn { background:var(--warn); } .dot.bad { background:var(--bad); }
  ul { margin:0; padding-left:18px; } li { margin:3px 0; } .alert li { color:var(--warn); } .feed li { list-style:none; margin-left:-18px; }
  select { background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:4px 6px; }
  .wrap { overflow-x:auto; } .err { color:var(--bad); }
</style>
</head>
<body>
<main>
  <header>
    <div><h1 id="goal">Swarm dashboard</h1><div class="muted small" id="meta"></div></div>
    <div class="small muted"><label>Swarm <select id="swarm"></select></label> · <span id="updated"></span></div>
  </header>
  <div class="card big" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between"><b>Overall progress</b><b id="pct">0%</b></div><div class="bar" style="margin-top:8px"><i id="pctbar" style="width:0"></i></div></div>
  <div class="grid cols" id="stats" style="margin-bottom:12px"></div>
  <div class="grid two">
    <div class="grid">
      <div class="card"><h2>Tasks</h2><div class="wrap"><table><thead><tr><th>#</th><th>Task</th><th>Status</th><th>Who</th><th style="width:130px">Progress</th></tr></thead><tbody id="tasks"></tbody></table></div></div>
      <div class="card"><h2>Activity</h2><ul class="feed small" id="activity"></ul></div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card" id="alertsCard" hidden><h2>Needs attention</h2><ul class="alert" id="alerts"></ul></div>
      <div class="card"><h2>Agents</h2><div class="grid" id="agents"></div></div>
      <div class="card"><h2>File locks</h2><ul class="small" id="locks"></ul></div>
    </div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (iso) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
const bar = (p) => '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, p || 0)) + '%"></i></div>';
const dot = (state) => /offline/.test(state) ? "bad" : /stuck|stopped/.test(state) ? "warn" : /working/.test(state) ? "work" : "ok";
let swarm = new URLSearchParams(location.search).get("swarm") || "default";
$("swarm").onchange = (e) => { swarm = e.target.value; history.replaceState(null, "", "?swarm=" + encodeURIComponent(swarm)); load(); };

async function load() {
  let d;
  try { d = await (await fetch("/api?swarm=" + encodeURIComponent(swarm), { cache: "no-store" })).json(); }
  catch { $("updated").innerHTML = '<span class="err">dashboard server stopped</span>'; return; }
  if (d.error) { $("updated").innerHTML = '<span class="err">' + esc(d.error) + "</span>"; return; }
  document.title = (d.totals.percent) + "% · " + (d.goal || "Swarm dashboard");
  $("goal").textContent = d.goal || "No goal set yet";
  $("meta").innerHTML = [d.project && "Project: " + esc(d.project), "Round " + d.round, d.finished && '<span class="pill s-done">finished</span>'].filter(Boolean).join(" · ");
  $("updated").textContent = "last activity " + ago(d.updatedAt);
  $("swarm").innerHTML = (d.swarms.includes(swarm) ? d.swarms : [swarm, ...d.swarms]).map((s) => '<option' + (s === swarm ? " selected" : "") + ">" + esc(s) + "</option>").join("");
  $("pct").textContent = d.totals.percent + "%"; $("pctbar").style.width = d.totals.percent + "%";
  const t = d.totals, active = d.agents.filter((a) => !/offline|stopped/.test(a.state)).length;
  $("stats").innerHTML = [["Done", t.done + " / " + t.tasks], ["In progress", t.inProgress], ["In review", t.review], ["Not started", t.todo], ["Blocked", t.blocked], ["Agents active", active + " / " + d.agents.length]]
    .map(([k, v]) => '<div class="card stat"><span class="muted small">' + k + "</span><b>" + v + "</b></div>").join("");
  $("tasks").innerHTML = d.tasks.filter((x) => x.status !== "cancelled").map((x) =>
    "<tr><td class=n>#" + x.id + "</td><td>" + esc(x.title) + (x.waitingOnDeps ? ' <span class="muted small">(waiting on ' + x.dependsOn.map((n) => "#" + n).join(", ") + ")</span>" : "") +
    (x.files.length ? '<div class="muted small">' + x.files.length + " file" + (x.files.length > 1 ? "s" : "") + ": " + esc(x.files.slice(0, 4).join(", ")) + (x.files.length > 4 ? "…" : "") + "</div>" : "") +
    "</td><td><span class=\\"pill s-" + x.status + "\\">" + x.status.replace("_", " ") + "</span></td><td>" + esc(x.assignee || "—") +
    "</td><td>" + bar(x.progress) + '<div class="muted small">' + x.progress + "%" + (x.eta ? " · " + esc(x.eta) + " left" : "") + "</div></td></tr>").join("") ||
    '<tr><td colspan=5 class="muted">No tasks yet.</td></tr>';
  $("agents").innerHTML = d.agents.map((a) =>
    '<div class="agent"><div class="top"><b><span class="dot ' + dot(a.state) + '"></span>' + esc(a.name) + '</b><span class="muted small">' + esc(a.role) + (a.client ? " · " + esc(a.client) : "") + "</span></div>" +
    '<div class="small">' + esc(a.state) + "</div>" + (a.task ? bar(a.task.progress) + '<div class="muted small">#' + a.task.id + " " + esc(a.task.title) + " · " + a.task.progress + "%" + (a.task.eta ? " · " + esc(a.task.eta) + " left" : "") + "</div>" : "") +
    (a.owes.length ? '<div class="small" style="color:var(--warn)">owes a reply to ' + a.owes.map((n) => "#" + n).join(", ") + "</div>" : "") + "</div>").join("") || '<span class="muted">Nobody has joined yet.</span>';
  $("alertsCard").hidden = !d.alerts.length; $("alerts").innerHTML = d.alerts.map((x) => "<li>" + esc(x) + "</li>").join("");
  $("locks").innerHTML = d.locks.map((l) => "<li><code>" + esc(l.path) + "</code> · " + esc(l.by) + (l.taskId ? " (#" + l.taskId + ")" : "") + "</li>").join("") || '<li class="muted">None</li>';
  $("activity").innerHTML = d.activity.map((e) => '<li><span class="muted">' + new Date(e.at).toLocaleTimeString() + "</span> " + esc(e.text) + "</li>").join("") || '<li class="muted">Nothing yet.</li>';
}
load(); setInterval(load, 2000);
</script>
</body>
</html>`;
