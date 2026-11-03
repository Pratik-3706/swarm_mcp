// Shared on-disk state for a swarm.
//
// Every coding agent (Claude Code, Codex, Antigravity, Cursor, ...) launches its
// own copy of this MCP server over stdio, so the processes never talk to each
// other directly. They coordinate through one JSON file per swarm, guarded by a
// cross-process lock (an atomic mkdir), and written atomically (tmp + rename).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 20_000;
const MAX_EVENTS = 1000;
const MAX_MESSAGES = 2000;

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "review", "done", "cancelled"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function swarmHome() {
  return process.env.SWARM_MCP_HOME || path.join(os.homedir(), ".swarm-mcp");
}

export function sanitizeSwarmName(name) {
  const clean = String(name || "default").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "default";
}

function emptyState(swarm, project = null) {
  return {
    swarm,
    createdAt: new Date().toISOString(),
    goal: null,
    project, // set for boards that live in a project folder
    rev: 0,
    seq: { task: 0, message: 0, event: 0 },
    agents: {},
    tasks: [],
    messages: [],
    events: [],
    notes: {},
    locks: {},
  };
}

// ------------------------------------------------------------------ project boards
//
// A project's board lives in the project itself: <project root>/.swarm/<swarm>.json, created the first time
// swarm is used there. So each project has its own tasks and notes, and an older project's work can't leak
// into a new one. Agents with no project fall back to the global board in ~/.swarm-mcp.

export const BOARD_DIR = ".swarm";

/**
 * The root a path belongs to: the nearest folder above it (or itself) that already has a board, else the
 * nearest git root, else the path itself. So an agent opened in a subfolder still finds the project's board.
 */
export function projectRoot(p) {
  if (!p) return null;
  const start = path.resolve(String(p));
  let gitRoot = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, BOARD_DIR))) return dir;
    if (!gitRoot && fs.existsSync(path.join(dir, ".git"))) gitRoot = dir;
    if (path.dirname(dir) === dir) break;
  }
  return gitRoot || start;
}

