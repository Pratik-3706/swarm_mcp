// Checks the board features: per-project boards and new rounds, progress heartbeats, auto-return of
// stalled tasks, changed-file tracking, swarm_report, the dashboard link and the dashboard itself.
// Timers are shortened to seconds; the dashboard runs on a test port.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-"));
const project = path.join(home, "project");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 56499;
// 0.05 min = 3 s: a task holder silent that long loses its task, and progress is due that often.
const env = {
  ...process.env,
  SWARM_MCP_HOME: path.join(home, ".swarm-home"),
  SWARM_REASSIGN_MINUTES: "0.05",
  SWARM_HEARTBEAT_MINUTES: "0.05",
  SWARM_NO_UPDATE_CHECK: "1",
  SWARM_NO_DASHBOARD: "1",
  SWARM_DASHBOARD_PORT: String(PORT),
};

async function agent(name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: home }));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const out = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${name}.${tool}: ${out}`);
    return out;
  };
  return { client, call };
}

// A small git project, with one file already modified before any task starts.
fs.mkdirSync(project, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", project, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
fs.writeFileSync(path.join(project, "app.js"), "console.log(1);\n");
fs.writeFileSync(path.join(project, "old.js"), "old\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "init");
fs.writeFileSync(path.join(project, "old.js"), "changed before the task\n");
await sleep(1200);

const [mgr, w1, w2] = await Promise.all([agent("manager"), agent("w1"), agent("w2")]);
try {
  // --- per-project boards ---
  const joined = await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v1", project });
  assert.match(joined, /Board: .*project[\\/]\.swarm[\\/]default\.json/);
  assert.match(joined, new RegExp(`LIVE DASHBOARD: http://127\\.0\\.0\\.1:${PORT}/\\?project=[\\s\\S]*Give the user this link in your first reply`));
  assert.match(await mgr.call("swarm_dashboard"), new RegExp(`^Live dashboard: http://127\\.0\\.0\\.1:${PORT}/\\?project=`));
  // The board lives in <project>/.swarm, created on first use and ignored by git.
  const boardFile = path.join(project, ".swarm", "default.json");
  assert.ok(fs.existsSync(boardFile));
  assert.equal(fs.readFileSync(path.join(project, ".swarm", ".gitignore"), "utf8").trim(), "*");
  assert.equal(git("status", "--porcelain", "--", ".swarm").trim(), "", "the board shows up in git");

  assert.match(await w1.call("swarm_join", { name: "w1", role: "worker", project }), /Project folder: .*project\. Do all your work inside it/);
  // A worker in another folder lands on that folder's empty board and is pointed at the live one...
  fs.mkdirSync(path.join(home, "elsewhere"));
  assert.match(await w2.call("swarm_join", { name: "w2", role: "worker", project: path.join(home, "elsewhere") }), /Nobody else is on this project's board yet[\s\S]*Recently active swarm boards: .*project/);
  // ...and a subfolder of the project finds the project's board.
  fs.mkdirSync(path.join(project, "src"));
  assert.match(await w2.call("swarm_join", { name: "w2", role: "worker", project: path.join(project, "src") }), /Board: .*project[\\/]\.swarm[\\/]default\.json/);

  // --- changed files and progress ---
  await mgr.call("task_create", { tasks: [{ title: "Edit app", assignee: "w1" }, { title: "Docs", assignee: "w2" }, { title: "Later" }] });
  await mgr.call("note_set", { key: "conventions", value: "round 1 rules" });
  assert.match(await w1.call("task_claim", { wait_seconds: 0 }), /You claimed task #1[\s\S]*Project folder: .*project[\s\S]*post progress: task_update/);
  fs.writeFileSync(path.join(project, "app.js"), "console.log(2);\n");
  fs.writeFileSync(path.join(project, "new.js"), "new\n");
  assert.match(await w1.call("task_update", { task_id: 1, progress: 60, eta: "5 min", note: "half way" }), /\[in_progress 60%, eta 5 min\]/);
  const done = await w1.call("task_update", { task_id: 1, status: "done", result: "Edited app" });
  assert.match(done, /files changed: app\.js, new\.js/);
  assert.doesNotMatch(done, /old\.js/, "a file changed before the task was attributed to it");

  // --- progress heartbeat ---
  await w2.call("task_claim", { wait_seconds: 0 });
  await sleep(1500);
  await w2.call("task_update", { task_id: 2, progress: 10 }); // fresh progress: no reminder yet
  await sleep(3500);
  assert.match(await w2.call("note_get"), /PROGRESS CHECK: no update on #2 "Docs"/);
  assert.doesNotMatch(await w2.call("note_get"), /PROGRESS CHECK/, "reminded twice in one period");

  // --- auto-return: w2 goes silent while holding #2 ---
  await sleep(3500);
  assert.match(await mgr.call("swarm_status"), /#2 \[todo\] Docs \(unassigned\)/, "silent agent's task was not returned");
  assert.match(await mgr.call("task_list", { task_id: 2 }), /Returned to the board: w2 was silent/);
  assert.match(await w2.call("swarm_inbox", { wait_seconds: 0 }), /#2 "Docs" went back on the board because you were silent/);

  // --- report ---
  const report = await mgr.call("swarm_report");
  assert.match(report, /^Goal: Build v1 \(in .*project\)/);
  assert.match(report, /Progress: about \d+% overall\. 1 of 3 tasks done/);
  assert.match(report, /Recently finished:\n- #1 "Edit app" by w1: Edited app \[2 files\]/);
  assert.match(report, /Up next:\n- #2 "Docs" \(open to any worker\)/);

  // --- new rounds on the same board ---
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v2", project }), /WARNING: the board still has 2 open task\(s\) from the previous goal "Build v1"[\s\S]*new_round=true/);
  assert.match(await mgr.call("swarm_status"), /#3 \[todo\] Later/);
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v2", project, new_round: true }), /Started a fresh round[\s\S]*Closed 2 open task\(s\) and archived 1 note/);
  assert.match(await w1.call("task_claim", { wait_seconds: 0 }), /No task for you yet/);
  assert.match(await w1.call("note_get"), /No shared notes yet/);

  // --- another project has its own board; the first is left as it was ---
  const other = path.join(home, "other");
  fs.mkdirSync(other);
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Other app", project: other }), /Board: .*other[\\/]\.swarm[\\/]default\.json/);
  assert.match(fs.readFileSync(boardFile, "utf8"), /"goal": "Build v2"/);
  await mgr.call("message_send", { to: "nobody-yet", content: "hello" });

  // --- a board from before project boards: it moves into its project, and everyone meets there ---
  process.env.SWARM_MCP_HOME = env.SWARM_MCP_HOME;
  const { SwarmStore } = await import("../src/store.js");
  const legacyProject = path.join(home, "legacy-proj");
  fs.mkdirSync(legacyProject);
  const at = new Date().toISOString();
  await new SwarmStore("legacy").update((s) => {
    s.goal = "Furina site";
    s.project = legacyProject.split(path.sep).join("/");
    s.seq.task = 1;
    s.tasks.push({ id: 1, title: "Old work", status: "in_progress", assignee: "ant", dependsOn: [], notes: [], priority: "normal", createdBy: "boss", createdAt: at, updatedAt: at, claimedAt: at, progressAt: at });
    s.agents.ant = { name: "ant", role: "worker", client: "Antigravity", joinedAt: at, lastSeen: at, status: "online", msgCursor: 0, eventCursor: 0 };
  });
  // The manager's app reports the project folder: the old board comes along instead of a blank one.
  const moved = await mgr.call("swarm_join", { name: "boss", role: "manager", swarm: "legacy", project: legacyProject });
  assert.match(moved, /Board: .*legacy-proj[\\/]\.swarm[\\/]legacy\.json/);
  assert.match(moved, /#1 \[in_progress\] Old work @ant/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.SWARM_MCP_HOME, "legacy.json"), "utf8")).movedTo, legacyProject.split(path.sep).join("/"));
  // A worker whose app doesn't say where it is follows the global board's pointer to the same board.
  assert.match(await w1.call("swarm_join", { name: "ant", role: "worker", swarm: "legacy" }), /Board: .*legacy-proj[\\/]\.swarm[\\/]legacy\.json[\s\S]*You have #1 in progress/);
  await w1.call("message_send", { to: "boss", content: "Old work is in review" });
  assert.match(await mgr.call("swarm_inbox", { wait_seconds: 0 }), /ant -> boss: Old work is in review/);

  // --- dashboard ---
  const dash = spawn(process.execPath, [entry, "dashboard", "--no-open"], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      dash.stdout.on("data", (d) => /Swarm dashboard: /.test(d) && resolve());
      dash.on("exit", () => reject(new Error("dashboard exited")));
      setTimeout(() => reject(new Error("dashboard did not start")), 8000);
    });
    const base = `http://127.0.0.1:${PORT}`;
    const api = await (await fetch(`${base}/api?project=${encodeURIComponent(other)}`)).json();
    assert.equal(api.goal, "Other app");
    assert.match(api.system.board, /other[\\/]\.swarm[\\/]default\.json$/);
    assert.ok(api.agents.some((a) => a.name === "boss" && a.presence));
    assert.ok(api.messages.some((m) => m.content === "hello" && m.needsReply && m.to[0] === "nobody-yet"));
    assert.ok(api.activity.some((e) => e.type === "join" && e.by === "boss"));
    const first = await (await fetch(`${base}/api?project=${encodeURIComponent(project)}`)).json();
    assert.ok(first.tasks.some((t) => t.title === "Edit app" && t.files.includes("app.js") && t.notes.length));
    const boards = await (await fetch(`${base}/api/boards`)).json();
    assert.ok(boards.some((b) => b.project?.endsWith("/other")) && boards.some((b) => b.project?.endsWith("/project")));
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /<title>Swarm · dispatch<\/title>/);
    // A second start finds the running one instead of failing on the port.
    const again = execFileSync(process.execPath, [entry, "dashboard", "--no-open"], { env, cwd: home, encoding: "utf8" });
    assert.match(again, /already running: http:\/\/127\.0\.0\.1:56499\//);
  } finally {
    dash.kill();
  }
  console.log("board test passed");
} finally {
  await Promise.all([mgr, w1, w2].map((a) => a.client.close()));
  fs.rmSync(home, { recursive: true, force: true });
}
