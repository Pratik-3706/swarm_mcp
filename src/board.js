// Board upkeep that isn't tied to one tool:
//  - which project folder a swarm is for, and starting a clean round when the goal changes,
//    so tasks and notes from the previous project never leak into the next one
//  - returning tasks held by agents that went silent, so work doesn't wait on the manager
//  - working out which files a task changed, for its result

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pushEvent } from "./store.js";

// A task whose holder has made no swarm call (and, with the hooks, used no tool) for this long goes back on the board.
export const REASSIGN_MS = (Number(process.env.SWARM_REASSIGN_MINUTES) || 20) * 60_000;
// Workers post progress at least this often; past it they get a reminder.
export const HEARTBEAT_MS = (Number(process.env.SWARM_HEARTBEAT_MINUTES) || 10) * 60_000;

const OPEN = (t) => !["done", "cancelled"].includes(t.status);
const nowIso = () => new Date().toISOString();

export const isWaiting = (agent) => !!agent.waitingUntil && Date.parse(agent.waitingUntil) > Date.now();

/** The task this agent should post progress on now, or null. At most one reminder per heartbeat period. */
export function heartbeatDue(state, name) {
  const agent = state.agents[name];
  const task = state.tasks.find((t) => t.assignee === name && t.status === "in_progress");
  if (!agent || !task) return null;
  const since = (iso) => Date.now() - Date.parse(iso || 0);
  return since(task.progressAt || task.claimedAt || task.updatedAt) > HEARTBEAT_MS && since(agent.heartbeatAskedAt) > HEARTBEAT_MS ? task : null;
}

export const heartbeatText = (task) =>
  `PROGRESS CHECK: no update on #${task.id} "${task.title}" for over ${Math.round(HEARTBEAT_MS / 60_000)} minutes. Post one now so the team and the user can see where it stands: task_update(task_id=${task.id}, progress=<0-100>, eta="<time left>", note="what's done"). Then carry on.`;

/** An absolute, slash-separated project path for display; null if none given. */
export function projectPath(p) {
  return p ? path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "") : null;
}

export function sameProject(a, b) {
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return !a || !b || key(projectPath(a)) === key(projectPath(b));
}

/** Close the previous round: cancel its open tasks, archive its notes, drop locks and owed replies. */
export function startRound(state, by, goal, project) {
  const at = nowIso();
  const open = state.tasks.filter(OPEN);
  for (const t of open) {
    t.status = "cancelled";
    t.updatedAt = at;
    t.notes.push({ by, at, text: `Closed automatically: a new goal started (previous goal: ${state.goal || "none"}).` });
  }
  const notes = Object.keys(state.notes).length;
  if (notes) {
    state.archivedNotes = { ...(state.archivedNotes || {}), [`round ${state.round || 1}`]: state.notes };
    state.notes = {};
  }
  state.locks = {};
  for (const m of state.messages) m.needsReply = false;
  const previous = state.goal;
  state.round = (state.round || 1) + 1;
  state.goal = goal;
  if (project) state.project = project;
  delete state.finishedAt;
  pushEvent(state, by, "round", `${by} started round ${state.round}: ${goal}${open.length ? ` (closed ${open.length} open task(s) from the previous goal)` : ""}`);
  return { previous, closed: open.length, notes };
}

/**
 * Give back work held by agents that went silent: in-progress tasks go back to todo for anyone,
 * and todo tasks assigned to an agent that stopped lose their assignee. Returns what moved.
 */
export function returnStalledTasks(state) {
  const moved = [];
  for (const t of state.tasks) {
    const a = t.assignee && state.agents[t.assignee];
    if (!a || !OPEN(t)) continue;
    const quiet = Date.now() - Date.parse(a.lastSeen);
    const gone = a.status === "offline" || quiet > REASSIGN_MS;
    if (!gone || isWaiting(a)) continue;
    const mins = Math.round(quiet / 60_000);
    if (t.status === "in_progress" || t.status === "blocked") {
      t.notes.push({ by: "swarm", at: nowIso(), text: `Returned to the board: ${a.name} was silent for ${mins} min.${t.progress ? ` It had reported ${t.progress}%.` : ""}` });
      t.status = "todo";
    } else if (t.status !== "todo") continue;
    t.assignee = null;
    t.updatedAt = nowIso();
    for (const [p, l] of Object.entries(state.locks)) if (l.taskId === t.id) delete state.locks[p];
    moved.push({ task: t, from: a.name, mins });
  }
  for (const { task, from, mins } of moved) {
    pushEvent(state, "swarm", "task_returned", `#${task.id} ${task.title} went back on the board (${from} was silent for ${mins} min)`, { taskId: task.id });
    state.seq.message += 1;
    state.messages.push({
      id: state.seq.message,
      at: nowIso(),
      from: "swarm",
      to: [from],
      content: `#${task.id} "${task.title}" went back on the board because you were silent for ${mins} min. If you are still on it, claim it again with task_claim(task_id=${task.id}), or tell the manager.`,
      needsReply: false,
    });
  }
  return moved;
}

function git(project, ...args) {
  return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true });
}

/** The commit a task starts from, so its changes can be found later. null outside a git repo. */
export function baseCommit(project) {
  try {
    return project ? git(project, "rev-parse", "HEAD").trim() : null;
  } catch {
    return null;
  }
}

/**
 * Files a task most likely changed: the paths it locked, plus files git sees changed since it was claimed
 * (committed since its base commit, or edited in the working tree after the claim), minus files another
 * agent holds a lock on. Several agents share one working tree, so git alone can't attribute changes.
 */
export function changedFiles(state, task) {
  const own = Object.entries(state.locks).filter(([, l]) => l.taskId === task.id).map(([p]) => p);
  const found = [];
  const project = state.project;
  if (project && fs.existsSync(path.join(project, ".git"))) {
    try {
      if (task.baseCommit) found.push(...git(project, "diff", "--name-only", task.baseCommit, "HEAD").split("\n"));
      const since = Date.parse(task.claimedAt || task.createdAt) - 1000;
      for (const line of git(project, "status", "--porcelain", "-uall").split("\n")) {
        const file = line.slice(3).split(" -> ").pop()?.replace(/^"|"$/g, "");
        if (!file) continue;
        let mtime = Infinity; // deleted files count
        try {
          mtime = fs.statSync(path.join(project, file)).mtimeMs;
        } catch {
          // gone
        }
        if (mtime >= since) found.push(file);
      }
    } catch {
      // not a usable repo: fall back to the locked paths
    }
  }
  const othersLocked = Object.entries(state.locks)
    .filter(([, l]) => l.taskId !== task.id)
    .map(([p]) => p);
  const covered = (f) => othersLocked.some((p) => f === p || f.startsWith(`${p}/`));
  return [...new Set([...own, ...found])].filter((f) => f && !covered(f)).sort().slice(0, 100);
}