/** The nearest folder at or above p that already has a board, or null. */
export function existingBoardRoot(p) {
  if (!p) return null;
  for (let dir = path.resolve(String(p)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, BOARD_DIR))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** For a shell's current folder: the board root above it, else its git root, else null (use the global board). */
export function detectProject(p) {
  if (!p) return null;
  const board = existingBoardRoot(p);
  if (board) return board;
  for (let dir = path.resolve(String(p)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

const registryFile = () => path.join(swarmHome(), "projects.json");

/** Project boards seen on this machine, newest first: [{ root, swarm, usedAt }]. */
export function listProjects() {
  try {
    return Object.entries(JSON.parse(fs.readFileSync(registryFile(), "utf8")))
      .map(([key, v]) => ({ ...v, key }))
      .filter((v) => fs.existsSync(path.join(v.root, BOARD_DIR)))
      .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt));
  } catch {
    return [];
  }
}

function registerProject(root, swarm) {
  try {
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    } catch {
      // first one
    }
    const key = `${root}|${swarm}`;
    if (all[key] && Date.now() - Date.parse(all[key].usedAt) < 5 * 60_000) return; // hooks run per tool call; don't rewrite each time
    all[key] = { root, swarm, usedAt: new Date().toISOString() };
    fs.mkdirSync(swarmHome(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(all, null, 2));
  } catch {
    // the registry only feeds the dashboard and hints
  }
}

export class SwarmStore {
  /** project: a folder in the project (its root is found), or null for the global board. */
  constructor(swarm, { project = null } = {}) {
    this.swarm = sanitizeSwarmName(swarm);
    this.root = projectRoot(project);
    this.project = this.root ? this.root.split(path.sep).join("/") : null; // as stored and shown
    this.dir = this.root ? path.join(this.root, BOARD_DIR) : swarmHome();
    this.file = path.join(this.dir, `${this.swarm}.json`);
    this.lockDir = `${this.file}.lock`;
    const fresh = !fs.existsSync(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.root) {
      // Keep the board out of the project's git history without touching its own .gitignore.
      if (fresh || !fs.existsSync(path.join(this.dir, ".gitignore"))) fs.writeFileSync(path.join(this.dir, ".gitignore"), "*\n");
      registerProject(this.project, this.swarm);
    }
  }

  async #acquire() {
    const start = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        try {
          if (Date.now() - fs.statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between mkdir and stat
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for swarm lock ${this.lockDir}`);
        await sleep(10 + Math.random() * 40);
      }
    }
  }

  #release() {
    fs.rmSync(this.lockDir, { recursive: true, force: true });
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return emptyState(this.swarm, this.project);
      throw err;
    }
    if (!raw.trim()) return emptyState(this.swarm, this.project);
    return { ...emptyState(this.swarm, this.project), ...JSON.parse(raw) };
  }

  async #write(state) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    // Windows can briefly refuse the rename while another process has the file open.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
        await sleep(25);
      }
    }
  }

  /** Run fn(state) under the lock. If fn returns normally the state is saved. */
  async update(fn) {
    await this.#acquire();
    try {
      const state = this.#read();
      const result = await fn(state);
      state.rev += 1;
      if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
      if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES);
      await this.#write(state);
      return result;
    } finally {
      this.#release();
    }
  }

  /** Read-only snapshot under the lock. */
  async view(fn = (s) => s) {
    await this.#acquire();
    try {
      return fn(this.#read());
    } finally {
      this.#release();
    }
  }

  async reset() {
    await this.#acquire();
    try {
      await this.#write(emptyState(this.swarm, this.project));
    } finally {
      this.#release();
    }
  }
}

export function listSwarms() {
  const dir = swarmHome();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

/** Messages for this agent it hasn't seen yet (direct or broadcast, not its own). */
export function unreadMessages(state, name) {
  const agent = state.agents[name];
  if (!agent) return [];
  return state.messages.filter((m) => m.id > agent.msgCursor && m.from !== name && (m.to === "*" || m.to.includes(name)));
}

/**
 * Messages this agent still has to answer. Every message needs a reply except replies themselves
 * (so nobody gets stuck in an answer-the-answer loop) and notices sent with expect_reply=false.
 * Broadcasts from before the agent joined don't count.
 */
export function owedReplies(state, name) {
  const agent = state.agents[name];
  if (!agent) return [];
  const answered = new Set(state.messages.filter((m) => m.from === name && m.replyTo).map((m) => m.replyTo));
  return state.messages.filter(
    (m) =>
      m.needsReply &&
      m.from !== name &&
      !answered.has(m.id) &&
      (m.to === "*" ? m.at >= agent.joinedAt : m.to.includes(name)),
  );
}

const fmtOwed = (m) => `[msg #${m.id} from ${m.from}] ${m.content}`;

/** How a message reaches an agent in the middle of other work (attached to a tool result, or injected by a hook). */
export function deliveryText(messages) {
  const many = messages.length > 1;
  const owed = messages.filter((m) => m.needsReply);
  return [
    `NEW SWARM MESSAGE${many ? "S" : ""}. Stop what you are doing and read ${many ? "them" : "it"} now.`,
    ...messages.map(fmtOwed),
    owed.length
      ? `You must reply before you do anything else: message_send(reply_to=${owed[0].id}, content="...")${owed.length > 1 ? ` and the same for ${owed.slice(1).map((m) => `#${m.id}`).join(", ")}` : ""}. Answer the question or confirm what you'll do. Your other tools stay blocked until you reply. Instructions from the manager override your current plan.`
      : "No reply needed. Act on it if it concerns you, then continue.",
  ].join("\n");
}

/** Why an agent with unanswered messages can't go on yet. */
export function replyRequiredText(owed) {
  return [
    `You have ${owed.length} unanswered swarm message${owed.length > 1 ? "s" : ""}. Reply before you do anything else:`,
    ...owed.map(fmtOwed),
    `Call message_send(reply_to=${owed[0].id}, content="your answer")${owed.length > 1 ? ` once per message (${owed.map((m) => `#${m.id}`).join(", ")})` : ""}. Answer the question, or confirm what you'll do about it. Then carry on: replying is all it takes to unblock you.`,
  ].join("\n");
}

export function pushEvent(state, by, type, text, extra = {}) {
  state.seq.event += 1;
  state.events.push({ id: state.seq.event, at: new Date().toISOString(), by, type, text, ...extra });
}
