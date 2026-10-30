// Checks the board features: project binding and new rounds, progress heartbeats, auto-return of
// stalled tasks, changed-file tracking, swarm_report and the dashboard. Timers are shortened to seconds.

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
// 0.05 min = 3 s: a task holder silent that long loses its task, and progress is due that often.
const env = { ...process.env, SWARM_MCP_HOME: path.join(home, ".swarm"), SWARM_REASSIGN_MINUTES: "0.05", SWARM_HEARTBEAT_MINUTES: "0.05", SWARM_NO_UPDATE_CHECK: "1" };

async function agent(name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
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
  // --- project binding ---
  await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v1", project });
  assert.match(await w1.call("swarm_join", { name: "w1", role: "worker", project }), /Project folder: .*project\. Do all your work inside it/);
  assert.match(await w2.call("swarm_join", { name: "w2", role: "worker", project: path.join(home, "elsewhere") }), /WARNING: this swarm's project folder is .*project, but you are in .*elsewhere/);

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
  const status = await mgr.call("swarm_status");
  assert.match(status, /#2 \[todo\] Docs \(unassigned\)/, "silent agent's task was not returned");
  assert.match(await mgr.call("task_list", { task_id: 2 }), /Returned to the board: w2 was silent/);
  assert.match(await w2.call("swarm_inbox", { wait_seconds: 0 }), /#2 "Docs" went back on the board because you were silent/);

  // --- report ---
  const report = await mgr.call("swarm_report");
  assert.match(report, /^Goal: Build v1 \(in .*project\)/);
  assert.match(report, /Progress: about \d+% overall\. 1 of 3 tasks done/);
  assert.match(report, /Recently finished:\n- #1 "Edit app" by w1: Edited app \[2 files\]/);
  assert.match(report, /Up next:\n- #2 "Docs" \(open to any worker\)/);

  // --- new rounds ---
  // Different wording, same project: only a warning, nothing closed.
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v2", project }), /WARNING: the board still has 2 open task\(s\) from the previous goal "Build v1"[\s\S]*new_round=true/);
  assert.match(await mgr.call("swarm_status"), /#3 \[todo\] Later/);
  // new_round closes the old tasks and archives the old notes, so workers don't pick them up.
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Build v2", project, new_round: true }), /Started a fresh round[\s\S]*Closed 2 open task\(s\) and archived 1 note/);
  assert.match(await w1.call("task_claim", { wait_seconds: 0 }), /No task for you yet/);
  assert.match(await w1.call("note_get"), /No shared notes yet/);
  // Another project folder starts a fresh round by itself.
  await mgr.call("task_create", { tasks: [{ title: "v2 work" }] });
  assert.match(await mgr.call("swarm_join", { name: "boss", role: "manager", goal: "Other app", project: path.join(home, "other") }), /Started a fresh round for this goal \(different project folder\)/);

  // --- dashboard ---
  const dash = spawn(process.execPath, [entry, "dashboard", "--no-open", "--port", "4890"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      dash.stdout.on("data", (d) => /Swarm dashboard: /.test(d) && resolve());
      dash.on("exit", () => reject(new Error("dashboard exited")));
      setTimeout(() => reject(new Error("dashboard did not start")), 8000);
    });
    const port = JSON.parse(fs.readFileSync(path.join(env.SWARM_MCP_HOME, "dashboard.json"), "utf8")).port;
    const api = await (await fetch(`http://127.0.0.1:${port}/api`)).json();
    assert.equal(api.goal, "Other app");
    assert.ok(api.agents.some((a) => a.name === "w1") && typeof api.totals.percent === "number" && Array.isArray(api.activity));
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /<title>Swarm dashboard<\/title>/);
  } finally {
    dash.kill();
  }
  console.log("board test passed");
} finally {
  await Promise.all([mgr, w1, w2].map((a) => a.client.close()));
  fs.rmSync(home, { recursive: true, force: true });
}
