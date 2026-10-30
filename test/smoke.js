// End-to-end check: three separate server processes (like three different agents)
// share one swarm through the on-disk store.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function agent(name) {
  const client = new Client({ name, version: "1.0.0" });
  // SWARM_IDLE_SECONDS=2 so "this agent has stopped" shows up without waiting 90s.
  const env = { ...process.env, SWARM_MCP_HOME: home, SWARM_IDLE_SECONDS: "2", SWARM_NO_UPDATE_CHECK: "1" };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const out = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${name}.${tool}: ${out}`);
    return out;
  };
  return { client, call };
}

const [mgr, codex, agy] = await Promise.all([agent("manager"), agent("codex"), agent("antigravity")]);

try {
  const tools = (await mgr.client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  const prompts = (await mgr.client.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ["manager", "reviewer", "worker"]);

  await assert.rejects(codex.call("task_claim"), /swarm_join first/);

  await mgr.call("swarm_join", { name: "manager", role: "manager", goal: "Build a todo app" });
  assert.match(await codex.call("swarm_join", { name: "codex", role: "worker", client: "Codex" }), /Next: call task_claim now/);
  await agy.call("swarm_join", { name: "antigravity", role: "worker", client: "Antigravity" });

  const created = await mgr.call("task_create", {
    tasks: [
      { title: "API", description: "REST endpoints", priority: "high" },
      { title: "UI", description: "React frontend" },
      { title: "E2E tests", depends_on: ["$1", "$2"], assignee: "antigravity" },
    ],
  });
  assert.match(created, /#3 \[todo\] E2E tests @antigravity deps:#1,#2/);
  await mgr.call("note_set", { key: "api-contract", value: "GET /todos returns [{id,title,done}]" });

  // Both workers claim at the same moment: they must get different tasks.
  const [c1, c2] = await Promise.all([codex.call("task_claim"), agy.call("task_claim")]);
  const id1 = c1.match(/#(\d+)/)[1];
  const id2 = c2.match(/#(\d+)/)[1];
  assert.notEqual(id1, id2, "two agents claimed the same task");
  assert.ok(!["3"].includes(id1) && !["3"].includes(id2), "task with unmet deps was claimed");
  console.log(`concurrent claims: codex -> #${id1}, antigravity -> #${id2}`);

  // One task at a time: claiming again returns the task you already hold.
  assert.match(await codex.call("task_claim", { wait_seconds: 0 }), new RegExp(`already have #${id1} in progress`));

  await codex.call("file_lock", { action: "lock", paths: ["src/api"], task_id: Number(id1) });
  assert.match(
    await agy.call("file_lock", { action: "lock", paths: ["src/api/routes.js"], wait_seconds: 0 }),
    /Still locked: src\/api \(held by codex\)\. Call file_lock again/,
  );

  // Manager waits for activity while a worker messages them.
  await mgr.call("swarm_inbox", { wait_seconds: 0 }); // drain earlier join/claim activity
  const waiting = mgr.call("swarm_inbox", { wait_seconds: 10 });
  await codex.call("message_send", { to: "manager", content: "Should todos have due dates?" });
  const inbox = await waiting;
  assert.match(inbox, /codex -> manager: Should todos have due dates\?[\s\S]*Reply before you do anything else/);
  // Until it replies, the manager's acting tools are refused; replying unblocks it, and replies need no answer.
  await assert.rejects(mgr.call("task_create", { tasks: [{ title: "x" }] }), /unanswered swarm message[\s\S]*#1 from codex\] Should todos/);
  assert.match(await mgr.call("message_send", { reply_to: 1, content: "No due dates for v1." }), /Replied to #1 .*You're unblocked/);
  const answer = await codex.call("swarm_inbox", { wait_seconds: 0 });
  assert.match(answer, /manager -> codex: No due dates for v1/);
  assert.doesNotMatch(answer, /Reply before you do anything else/, "a reply should not need a reply");

  // antigravity waits for codex's lock; finishing the task releases it and antigravity gets it.
  const pendingLock = agy.call("file_lock", { action: "lock", paths: ["src/api/routes.js"] });
  await sleep(1200);
  const done1 = await codex.call("task_update", { task_id: Number(id1), status: "done", result: "Added /todos endpoints" });
  assert.match(done1, /Next: call task_claim/);
  assert.match(await pendingLock, /Locked: src\/api\/routes\.js/);
  assert.doesNotMatch(await codex.call("file_lock", { action: "list" }), /— codex/, "task lock not released on done");
  const done2 = await agy.call("task_update", { task_id: Number(id2), status: "done", result: "UI done" });
  assert.match(done2, /Unblocked: #3/);
  assert.match(await agy.call("task_claim"), /You claimed task #3[\s\S]*E2E tests[\s\S]*Results of dependencies/);

  assert.match(await agy.call("note_get", { key: "api-contract" }), /GET \/todos/);
  const status = await mgr.call("swarm_status");
  assert.match(status, /antigravity — worker via Antigravity, working on #3/);
  console.log(`\n${status}\n`);

  // A worker with nothing to do waits inside task_claim and gets the next task as soon as it's posted.
  const t0 = Date.now();
  const pendingClaim = codex.call("task_claim", { wait_seconds: 20 });
  await sleep(1500);
  assert.match(await mgr.call("swarm_status"), /codex — worker via Codex, waiting for work/);
  await mgr.call("task_create", { tasks: [{ title: "Late task", assignee: "codex" }] });
  const late = await pendingClaim;
  assert.match(late, /You claimed task #4\. Start working on it now\./);
  assert.match(late, /don't ask the user for approval/);
  assert.ok(Date.now() - t0 < 6000, "waiting claim did not wake up promptly");
  console.log(`late task reached the waiting worker after ${Date.now() - t0}ms`);
  await codex.call("task_update", { task_id: 4, status: "done", result: "ok" });

  // A message wakes a waiting worker too.
  const pendingMsg = codex.call("task_claim", { wait_seconds: 20 });
  await sleep(1000);
  await mgr.call("message_send", { to: "codex", content: "Hold on, new plan coming" });
  const woke = await pendingMsg;
  assert.match(woke, /unanswered swarm message[\s\S]*Hold on, new plan coming/);
  const holdId = Number(/#(\d+) from manager\] Hold on/.exec(woke)[1]);
  assert.match(await mgr.call("swarm_status"), new RegExp(`codex — worker via Codex, .*owes a reply to #${holdId}`));
  await codex.call("message_send", { reply_to: holdId, content: "OK, standing by for it" });

  // A busy agent gets new messages attached to whatever swarm call it makes next, once...
  await mgr.call("message_send", { to: "codex", content: "Use port 8080, not 3000" });
  const piggy = await codex.call("note_get", { key: "api-contract" });
  assert.match(piggy, /GET \/todos[\s\S]*NEW SWARM MESSAGE[\s\S]*\[msg #\d+ from manager\] Use port 8080, not 3000[\s\S]*You must reply/);
  assert.doesNotMatch(await codex.call("note_get", { key: "api-contract" }), /NEW SWARM MESSAGE/, "message delivered twice");
  // ...and can't claim or update anything until it answers.
  await assert.rejects(codex.call("task_claim", { wait_seconds: 0 }), /Reply before you do anything else[\s\S]*Use port 8080/);
  const portId = Number(/\[msg #(\d+) from manager\] Use port 8080/.exec(piggy)[1]);
  await codex.call("message_send", { reply_to: portId, content: "Switching to 8080" });
  // A notice sent with expect_reply=false blocks nobody.
  await mgr.call("message_send", { to: "codex", content: "FYI: CI is green", expect_reply: false });
  assert.match(await codex.call("task_claim", { wait_seconds: 0 }), /FYI: CI is green[\s\S]*No reply needed|No task for you yet/);

  // Only the manager may apply an update (checking needs the network, so it's tried by hand, not here).
  await assert.rejects(codex.call("swarm_update", { apply: true }), /Only the manager applies updates/);

  // A second manager gets told to join as a worker.
  assert.match(await codex.call("swarm_join", { name: "codex", role: "manager" }), /WARNING: manager is already the manager/);
  await codex.call("swarm_join", { name: "codex", role: "worker", client: "Codex" });

  // Waiting sends progress pings, and a call the client gives up on stops waiting.
  const pings = [];
  const quiet = await codex.client.callTool({ name: "task_claim", arguments: { wait_seconds: 6 } }, undefined, { onprogress: (p) => pings.push(p) });
  assert.match(quiet.content[0].text, /No task for you yet \(waited 6s\)\. Call task_claim again/);
  assert.ok(pings.length >= 1, "no progress notifications while waiting");
  await assert.rejects(codex.client.callTool({ name: "task_claim", arguments: { wait_seconds: 30 } }, undefined, { timeout: 1500 }));
  await sleep(2000);
  assert.doesNotMatch(await mgr.call("swarm_status"), /codex — worker via Codex, waiting for work/);
  // ...and the server learned from it: this client's next default wait stays under the cancel point.
  const learned = JSON.parse(fs.readFileSync(path.join(home, "clients.json"), "utf8")).codex;
  assert.ok(learned.lastCancel <= 3 && learned.normal === 5, `cancel not learned: ${JSON.stringify(learned)}`);

  // A client that drops a call without saying so (silent timeout) and calls again: the old wait lets go.
  const t1 = Date.now();
  const abandoned = codex.call("task_claim", { wait_seconds: 20 });
  await sleep(1500);
  const retry = codex.call("task_claim", { wait_seconds: 3 });
  assert.match(await abandoned, /No task for you yet/);
  assert.ok(Date.now() - t1 < 4000, "superseded wait kept running");
  await retry;

  // The manager is told when work sits with an agent that stopped.
  await agy.call("task_update", { task_id: 3, status: "done", result: "tests pass" });
  await sleep(2500); // antigravity goes quiet, as if its turn ended
  const assignedToIdle = await mgr.call("task_create", { tasks: [{ title: "Polish", assignee: "antigravity" }] });
  assert.match(assignedToIdle, /antigravity is idle .* won't see new tasks/);
  assert.match(await mgr.call("swarm_inbox", { wait_seconds: 0 }), /Needs attention:\n {2}antigravity has stopped .*#5 is assigned to it/);
  assert.doesNotMatch(await mgr.call("swarm_inbox", { wait_seconds: 0 }), /Needs attention/, "alert repeated");

  // Wait learning rules (waits.js): grow after full waits, back off below cancels, cap after a repeat.
  process.env.SWARM_MCP_HOME = home;
  const { waitPolicy, recordWait } = await import("../src/waits.js");
  assert.equal(waitPolicy("probe").normal, 45);
  recordWait("probe", 45, "completed");
  assert.equal(waitPolicy("probe").normal, 90);
  recordWait("probe", 100, "cancelled"); // could be the user pressing stop: back off, no hard cap yet
  assert.deepEqual(waitPolicy("probe"), { normal: 85, max: 1800 });
  recordWait("probe", 102, "cancelled"); // same point again: that's the client's timeout
  assert.deepEqual(waitPolicy("probe"), { normal: 87, max: 87 });
  recordWait("probe", 87, "completed"); // growth stops at the cap
  assert.deepEqual(waitPolicy("probe"), { normal: 87, max: 87 });

  console.log("smoke test passed");
} finally {
  await Promise.all([mgr, codex, agy].map((a) => a.client.close()));
  fs.rmSync(home, { recursive: true, force: true });
}
