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

function emptyState(swarm) {
  return {
    swarm,
    createdAt: new Date().toISOString(),
    goal: null,
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

export class SwarmStore {
  constructor(swarm) {
    this.swarm = sanitizeSwarmName(swarm);
    this.dir = swarmHome();
    this.file = path.join(this.dir, `${this.swarm}.json`);
    this.lockDir = `${this.file}.lock`;
    fs.mkdirSync(this.dir, { recursive: true });
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
      if (err.code === "ENOENT") return emptyState(this.swarm);
      throw err;
    }
    if (!raw.trim()) return emptyState(this.swarm);
    return { ...emptyState(this.swarm), ...JSON.parse(raw) };
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
      await this.#write(emptyState(this.swarm));
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

export function pushEvent(state, by, type, text, extra = {}) {
  state.seq.event += 1;
  state.events.push({ id: state.seq.event, at: new Date().toISOString(), by, type, text, ...extra });
}
