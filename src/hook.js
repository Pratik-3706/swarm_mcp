// Optional hooks for apps with Claude-style hooks (Claude Code, Codex, Antigravity).
//
// MCP alone can't stop an agent from ending its turn. These apps run a Stop hook when the
// agent is about to stop, and a hook that answers {"decision":"block","reason":...} makes it
// keep going with that reason as its next instruction. The hook only acts on conversations
// that joined a swarm: a PostToolUse hook on swarm_join records which conversation is which
// agent, so other chats in the same app are never held back. The same PostToolUse hook also hands a
// busy agent messages from teammates after each tool it uses, so they reach it mid-task, and a
// PreToolUse hook refuses its next tool (anything but the swarm tools) until it has replied.
//
//   swarm-mcp hook pre-tool    (PreToolUse)  block other tools while this agent owes a reply to a message
//   swarm-mcp hook post-tool   (PostToolUse) remember / forget this conversation's identity; deliver messages
//   swarm-mcp hook stop        (Stop)        block stopping while the swarm still needs this agent

import fs from "node:fs";
import path from "node:path";
import { BOARD_DIR, SwarmStore, deliveryText, detectProject, owedReplies, replyRequiredText, swarmHome, unreadMessages } from "./store.js";
import { heartbeatDue, heartbeatText } from "./board.js";

// The swarm counts as abandoned after this long without any activity; then nobody is held back.
const QUIET_LIMIT_MS = 2 * 60 * 60_000;
// Stopping is allowed after this many blocks in a row that the agent answered without any swarm call.
const MAX_STRIKES = 2;

const sessionFile = (id) => path.join(swarmHome(), "sessions", `${String(id).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const pick = (obj, ...keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null && v !== "");

/** `swarm-mcp call <tool> --as x --role y --swarm z` run through the agent's shell tool, as {tool, args}. */
function shellCall(command) {
  const m = /(swarm-mcp|swarm_mcp\S*index\.js["']?)\s+call\s+(\w+)(.*)/.exec(command || "");
  if (!m) return null;
  const flag = (f) => new RegExp(`--${f}[=\\s]+["']?([^\\s"']+)`).exec(m[3])?.[1];
  // Every shell call joins first, so any of them (except leaving) ties this conversation to the agent.
  const tool = /swarm_leave|swarm_reset/.test(m[2]) ? m[2] : "swarm_join";
  return { tool, args: { name: flag("as"), role: flag("role") || "worker", swarm: flag("swarm"), project: flag("project") } };
}

/** The "Board: <file>" line of a join reply, as { swarm, project } (project null for the global board). */
function boardFromReply(response) {
  const m = /Board: (.+?\.json)/.exec(response);
  if (!m) return null;
  let file = m[1];
  try {
    file = JSON.parse(`"${file}"`); // the reply was JSON-encoded, so backslashes are escaped
  } catch {
    // already plain
  }
  const dir = path.dirname(file);
  return { swarm: path.basename(file, ".json"), project: path.basename(dir) === BOARD_DIR ? path.dirname(dir) : null };
}

function recordJoin(input, session) {
  let tool = String(pick(input, "tool_name", "toolName", "name") || "");
  let args = pick(input, "tool_input", "toolInput", "arguments", "input") || {};
  if (typeof args === "string") args = JSON.parse(args);
  const viaShell = shellCall(args.command);
  if (viaShell) ({ tool, args } = viaShell);
  const file = sessionFile(session);
  if (/swarm_leave|swarm_reset/.test(tool)) return fs.rmSync(file, { force: true });
  if (!/swarm_join/.test(tool)) return;
  const response = JSON.stringify(pick(input, "tool_response", "toolResponse", "output", "result") ?? "");
  if (!args.name || !args.role || (response.includes("Error:") && !/Joined|Rejoined/.test(response))) return;
  // Which board: the join reply says so; otherwise work it out the way the server and shell fallback do.
  const board = boardFromReply(response) || {
    swarm: args.swarm || process.env.SWARM_NAME || "default",
    project: args.project || detectProject(pick(input, "cwd")),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      swarm: board.swarm,
      project: board.project,
      name: String(args.name).trim().toLowerCase().replace(/\s+/g, "-"),
      role: String(args.role).toLowerCase(),
      joinedAt: new Date().toISOString(),
    }),
  );
}

/** Unread messages for this conversation's agent, marked read; [] if it isn't in a swarm. */
async function takeUnread(session) {
  const file = sessionFile(session);
  if (!fs.existsSync(file)) return [];
  const link = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = new SwarmStore(link.swarm, { project: link.project });
  if (!(await store.view((state) => unreadMessages(state, link.name).length))) return [];
  return store.update((state) => {
    const messages = unreadMessages(state, link.name);
    if (state.agents[link.name]) state.agents[link.name].msgCursor = state.seq.message;
    return messages;
  });
}

