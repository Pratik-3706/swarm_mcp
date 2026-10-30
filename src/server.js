import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmStore, TASK_STATUSES, deliveryText, pushEvent, unreadMessages } from "./store.js";
import { PLAYBOOKS, SERVER_INSTRUCTIONS, managerPrompt, workerPrompt, reviewerPrompt } from "./prompts.js";
import { recordWait, waitPolicy } from "./waits.js";

const ACTIVE_WINDOW_MS = 10 * 60_000;
// No task and not waiting for one for this long: the agent has most likely ended its turn.
const IDLE_MS = (Number(process.env.SWARM_IDLE_SECONDS) || 90) * 1000;
// Holding a task with no swarm calls for this long: it may be stuck or waiting on its user.
const STALE_TASK_MS = 10 * 60_000;
const PROGRESS_EVERY_MS = 5_000;
// Every reply to a waiting call ends with this, so an agent never reads a timeout as "done".
const IF_TIMEOUT = "If a swarm call ever times out or errors, call it again; it is not a reason to stop.";

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (tasks) => tasks.map((t) => `#${t.id}`).join(", ");
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: `Error: ${t}` }], isError: true });

function fmtTask(t) {
  const who = t.assignee ? ` @${t.assignee}` : " (unassigned)";
  const deps = t.dependsOn?.length ? ` deps:${t.dependsOn.map((d) => `#${d}`).join(",")}` : "";
  const prio = t.priority && t.priority !== "normal" ? ` !${t.priority}` : "";
  return `#${t.id} [${t.status}]${prio} ${t.title}${who}${deps}`;
}

function fmtTaskFull(t) {
  const lines = [fmtTask(t)];
  if (t.description) lines.push(`  description: ${t.description}`);
  if (t.result) lines.push(`  result: ${t.result}`);
  for (const n of t.notes || []) lines.push(`  note (${n.by}, ${n.at}): ${n.text}`);
  return lines.join("\n");
}

function fmtMessage(m) {
  const to = m.to === "*" ? "all" : m.to.join(",");
  return `[msg #${m.id} ${m.at}] ${m.from} -> ${to}: ${m.content}`;
}

function isActive(agent) {
  return agent.status !== "offline" && Date.now() - Date.parse(agent.lastSeen) < ACTIVE_WINDOW_MS;
}

const isWaiting = (agent) => !!agent.waitingUntil && Date.parse(agent.waitingUntil) > Date.now();

/** Not waiting, not holding a task, and quiet: it won't notice new work until its user nudges it. */
function seemsStopped(state, a) {
  if (a.status === "offline") return true;
  if (isWaiting(a) || state.tasks.some((t) => t.assignee === a.name && t.status === "in_progress")) return false;
  return Date.now() - Date.parse(a.lastSeen) > IDLE_MS;
}

function agentState(state, a) {
  if (a.status === "offline") return "offline";
  if (isWaiting(a)) return a.role.toLowerCase() === "manager" ? "watching the board" : "waiting for work";
  const quiet = Date.now() - Date.parse(a.lastSeen);
  const current = state.tasks.filter((t) => t.assignee === a.name && t.status === "in_progress");
  if (current.length)
    return `working on ${ids(current)}${quiet > STALE_TASK_MS ? ` (no activity for ${minutes(quiet)}m — may be stuck or waiting for its user)` : ""}`;
  if (quiet > IDLE_MS) return `idle ${minutes(quiet)}m, not waiting for work — probably stopped`;
  return "active";
}

/** Assigned work that nobody is doing. No event fires for these, so they are computed. */
function stallAlerts(state, me) {
  const alerts = [];
  for (const a of Object.values(state.agents)) {
    if (a.name === me || a.status === "offline" || isWaiting(a)) continue;
    const quiet = Date.now() - Date.parse(a.lastSeen);
    const holding = state.tasks.filter((t) => t.assignee === a.name && t.status === "in_progress");
    const queued = state.tasks.filter((t) => t.assignee === a.name && t.status === "todo");
    const key = `${a.name}@${a.lastSeen}`;
    if (holding.length && quiet > STALE_TASK_MS)
      alerts.push({
        key,
        text: `${a.name} has ${ids(holding)} in progress but no activity for ${minutes(quiet)}m. It may be stuck or waiting for its user. Ask the user to check on ${a.name}, or reassign with task_update(assignee=...).`,
      });
    else if (!holding.length && queued.length && quiet > IDLE_MS)
      alerts.push({
        key,
        text: `${a.name} has stopped (idle ${minutes(quiet)}m, not waiting for work) but ${ids(queued)} ${queued.length > 1 ? "are" : "is"} assigned to it. Reassign with task_update(assignee=...), or ask the user to tell ${a.name} to continue.`,
      });
  }
  return alerts;
}

/** Poll check() every second until it returns something, the time is up, or the call is dropped. */
async function waitFor(check, seconds, extra, dropped) {
  const start = Date.now();
  const token = extra?._meta?.progressToken;
  let lastPing = start;
  for (;;) {
    const result = await check();
    if (result || Date.now() - start >= seconds * 1000 || extra?.signal?.aborted || dropped()) return result;
    // Progress pings tell clients that support them the call is alive, so they don't time it out.
    if (token !== undefined && Date.now() - lastPing >= PROGRESS_EVERY_MS) {
      lastPing = Date.now();
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: Math.round((lastPing - start) / 1000), total: seconds, message: "waiting" },
        })
        .catch(() => {});
    }
    await sleep(1000);
  }
}

