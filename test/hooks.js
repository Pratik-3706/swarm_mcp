// Checks the Stop hook, the shell fallback (`call`) and the installer's hook / instruction edits.
// Runs itself in a child process whose home folder is a temp dir, so real configs are never touched.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.js");

if (!process.env.SWARM_TEST_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-hooks-"));
  const env = { ...process.env, SWARM_TEST_HOME: home, HOME: home, USERPROFILE: home, SWARM_MCP_HOME: path.join(home, ".swarm-mcp") };
  delete env.CODEX_HOME;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: "inherit" });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const home = process.env.SWARM_TEST_HOME;
const cli = (...args) => {
  const r = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  return { out: r.stdout.trim(), code: r.status };
};
const hook = (kind, input) => execFileSync(process.execPath, [entry, "hook", kind], { input: JSON.stringify(input), encoding: "utf8" }).trim();
const stop = (session) => {
  const out = hook("stop", { session_id: session, hook_event_name: "Stop", stop_hook_active: false });
  return out ? JSON.parse(out) : null;
};

// --- shell fallback ---
assert.match(cli("call", "swarm_join", "--as", "W1", "--role", "worker").out, /Joined as "w1" \(worker\)/);
assert.match(cli("call", "swarm_join", "--as", "boss", "--role", "manager", "--goal", "Ship it").out, /Joined as "boss" \(manager\)/);
const created = cli("call", "task_create", "--as", "boss", '{"tasks":[{"title":"Write docs","assignee":"w1"}]}');
assert.match(created.out, /#1 \[todo\] Write docs @w1/);
assert.match(cli("call", "task_claim", "--as", "w1").out, /You claimed task #1/);
assert.match(cli("call", "task_update", "--as", "w1", "--task_id", "1", "--status", "review", "--result", "docs written").out, /\[review\]/);
assert.equal(cli("call", "swarm_finish", "--as", "w1", "--summary", "x").code, 1, "a worker must not finish the swarm");
assert.match(cli("call").out, /Usage: swarm-mcp call/);

// --- Stop hook ---
// Conversations that never joined are left alone.
assert.equal(stop("nobody"), null);
// PostToolUse on swarm_join ties the conversation to the agent.
hook("post-tool", { session_id: "s1", tool_name: "mcp__swarm__swarm_join", tool_input: { name: "W1", role: "worker" }, tool_response: [{ type: "text", text: 'Joined as "w1"' }] });
let d = stop("s1");
assert.equal(d.decision, "block");
assert.match(d.reason, /You are "w1", a worker in swarm "default".*call task_claim/);
// Loop guard: blocks the agent answers without touching the swarm stop counting after two.
assert.equal(stop("s1")?.decision, "block");
assert.equal(stop("s1"), null, "loop guard did not let the agent stop");
// A swarm call resets the guard.
cli("call", "swarm_inbox", "--as", "w1", "--wait_seconds", "0");
assert.equal(stop("s1")?.decision, "block");

// The manager is kept going while tasks are open, pointed at swarm_inbox.
hook("post-tool", { session_id: "m1", tool_name: "mcp__swarm__swarm_join", tool_input: { name: "boss", role: "manager" }, tool_response: 'Joined as "boss"' });
assert.match(stop("m1").reason, /manager of swarm "default" and 1 task\(s\) are still open.*swarm_inbox/);

// A message sent while w1 is busy is injected after its next tool use of any kind, once.
cli("call", "message_send", "--as", "boss", "--to", "w1", "--content", "Stop editing app.css, use theme.css");
const injected = JSON.parse(hook("post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "app.css" } }));
assert.equal(injected.hookSpecificOutput.hookEventName, "PostToolUse");
assert.match(injected.hookSpecificOutput.additionalContext, /NEW SWARM MESSAGE[\s\S]*from boss\] Stop editing app.css, use theme.css/);
assert.equal(hook("post-tool", { session_id: "s1", tool_name: "Edit", tool_input: {} }), "", "message injected twice");
// Unread messages also ride along when the hook keeps an agent from stopping.
cli("call", "message_send", "--as", "boss", "--to", "w1", "--content", "Also check mobile");
assert.match(stop("s1").reason, /Also check mobile[\s\S]*call task_claim/);
// While w1 owes replies, its next tool of any kind is refused, except the swarm tools it needs to reply.
const pre = (tool, toolInput = {}) => {
  const out = hook("pre-tool", { session_id: "s1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput });
  return out ? JSON.parse(out) : null;
};
const denied = pre("Edit", { file_path: "app.css" });
assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /2 unanswered swarm messages[\s\S]*#1 from boss[\s\S]*#2 from boss/);
assert.equal(pre("mcp__swarm__message_send"), null);
assert.equal(pre("Bash", { command: `node "${entry.replace(/\\/g, "/")}" call message_send --as w1 --reply_to 1 --content ok` }), null);
assert.equal(pre("Bash", { command: "npm test" })?.decision, "block");
assert.match(cli("call", "message_send", "--as", "w1", "--reply_to", "1", "--content", "Moving to theme.css").out, /Replied to #1[\s\S]*unanswered swarm message[\s\S]*#2/);
assert.match(cli("call", "message_send", "--as", "w1", "--reply_to", "2", "--content", "Will check mobile").out, /You're unblocked/);
assert.equal(pre("Edit", { file_path: "theme.css" }), null, "still blocked after replying");

// The shell fallback counts as joining too (any `call` joins first).
hook("post-tool", { session_id: "s2", tool_name: "Bash", tool_input: { command: `node "${entry.replace(/\\/g, "/")}" call task_claim --as w1` } });
assert.equal(stop("s2")?.decision, "block");

// swarm_leave releases a conversation.
hook("post-tool", { session_id: "s2", tool_name: "mcp__swarm__swarm_leave", tool_input: {} });
assert.equal(stop("s2"), null);

// Once the manager finishes the swarm, nobody is held back.
cli("call", "task_update", "--as", "boss", "--task_id", "1", "--status", "done");
assert.match(cli("call", "swarm_finish", "--as", "boss", "--summary", "Docs shipped.").out, /is finished/);
assert.equal(stop("s1"), null);
assert.equal(stop("m1"), null);

// --- installer extras ---
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { PostToolUse: [userHook] } }));
fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# My rules\n\nNever do X.\n");
fs.writeFileSync(path.join(home, ".gemini", "config", "hooks.json"), JSON.stringify({ other: { enabled: true, Stop: [] } }));

const { editHooks, editInstructions } = await import("../src/extras.js");
const ctx = (remove) => ({ remove, dryRun: false, verb: () => "", backup: () => {} });
for (let i = 0; i < 2; i++) for (const id of ["claude", "codex", "antigravity-ide"]) editHooks(id, entry, ctx(false)), editInstructions(id, entry, ctx(false));

const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
assert.equal(claude.theme, "dark");
assert.equal(claude.hooks.Stop.length, 1, "Stop hook duplicated on reinstall");
assert.match(claude.hooks.Stop[0].hooks[0].command, /index\.js" hook stop$/);
assert.deepEqual(claude.hooks.PostToolUse[0], userHook, "user's own hook was changed");
assert.equal(claude.hooks.PostToolUse.length, 2);
const codex = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
assert.match(codex.hooks.Stop[0].hooks[0].command, /hook stop$/);
const agy = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "hooks.json"), "utf8"));
assert.ok(agy.other && agy["swarm-mcp"].enabled && agy["swarm-mcp"].Stop[0].hooks[0].command.endsWith("hook stop"));
const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
assert.ok(md.startsWith("# My rules\n\nNever do X.\n\n<!-- swarm-mcp:start -->"), "instructions not appended cleanly");
assert.equal(md.split("swarm-mcp:start").length, 2, "instructions duplicated on reinstall");
assert.match(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8"), /call task_claim --as <your-name>/);

for (const id of ["claude", "codex", "antigravity-ide"]) editHooks(id, entry, ctx(true)), editInstructions(id, entry, ctx(true));
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")), { theme: "dark", hooks: { PostToolUse: [userHook] } });
assert.equal(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8"), "# My rules\n\nNever do X.\n");
assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "hooks.json"), "utf8")), { other: { enabled: true, Stop: [] } });

console.log("hooks test passed");