// After any tool the agent uses (an edit, a shell command...): hand it messages that arrived meanwhile, so
// teammates reach it mid-task; nudge it to post progress when its task has gone quiet; and, at most once a
// minute, mark it as seen, so an agent busy editing never looks silent and loses its task.
async function afterTool(session, event) {
  const file = sessionFile(session);
  if (!fs.existsSync(file)) return;
  const link = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = new SwarmStore(link.swarm, { project: link.project });
  const stale = Date.now() - Date.parse(link.touchedAt || 0) > 60_000;
  const pending = await store.view((state) => unreadMessages(state, link.name).length || heartbeatDue(state, link.name));
  if (!pending && !stale) return;
  const parts = await store.update((state) => {
    const agent = state.agents[link.name];
    if (!agent) return [];
    agent.lastSeen = new Date().toISOString();
    const out = [];
    const messages = unreadMessages(state, link.name);
    agent.msgCursor = state.seq.message;
    if (messages.length) out.push(deliveryText(messages));
    const due = heartbeatDue(state, link.name);
    if (due) {
      agent.heartbeatAskedAt = new Date().toISOString();
      out.push(heartbeatText(due));
    }
    return out;
  });
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), touchedAt: new Date().toISOString() }));
  if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join("\n\n") } }));
}

// Before each tool: while the agent owes a reply, only swarm tools (MCP, or the shell fallback) may run.
async function gateTool(input, session) {
  const file = sessionFile(session);
  if (!fs.existsSync(file)) return;
  const link = JSON.parse(fs.readFileSync(file, "utf8"));
  const owed = await new SwarmStore(link.swarm, { project: link.project }).view((state) => owedReplies(state, link.name));
  if (!owed.length) return;
  const tool = String(pick(input, "tool_name", "toolName", "name") || "");
  let args = pick(input, "tool_input", "toolInput", "arguments", "input") || {};
  if (typeof args === "string") args = { command: args };
  if (/swarm/i.test(tool) || shellCall(args.command)) return; // replying (and reading) is always allowed
  const reason = replyRequiredText(owed);
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}

async function decideStop(session) {
  const file = sessionFile(session);
  if (!fs.existsSync(file)) return; // this conversation never joined a swarm
  const link = JSON.parse(fs.readFileSync(file, "utf8"));
  const state = await new SwarmStore(link.swarm, { project: link.project }).view();
  const agent = state.agents[link.name];
  const lastActivity = Date.parse(state.events.at(-1)?.at || state.createdAt);
  const owed = agent ? owedReplies(state, link.name) : [];
  // Unanswered messages keep an agent here even in a finished swarm, until it replies.
  if (!agent || agent.status === "offline" || (!owed.length && (state.finishedAt || Date.now() - lastActivity > QUIET_LIMIT_MS))) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Loop guard: if the agent made no swarm call since the last block, it can't (or won't) use the tools.
  if (link.blockedAt && agent.lastSeen <= link.blockedAt) link.strikes = (link.strikes || 0) + 1;
  else link.strikes = 0;
  if (link.strikes >= (owed.length ? MAX_STRIKES * 2 : MAX_STRIKES)) {
    fs.writeFileSync(file, JSON.stringify({ ...link, blockedAt: null, strikes: 0 }));
    return;
  }

  const role = agent.role.toLowerCase();
  const open = state.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  let reason;
  if (role === "manager")
    reason = open.length
      ? `You are the manager of swarm "${state.swarm}" and ${open.length} task(s) are still open. Don't stop yet: call swarm_inbox to keep watching (it waits for activity), review finished work and keep the team moving.`
      : `Every task in swarm "${state.swarm}" is done. If the goal is met and verified, call swarm_finish, then report to the user. Otherwise create the next tasks with task_create.`;
  else if (role === "reviewer")
    reason = `You are "${agent.name}", the reviewer in swarm "${state.swarm}", and the swarm isn't finished. Don't stop yet: check task_list(status="review"), and call swarm_inbox to wait when there is nothing to review.`;
  else
    reason = `You are "${agent.name}", a ${agent.role} in swarm "${state.swarm}", and the swarm isn't finished. Don't stop yet: call task_claim to get your next task (it waits until there is one), then do it.`;
  reason += " If the user told you to stop, call swarm_leave first; then you may stop.";
  if (owed.length) reason = state.finishedAt ? `${replyRequiredText(owed)} After that you may stop: the swarm is finished.` : `${replyRequiredText(owed)}\n\n${reason}`;
  const unread = (await takeUnread(session)).filter((m) => !owed.some((o) => o.id === m.id));
  if (unread.length) reason = `${deliveryText(unread)}\n\n${reason}`;

  fs.writeFileSync(file, JSON.stringify({ ...link, blockedAt: new Date().toISOString() }));
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

export async function runHook(kind) {
  const input = readInput();
  const session = pick(input, "session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId");
  if (!session) return;
  try {
    if (kind === "pre-tool") await gateTool(input, session);
    else if (kind === "post-tool") {
      recordJoin(input, session);
      await afterTool(session, pick(input, "hook_event_name", "hookEventName") || "PostToolUse");
    }
    else if (kind === "stop") await decideStop(session);
  } catch {
    // A broken hook must never wedge the agent: say nothing, which lets it stop normally.
  }
}