function depsDone(state, task) {
  return (task.dependsOn || []).every((id) => state.tasks.find((t) => t.id === id)?.status === "done");
}

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

function claimable(state, me) {
  return state.tasks
    .filter((t) => t.status === "todo" && (!t.assignee || t.assignee === me) && depsDone(state, t))
    .sort((a, b) => {
      // tasks assigned to me first, then priority, then age
      const mine = (b.assignee === me) - (a.assignee === me);
      return mine || PRIORITY_ORDER[a.priority || "normal"] - PRIORITY_ORDER[b.priority || "normal"] || a.id - b.id;
    });
}

function inboxFor(state, me) {
  const agent = state.agents[me];
  const messages = state.messages.filter(
    (m) => m.id > agent.msgCursor && m.from !== me && (m.to === "*" || m.to.includes(me)),
  );
  const events = state.events.filter((e) => e.id > agent.eventCursor && e.by !== me && e.type !== "message");
  return { messages, events };
}

/** Unread messages for me, marked read. */
function takeMessages(state, me) {
  const { messages } = inboxFor(state, me);
  state.agents[me].msgCursor = state.seq.message;
  return messages;
}

export function summarize(state, me) {
  const agents = Object.values(state.agents);
  const lines = [`Swarm "${state.swarm}"${state.finishedAt ? " (finished)" : ""}${state.goal ? ` — goal: ${state.goal}` : ""}`];
  lines.push("", "Agents:");
  if (!agents.length) lines.push("  (none)");
  for (const a of agents)
    lines.push(
      `  ${a.name}${a.name === me ? " (you)" : ""} — ${a.role}${a.client ? ` via ${a.client}` : ""}, ${a.name === me ? "active" : agentState(state, a)}` +
        (a.about ? ` — ${a.about}` : ""),
    );
  const alerts = stallAlerts(state, me);
  if (alerts.length) lines.push("", "Needs attention:", ...alerts.map((x) => `  ${x.text}`));
  lines.push("", "Tasks:");
  const open = state.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const closed = state.tasks.length - open.length;
  if (!state.tasks.length) lines.push("  (none)");
  for (const t of open) lines.push(`  ${fmtTask(t)}${t.status === "todo" && !depsDone(state, t) ? " (waiting on deps)" : ""}`);
  if (closed) lines.push(`  ...plus ${closed} done/cancelled (task_list status=done to see them)`);
  const locks = Object.entries(state.locks);
  if (locks.length) {
    lines.push("", "File locks:");
    for (const [p, l] of locks) lines.push(`  ${p} — ${l.by}`);
  }
  const notes = Object.keys(state.notes);
  if (notes.length) lines.push("", `Shared notes: ${notes.join(", ")}`);
  return lines.join("\n");
}

