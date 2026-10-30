// How long a waiting call (task_claim, swarm_inbox, file_lock) blocks before it replies.
//
// The longer an idle agent sits inside one tool call, the fewer chances it gets to decide
// it is done and end its turn. But every MCP client cuts long calls off at its own limit,
// and an agent that gets a timeout error may stop too. So the wait is learned per client
// (by the name it sends in the MCP handshake): start short, double after every wait that
// runs its full length, and back off below the point where the client cancelled a call.
// A cancel at a new point may just be the user pressing stop, so only a second cancel at
// about the same point becomes a hard limit.

import fs from "node:fs";
import path from "node:path";
import { swarmHome } from "./store.js";

const FIXED = Number(process.env.SWARM_WAIT_SECONDS) || 0;
const START = 45;
const CAP = Number(process.env.SWARM_MAX_WAIT_SECONDS) || 1800;
const MARGIN = 15; // stay this many seconds under a cancel point
const MIN = 5;

const file = () => path.join(swarmHome(), "clients.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function save(all) {
  try {
    fs.mkdirSync(swarmHome(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  } catch {
    // Learning is an optimisation; never fail a tool call over it.
  }
}

/** { normal, max } in seconds for this client. */
export function waitPolicy(client) {
  if (FIXED) return { normal: FIXED, max: Math.max(FIXED, CAP) };
  const c = load()[client] || {};
  const max = c.limit ? Math.max(MIN, c.limit - MARGIN) : CAP;
  return { normal: Math.min(c.normal || START, max), max };
}

/** outcome "completed": a full-length wait got its reply out. "cancelled": the client dropped the call after `seconds`. */
export function recordWait(client, seconds, outcome) {
  if (FIXED) return;
  const all = load();
  const c = (all[client] ||= {});
  const ceiling = c.limit ? Math.max(MIN, c.limit - MARGIN) : CAP;
  if (outcome === "completed") {
    if (seconds >= (c.normal || START)) c.normal = Math.min(Math.round(seconds * 2), ceiling);
  } else {
    if (c.lastCancel && Math.abs(c.lastCancel - seconds) <= Math.max(5, seconds * 0.1)) c.limit = Math.round(seconds);
    c.lastCancel = Math.round(seconds);
    c.normal = Math.max(MIN, Math.round(seconds - MARGIN));
  }
  c.updatedAt = new Date().toISOString();
  save(all);
}