export function createServer() {
  const server = new McpServer(
    { name: "swarm-mcp", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Identity of the agent behind this stdio connection.
  const session = { store: null, name: null };

  async function join({ name, role, swarm, client, about, goal }) {
    const store = new SwarmStore(swarm || process.env.SWARM_NAME || "default");
    name = name.trim().toLowerCase().replace(/\s+/g, "-");
    const result = await store.update((state) => {
      const existing = state.agents[name];
      state.agents[name] = {
        name,
        role,
        client: client || existing?.client || clientName(),
        about: about || existing?.about || null,
        joinedAt: existing?.joinedAt || now(),
        lastSeen: now(),
        status: "online",
        // Newcomers get direct/broadcast messages sent before they joined, but not old event noise.
        msgCursor: existing?.msgCursor ?? 0,
        eventCursor: existing?.eventCursor ?? state.seq.event,
        alerted: existing?.alerted || [],
      };
      if (goal) {
        state.goal = goal;
        delete state.finishedAt; // a manager with a goal starts a new round
      }
      // Rejoining under the same role (a restarted app, or each call of the shell fallback) is not news.
      if (!existing || existing.role !== role || existing.status === "offline")
        pushEvent(state, name, "join", `${name} ${existing ? "rejoined" : "joined"} as ${role}`);
      return {
        rejoined: !!existing,
        summary: summarize(state, name),
        unread: inboxFor(state, name).messages.length,
        managers: Object.values(state.agents)
          .filter((a) => a.name !== name && a.role.toLowerCase() === "manager" && isActive(a))
          .map((a) => a.name),
        mine: state.tasks.filter((t) => t.assignee === name && t.status === "in_progress"),
      };
    });
    session.store = store;
    session.name = name;
    return result;
  }

  // Auto-join when the client config pins an identity (SWARM_AGENT / SWARM_ROLE env vars).
  const autoJoin = process.env.SWARM_AGENT
    ? join({ name: process.env.SWARM_AGENT, role: process.env.SWARM_ROLE || "worker", client: process.env.SWARM_CLIENT }).catch(() => {})
    : Promise.resolve();

  async function requireJoin() {
    await autoJoin;
    if (!session.store) throw new Error('Not joined yet. Call swarm_join first (e.g. name="claude", role="worker").');
    return session;
  }

  /** Wrap a handler: require join, heartbeat, turn thrown errors into tool errors. */
  const tool = (fn) => async (args, extra) => {
    try {
      const s = await requireJoin();
      return withMessages(s, await fn(args, s, extra));
    } catch (err) {
      return fail(err.message);
    }
  };

  // Messages reach a busy agent with whatever swarm call it makes next, not only via swarm_inbox.
  async function withMessages(s, result) {
    if (result.isError || !s.store) return result;
    try {
      if (!(await s.store.view((state) => unreadMessages(state, s.name).length))) return result;
      const messages = await s.store.update((state) => (state.agents[s.name] ? takeMessages(state, s.name) : []));
      return messages.length ? { ...result, content: [...result.content, { type: "text", text: deliveryText(messages) }] } : result;
    } catch {
      return result;
    }
  }

  const member = (state, me) => {
    const a = state.agents[me];
    if (!a) throw new Error(`Agent "${me}" is no longer in this swarm (it was reset). Call swarm_join again.`);
    return a;
  };

  const touch = (state, me) => {
    const a = member(state, me);
    a.lastSeen = now();
    a.status = "online";
    return a;
  };

  // One claim attempt under the lock: the reply text, or null when there is nothing for this agent yet.
  function claimOnce(state, me, taskId) {
    touch(state, me);
    const busy = state.tasks.find((t) => t.assignee === me && t.status === "in_progress");
    if (busy && busy.id === taskId) return workOn(state, me, busy, "You are already working on");
    if (busy)
      return `You already have #${busy.id} in progress, and you can hold only one task at a time. Do that work now, then call task_update(task_id=${busy.id}, status="done", result=...). If you're stuck on it, set it to "blocked" with a note first.\n\n${fmtTaskFull(busy)}`;
    let task;
    if (taskId) {
      task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`No task #${taskId}`);
      if (task.status !== "todo" && !(task.assignee === me && task.status === "blocked"))
        throw new Error(`Task #${taskId} is ${task.status}${task.assignee ? ` (@${task.assignee})` : ""}, not claimable`);
      if (task.assignee && task.assignee !== me) throw new Error(`Task #${taskId} is assigned to ${task.assignee}`);
      if (!depsDone(state, task)) throw new Error(`Task #${taskId} is waiting on dependencies ${task.dependsOn.map((d) => `#${d}`).join(",")}`);
    } else {
      task = claimable(state, me)[0];
      if (!task) {
        const messages = takeMessages(state, me);
        if (!messages.length) return null;
        return `Messages:\n${messages.map(fmtMessage).join("\n")}\n\nNo task for you yet. Act on the messages above (if the manager says to stop, stop). Otherwise call task_claim again to wait for work.`;
      }
    }
    task.status = "in_progress";
    task.assignee = me;
    task.updatedAt = now();
    pushEvent(state, me, "task_claimed", `${me} started #${task.id} ${task.title}`, { taskId: task.id });
    return workOn(state, me, task, "You claimed");
  }

  function workOn(state, me, task, lead) {
    const deps = task.dependsOn.map((d) => state.tasks.find((t) => t.id === d)).filter((t) => t?.result);
    const messages = takeMessages(state, me);
    return [
      `${lead} task #${task.id}. Start working on it now.`,
      fmtTaskFull(task),
      deps.length && `Results of dependencies:\n${deps.map((d) => `  #${d.id} ${d.title}: ${d.result}`).join("\n")}`,
      messages.length && `Unread messages:\n${messages.map(fmtMessage).join("\n")}`,
      "Work on your own: don't ask the user for approval and don't wait for them to review a plan, because the manager already assigned this task. If something is unclear, make a sensible choice and say so in your result, or ask the manager with message_send and keep going.",
      `Lock the files you edit with file_lock(action="lock", paths=[...], task_id=${task.id}). When the work is done and verified, call task_update(task_id=${task.id}, status="done", result="what changed, which files, how to verify"), then call task_claim for your next task.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // The MCP client on the other end, by the name it sent in the handshake. Wait lengths are learned per client.
  function clientName() {
    return process.env.SWARM_CLIENT || server.server.getClientVersion()?.name || "unknown";
  }
  let activeWait = null; // the waiting call this connection is blocked in, if any

  /**
   * Block until check() returns something, for as long as this client allows (see waits.js).
   * The agent shows as "waiting for work" meanwhile. Returns { result, seconds }.
   */
  async function waitUntil(s, check, requested, extra) {
    const client = clientName();
    const { normal, max } = waitPolicy(client);
    const seconds = Math.max(1, Math.min(requested ?? normal, max));
    // A new wait while the old one is still running means the client gave up on the old call
    // without saying so (a silent timeout). Learn from it and let the old call go.
    if (activeWait) {
      recordWait(client, (Date.now() - activeWait.start) / 1000, "cancelled");
      activeWait.dropped = true;
    }
    const me = { start: Date.now(), dropped: false };
    activeWait = me;
    await s.store.update((state) => {
      touch(state, s.name).waitingUntil = new Date(Date.now() + seconds * 1000).toISOString();
    });
    try {
      const result = await waitFor(check, seconds, extra, () => me.dropped);
      if (extra?.signal?.aborted) recordWait(client, (Date.now() - me.start) / 1000, "cancelled");
      else if (!result && !me.dropped && seconds >= normal) recordWait(client, seconds, "completed");
      return { result, seconds };
    } finally {
      if (activeWait === me) activeWait = null;
      await s.store
        .update((state) => {
          if (state.agents[s.name] && activeWait === null) delete state.agents[s.name].waitingUntil;
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- identity

  server.registerTool(
    "swarm_join",
    {
      title: "Join swarm",
      description:
        "Join (or rejoin) a swarm of cooperating coding agents. Call this first. Pick a short unique name (e.g. 'claude', 'codex', 'antigravity') and a role: 'manager' plans and assigns work, 'worker' claims and completes tasks, 'reviewer' checks finished work. Returns the team, the task board and your role's playbook.",
      inputSchema: {
        name: z.string().min(1).max(40).describe("Your unique agent name in the swarm, e.g. 'claude', 'codex-1'"),
        role: z.string().min(1).max(40).describe("manager | worker | reviewer (or any custom role)"),
        swarm: z.string().optional().describe("Swarm name to join. Defaults to 'default'. Agents must use the same name to see each other."),
        client: z.string().optional().describe("Which tool you are, e.g. 'Claude Code', 'Codex', 'Antigravity'"),
        about: z.string().optional().describe("One line about your strengths or focus, e.g. 'frontend + tests'"),
        goal: z.string().optional().describe("Managers: the overall goal of the swarm"),
      },
    },
    async (args) => {
      try {
        const r = await join(args);
        const role = PLAYBOOKS[args.role.toLowerCase()] ? args.role.toLowerCase() : "worker";
        const parts = [`${r.rejoined ? "Rejoined" : "Joined"} as "${session.name}" (${args.role}).`];
        if (role === "manager" && r.managers.length)
          parts.push(
            `WARNING: ${r.managers.join(", ")} is already the manager of this swarm. Unless the user asked for two managers, call swarm_join again with role="worker".`,
          );
        parts.push(r.summary, `Unread messages: ${r.unread}`, PLAYBOOKS[role]);
        if (role === "worker")
          parts.push(
            r.mine.length
              ? `You have ${ids(r.mine)} in progress from before. Continue it now (task_list task_id=N shows the details).`
              : "Next: call task_claim now. If there is no task yet it waits for one.",
          );
        return text(parts.join("\n\n"));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    "swarm_status",
    {
      title: "Swarm status",
      description: "Overview of the swarm: goal, agents (and who is working on what), open tasks, file locks, shared note keys.",
      inputSchema: {},
    },
    tool(async (_args, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name);
        const unread = inboxFor(state, s.name);
        return `${summarize(state, s.name)}\n\nUnread: ${unread.messages.length} messages, ${unread.events.length} events (call swarm_inbox).`;
      });
      return text(out);
    }),
  );

  server.registerTool(
    "swarm_leave",
    {
      title: "Leave swarm",
      description: "Mark yourself offline and release your file locks. Your in-progress tasks go back to todo unless keep_tasks is true.",
      inputSchema: { keep_tasks: z.boolean().optional() },
    },
    tool(async ({ keep_tasks }, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name).status = "offline";
        for (const [p, l] of Object.entries(state.locks)) if (l.by === s.name) delete state.locks[p];
        let released = 0;
        if (!keep_tasks)
          for (const t of state.tasks)
            if (t.assignee === s.name && t.status === "in_progress") {
              t.status = "todo";
              t.assignee = null;
              t.updatedAt = now();
              released++;
            }
        pushEvent(state, s.name, "leave", `${s.name} left the swarm${released ? `, released ${released} task(s)` : ""}`);
        return `Left swarm "${state.swarm}". Released ${released} task(s).`;
      });
      return text(out);
    }),
  );

  // ------------------------------------------------------------------ tasks

  server.registerTool(
    "task_create",
    {
      title: "Create tasks",
      description:
        "Add one or more tasks to the shared board (usually the manager does this). Give each a clear title, a description with acceptance criteria and the files/area it owns, and optionally an assignee and dependencies. In depends_on you can reference existing task ids (numbers) or earlier tasks in this same batch as \"$1\", \"$2\", ...",
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string().min(1),
              description: z.string().optional(),
              assignee: z.string().optional().describe("Agent name; omit to let any worker claim it"),
              depends_on: z.array(z.union([z.number().int(), z.string()])).optional(),
              priority: z.enum(["high", "normal", "low"]).optional(),
            }),
          )
          .min(1),
      },
    },
    tool(async ({ tasks }, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name);
        const created = [];
        const warnings = [];
        for (const spec of tasks) {
          const dependsOn = (spec.depends_on || []).map((d) => {
            if (typeof d === "string" && /^\$\d+$/.test(d)) {
              const ref = created[Number(d.slice(1)) - 1];
              if (!ref) throw new Error(`depends_on "${d}" must point to an earlier task in this batch`);
              return ref.id;
            }
            const id = Number(String(d).replace(/^#/, ""));
            if (!state.tasks.some((t) => t.id === id) && !created.some((t) => t.id === id)) throw new Error(`Unknown task #${d} in depends_on`);
            return id;
          });
          const assignee = spec.assignee?.trim().toLowerCase() || null;
          if (assignee && !state.agents[assignee]) warnings.push(`"${assignee}" has not joined yet; the task will wait for them.`);
          else if (assignee && seemsStopped(state, state.agents[assignee]))
            warnings.push(
              `${assignee} is ${agentState(state, state.agents[assignee])}, so it won't see new tasks until the user tells it to continue. Assign them to an agent that is waiting for work, or ask the user to nudge ${assignee}.`,
            );
          state.seq.task += 1;
          const task = {
            id: state.seq.task,
            title: spec.title,
            description: spec.description || "",
            status: "todo",
            priority: spec.priority || "normal",
            assignee,
            dependsOn,
            createdBy: s.name,
            createdAt: now(),
            updatedAt: now(),
            notes: [],
            result: null,
          };
          state.tasks.push(task);
          created.push(task);
          delete state.finishedAt; // new work reopens a finished swarm
          pushEvent(state, s.name, "task_created", `${s.name} created ${fmtTask(task)}`, { taskId: task.id, assignee });
        }
        return `Created ${created.length} task(s):\n${created.map((t) => `  ${fmtTask(t)}`).join("\n")}${warnings.length ? `\n\nNote: ${[...new Set(warnings)].join(" ")}` : ""}`;
      });
      return text(out);
    }),
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List tasks on the board with full details. Filter by status and/or assignee ('me' for yourself).",
      inputSchema: {
        status: z.enum(TASK_STATUSES).optional(),
        assignee: z.string().optional().describe("Agent name, 'me', or 'none' for unassigned"),
        task_id: z.number().int().optional().describe("Show a single task"),
      },
    },
    tool(async ({ status, assignee, task_id }, s) => {
      const out = await s.store.view((state) => {
        let tasks = state.tasks;
        if (task_id) tasks = tasks.filter((t) => t.id === task_id);
        if (status) tasks = tasks.filter((t) => t.status === status);
        if (assignee) {
          const who = assignee.toLowerCase() === "me" ? s.name : assignee.toLowerCase();
          tasks = tasks.filter((t) => (who === "none" ? !t.assignee : t.assignee === who));
        }
        return tasks.length ? tasks.map(fmtTaskFull).join("\n\n") : "No matching tasks.";
      });
      return text(out);
    }),
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim a task",
      description:
        "Get a task to work on and mark it in_progress. With no task_id you get the best available one (assigned to you first, then high priority, then oldest; its dependencies must be done). If there is no task yet, it waits until the manager posts one or someone messages you, for as long as your app allows a tool call to run (learned automatically). When it returns without a task, or times out, call it again. You can hold one in-progress task at a time.",
      inputSchema: {
        task_id: z.number().int().optional(),
        wait_seconds: z
          .number()
          .min(0)
          .max(3600)
          .optional()
          .describe("Leave unset to wait as long as your app allows. 0 = don't wait."),
      },
    },
    tool(async ({ task_id, wait_seconds }, s, extra) => {
      let reply = await s.store.update((state) => claimOnce(state, s.name, task_id));
      let waited = 0;
      if (reply === null && !task_id && wait_seconds !== 0) {
        const r = await waitUntil(
          s,
          async () => {
            const ready = await s.store.view(
              (state) => member(state, s.name) && (claimable(state, s.name).length > 0 || inboxFor(state, s.name).messages.length > 0),
            );
            // Another agent can grab the task first; claimOnce then returns null and the wait goes on.
            return ready ? s.store.update((state) => claimOnce(state, s.name)) : null;
          },
          wait_seconds,
          extra,
        );
        reply = r.result;
        waited = r.seconds;
      }
      return text(
        reply ??
          `No task for you yet${waited ? ` (waited ${waited}s)` : ""}. Call task_claim again now to keep waiting. Don't end your turn or ask the user; the manager posts work here. ${IF_TIMEOUT}`,
      );
    }),
  );

  server.registerTool(
    "task_update",
    {
      title: "Update a task",
      description:
        "Change a task's status, add a progress note, record the result, or (re)assign it. Statuses: todo, in_progress, blocked, review, done, cancelled. When finishing, set status 'done' (or 'review' if a reviewer should check it) and put a concise summary in result.",
      inputSchema: {
        task_id: z.number().int(),
        status: z.enum(TASK_STATUSES).optional(),
        note: z.string().optional().describe("Progress note / question / blocker reason"),
        result: z.string().optional().describe("Final summary: what changed, where, how to verify"),
        assignee: z.string().optional().describe("Reassign; use 'none' to unassign"),
        title: z.string().optional(),
        description: z.string().optional(),
      },
    },
    tool(async ({ task_id, status, note, result, assignee, title, description }, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name);
        const task = state.tasks.find((t) => t.id === task_id);
        if (!task) throw new Error(`No task #${task_id}`);
        const changes = [];
        if (title) task.title = title;
        if (description) task.description = description;
        if (assignee) {
          task.assignee = assignee.toLowerCase() === "none" ? null : assignee.trim().toLowerCase();
          if (task.status === "in_progress" && task.assignee !== s.name) task.status = "todo";
          changes.push(`assigned to ${task.assignee || "nobody"}`);
        }
        if (status) {
          task.status = status;
          changes.push(status);
        }
        if (result) {
          task.result = result;
          changes.push("result recorded");
        }
        if (note) {
          task.notes.push({ by: s.name, at: now(), text: note });
          changes.push(`note: ${note}`);
        }
        task.updatedAt = now();
        if (status === "done" || status === "cancelled")
          for (const [p, l] of Object.entries(state.locks)) if (l.taskId === task.id) delete state.locks[p];
        pushEvent(state, s.name, `task_${status || "updated"}`, `${s.name} updated #${task.id} ${task.title}: ${changes.join("; ") || "edited"}${result ? ` — ${result}` : ""}`, {
          taskId: task.id,
        });
        let tail = "";
        if (status === "done") {
          const unblocked = state.tasks.filter((t) => t.status === "todo" && t.dependsOn.includes(task.id) && depsDone(state, t));
          if (unblocked.length) tail += `\nUnblocked: ${unblocked.map(fmtTask).join("; ")}`;
        }
        if (assignee && task.assignee && state.agents[task.assignee] && seemsStopped(state, state.agents[task.assignee]))
          tail += `\nNote: ${task.assignee} is ${agentState(state, state.agents[task.assignee])}, so it won't pick this up until the user tells it to continue.`;
        const handedBack = ["done", "review", "blocked", "cancelled"].includes(status);
        if (handedBack && task.assignee === s.name && !state.tasks.some((t) => t.assignee === s.name && t.status === "in_progress"))
          tail += "\n\nNext: call task_claim to get your next task. It waits until one is available, so don't end your turn.";
        return `Updated:\n${fmtTaskFull(task)}${tail}`;
      });
      return text(out);
    }),
  );

  // --------------------------------------------------------------- messages

  server.registerTool(
    "message_send",
    {
      title: "Send message",
      description:
        "Send a message to another agent by name, to everyone with a role (e.g. 'manager', 'worker'), to a comma-separated list, or to 'all'. Use it for questions, hand-offs, interface contracts and status reports.",
      inputSchema: {
        to: z.string().describe("Agent name, role name, comma-separated names, or 'all'"),
        content: z.string().min(1),
      },
    },
    tool(async ({ to, content }, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name);
        let recipients;
        if (to.trim().toLowerCase() === "all") recipients = "*";
        else {
          recipients = [];
          for (const raw of to.split(",")) {
            const key = raw.trim().toLowerCase();
            if (!key) continue;
            if (state.agents[key]) recipients.push(key);
            else {
              const byRole = Object.values(state.agents).filter((a) => a.role.toLowerCase() === key && a.name !== s.name).map((a) => a.name);
              recipients.push(...(byRole.length ? byRole : [key])); // unknown name: delivered when they join
            }
          }
          recipients = [...new Set(recipients)];
        }
        state.seq.message += 1;
        const msg = { id: state.seq.message, at: now(), from: s.name, to: recipients, content };
        state.messages.push(msg);
        pushEvent(state, s.name, "message", `${s.name} messaged ${recipients === "*" ? "all" : recipients.join(",")}`);
        const unknown = recipients === "*" ? [] : recipients.filter((r) => !state.agents[r]);
        const busy = state.tasks.some((t) => t.assignee === s.name && t.status === "in_progress");
        const next =
          member(state, s.name).role.toLowerCase() === "manager"
            ? "Then call swarm_inbox to watch for replies and progress."
            : busy
              ? "Keep working on your task meanwhile; replies show up in swarm_inbox."
              : "Then call task_claim; it wakes up when someone replies or posts work.";
        return `Sent message #${msg.id} to ${recipients === "*" ? "all" : recipients.join(", ")}.${unknown.length ? ` (${unknown.join(", ")} not joined yet — they'll get it when they join.)` : ""} ${next}`;
      });
      return text(out);
    }),
  );

  server.registerTool(
    "swarm_inbox",
    {
      title: "Check inbox / wait for activity",
      description:
        "Get unread messages for you plus board activity from other agents (tasks created, claimed, finished, agents joining), and mark them read. Managers also get alerts about assigned work nobody is doing. If nothing is new it waits for activity, for as long as your app allows a tool call to run (learned automatically); wait_seconds=0 checks instantly. This is how the manager watches the board; workers wait for work with task_claim instead.",
      inputSchema: {
        wait_seconds: z.number().min(0).max(3600).optional().describe("Leave unset to wait as long as your app allows. 0 = don't wait."),
      },
    },
    tool(async ({ wait_seconds }, s, extra) => {
      let wait = 0;
      const isManager = (state) => member(state, s.name).role.toLowerCase() === "manager";
      const newAlerts = (state) =>
        isManager(state) ? stallAlerts(state, s.name).filter((x) => !(member(state, s.name).alerted || []).includes(x.key)) : [];
      const pending = (state) => {
        const box = inboxFor(state, s.name);
        return box.messages.length + box.events.length + newAlerts(state).length > 0;
      };
      if (wait_seconds !== 0 && !(await s.store.view(pending)))
        wait = (await waitUntil(s, () => s.store.view(pending), wait_seconds, extra)).seconds;
      const out = await s.store.update((state) => {
        const agent = touch(state, s.name);
        const { messages, events } = inboxFor(state, s.name);
        const alerts = newAlerts(state);
        agent.msgCursor = state.seq.message;
        agent.eventCursor = state.seq.event;
        agent.alerted = [...(agent.alerted || []), ...alerts.map((x) => x.key)].slice(-50);
        const next = isManager(state) ? null : claimable(state, s.name)[0];
        const open = state.tasks.some((t) => !["done", "cancelled"].includes(t.status));
        const after = isManager(state)
          ? open
            ? "Then call swarm_inbox again to keep watching. Don't end your turn while there is open work."
            : "If the goal is met and verified, tell everyone to stop and report to the user. Otherwise create the next tasks."
          : next
            ? `Task available: ${fmtTask(next)}. Call task_claim.`
            : "Then call task_claim to wait for work. Don't end your turn.";
        if (!messages.length && !events.length && !alerts.length) return `Nothing new${wait ? ` after ${wait}s` : ""}. ${after} ${IF_TIMEOUT}`;
        const parts = [];
        if (alerts.length) parts.push(`Needs attention:\n${alerts.map((x) => `  ${x.text}`).join("\n")}`);
        if (messages.length) parts.push(`Messages (${messages.length}):\n${messages.map(fmtMessage).join("\n")}`);
        if (events.length) parts.push(`Activity (${events.length}):\n${events.map((e) => `  ${e.at} ${e.text}`).join("\n")}`);
        parts.push(after);
        return parts.join("\n\n");
      });
      return text(out);
    }),
  );

  // ----------------------------------------------------------- shared notes

  server.registerTool(
    "note_set",
    {
      title: "Write shared note",
      description:
        "Write to the shared notes board — durable context every agent can read: architecture decisions, API contracts, conventions, how to run tests. Overwrites the key unless append is true.",
      inputSchema: {
        key: z.string().min(1).max(80),
        value: z.string().describe("Note content. Empty string deletes the note."),
        append: z.boolean().optional(),
      },
    },
    tool(async ({ key, value, append }, s) => {
      const out = await s.store.update((state) => {
        touch(state, s.name);
        if (!value) {
          delete state.notes[key];
          pushEvent(state, s.name, "note", `${s.name} deleted note "${key}"`);
          return `Deleted note "${key}".`;
        }
        const prev = state.notes[key]?.value;
        state.notes[key] = { value: append && prev ? `${prev}\n${value}` : value, by: s.name, at: now() };
        pushEvent(state, s.name, "note", `${s.name} ${prev ? "updated" : "wrote"} note "${key}"`);
        return `Saved note "${key}".`;
      });
      return text(out);
    }),
  );

  server.registerTool(
    "note_get",
    {
      title: "Read shared notes",
      description: "Read a shared note by key, or all notes when key is omitted.",
      inputSchema: { key: z.string().optional() },
    },
    tool(async ({ key }, s) => {
      const out = await s.store.view((state) => {
        const entries = key ? [[key, state.notes[key]]].filter(([, v]) => v) : Object.entries(state.notes);
        if (!entries.length) return key ? `No note "${key}".` : "No shared notes yet.";
        return entries.map(([k, v]) => `## ${k}  (by ${v.by}, ${v.at})\n${v.value}`).join("\n\n");
      });
      return text(out);
    }),
  );

  // ------------------------------------------------------------- file locks

  server.registerTool(
    "file_lock",
    {
      title: "Lock / unlock files",
      description:
        "Advisory locks so two agents don't edit the same files at once. action 'lock' claims paths; if another agent holds one, it waits until that agent releases it (for as long as your app allows a tool call to run). 'unlock' releases paths, 'list' shows all locks. Locks tied to a task are released when the task is done, and locks held by an agent inactive for 10+ minutes are freed automatically.",
      inputSchema: {
        action: z.enum(["lock", "unlock", "list"]),
        paths: z.array(z.string()).optional().describe("File or directory paths, relative to the repo root. For unlock, omit to release all of yours."),
        task_id: z.number().int().optional().describe("Tie the lock to a task so it auto-releases when the task is done"),
        wait_seconds: z.number().min(0).max(3600).optional().describe("lock only: leave unset to wait for a held lock. 0 = don't wait."),
      },
    },
    tool(async ({ action, paths = [], task_id, wait_seconds }, s, extra) => {
      const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
      const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      // Lock under the store lock: the reply, or null while another agent holds one of the paths.
      const tryLock = (state) => {
        touch(state, s.name);
        const wanted = paths.map(norm);
        for (const [held, l] of Object.entries(state.locks))
          if (l.by !== s.name && (!state.agents[l.by] || !isActive(state.agents[l.by]))) delete state.locks[held]; // holder went away
        const blocked = Object.entries(state.locks).some(([held, l]) => l.by !== s.name && wanted.some((p) => overlaps(p, held)));
        if (blocked) return null;
        for (const p of wanted) state.locks[p] = { by: s.name, at: now(), taskId: task_id ?? null };
        pushEvent(state, s.name, "lock", `${s.name} locked ${wanted.join(", ")}`);
        return `Locked: ${wanted.join(", ")}. Go ahead and edit them.`;
      };
      if (action === "lock") {
        if (!paths.length) return fail("Give at least one path to lock");
        let reply = await s.store.update(tryLock);
        let waited = 0;
        if (reply === null && wait_seconds !== 0) {
          const r = await waitUntil(s, () => s.store.update(tryLock), wait_seconds, extra);
          reply = r.result;
          waited = r.seconds;
        }
        if (reply) return text(reply);
        const holders = await s.store.view((state) =>
          Object.entries(state.locks)
            .filter(([held, l]) => l.by !== s.name && paths.map(norm).some((p) => overlaps(p, held)))
            .map(([held, l]) => `${held} (held by ${l.by})`),
        );
        return text(
          `Still locked${waited ? ` after waiting ${waited}s` : ""}: ${holders.join("; ")}. Call file_lock again to keep waiting, or message the holder and work on another part of your task meanwhile. Don't end your turn. ${IF_TIMEOUT}`,
        );
      }
      const out = await s.store.update((state) => {
        touch(state, s.name);
        if (action === "list") {
          const all = Object.entries(state.locks);
          return all.length ? all.map(([p, l]) => `${p} — ${l.by}${l.taskId ? ` (#${l.taskId})` : ""} since ${l.at}`).join("\n") : "No file locks.";
        }
        if (action === "unlock") {
          const targets = paths.length ? paths.map(norm) : Object.keys(state.locks).filter((p) => state.locks[p].by === s.name);
          const freed = targets.filter((p) => state.locks[p]?.by === s.name);
          for (const p of freed) delete state.locks[p];
          if (freed.length) pushEvent(state, s.name, "unlock", `${s.name} unlocked ${freed.join(", ")}`);
          return freed.length ? `Unlocked: ${freed.join(", ")}` : "Nothing to unlock.";
        }
      });
      return text(out);
    }),
  );

  server.registerTool(
    "swarm_finish",
    {
      title: "Finish the swarm",
      description:
        "Manager only: end the swarm once the goal is met and verified. Tells every agent to stop (and lets them stop), keeping the board for reference. Creating a new task reopens it.",
      inputSchema: { summary: z.string().min(1).describe("What was achieved, for the team") },
    },
    tool(async ({ summary }, s) => {
      const out = await s.store.update((state) => {
        if (touch(state, s.name).role.toLowerCase() !== "manager") throw new Error("Only the manager can finish the swarm.");
        const open = state.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
        state.finishedAt = now();
        state.seq.message += 1;
        state.messages.push({ id: state.seq.message, at: now(), from: s.name, to: "*", content: `The swarm is finished: ${summary} Stop working now.` });
        pushEvent(state, s.name, "finish", `${s.name} finished the swarm: ${summary}`);
        return `Swarm "${state.swarm}" is finished and everyone was told to stop.${open.length ? ` Note: ${ids(open)} ${open.length > 1 ? "were" : "was"} still open.` : ""} Now report to the user.`;
      });
      return text(out);
    }),
  );

  server.registerTool(
    "swarm_reset",
    {
      title: "Reset swarm",
      description: "Wipe the swarm's tasks, messages, notes and agents to start a fresh project. Only do this when the user asks.",
      inputSchema: { confirm: z.literal(true) },
    },
    tool(async (_args, s) => {
      const { store } = s;
      await store.reset();
      session.store = null;
      session.name = null;
      return text(`Swarm "${store.swarm}" was reset. Everyone (you included) must swarm_join again.`);
    }),
  );

  // ---------------------------------------------------------------- prompts

  server.registerPrompt(
    "manager",
    {
      title: "Be the swarm manager",
      description: "Plan a goal, split it into tasks and coordinate the other agents",
      argsSchema: { goal: z.string().describe("What the team should build or fix"), swarm: z.string().optional() },
    },
    ({ goal, swarm }) => ({ messages: [{ role: "user", content: { type: "text", text: managerPrompt(goal, swarm) } }] }),
  );

  server.registerPrompt(
    "worker",
    {
      title: "Be a swarm worker",
      description: "Join the swarm and keep claiming and finishing tasks",
      argsSchema: { name: z.string().describe("Your agent name, e.g. codex"), swarm: z.string().optional() },
    },
    ({ name, swarm }) => ({ messages: [{ role: "user", content: { type: "text", text: workerPrompt(name, swarm) } }] }),
  );

  server.registerPrompt(
    "reviewer",
    {
      title: "Be a swarm reviewer",
      description: "Join the swarm and review tasks other agents finished",
      argsSchema: { name: z.string().describe("Your agent name"), swarm: z.string().optional() },
    },
    ({ name, swarm }) => ({ messages: [{ role: "user", content: { type: "text", text: reviewerPrompt(name, swarm) } }] }),
  );

  return server;
}
