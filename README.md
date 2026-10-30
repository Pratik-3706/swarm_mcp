# swarm-mcp

An MCP server that lets several AI coding agents work on the same project as a team. It works with any agent that supports MCP tools, such as **Claude Code, Codex, Antigravity, Cursor, Gemini CLI, Windsurf or Claude Desktop**. Nothing in it depends on a particular app. One agent is the manager, the others are workers. They share:

- a **task board** (create, claim, update tasks, with dependencies and priorities)
- **messages** (direct, by role, or to everyone)
- **shared notes** (plan, API contracts, conventions)
- **file locks** so two agents don't edit the same files at once

There's no server for you to start. Each agent's app launches its own copy of swarm-mcp when it starts. The copies coordinate through one shared file in `~/.swarm-mcp/`, so there are no ports and no daemon.

## Install (one time)

Requires Node.js 18+ and git.

```bash
git clone https://github.com/Pratik-3706/swarm_mcp.git
cd swarm_mcp
npm run setup
```

`npm run setup` installs dependencies and sets swarm-mcp up in every agent app it finds. Restart those apps afterwards. It backs up each file it changes to `<file>.swarm-backup`, and `node src/index.js uninstall` reverses everything.

**Or let an agent do it.** Paste this into any coding agent:

> Set up swarm-mcp from https://github.com/Pratik-3706/swarm_mcp: clone it into my home folder, run `npm run setup` in it, and tell me which apps to restart.

For each app it finds, setup does three things:

1. **Registers the MCP server**, so the swarm tools appear in the app.
2. **Adds a Stop hook**, in apps with Claude-style hooks (Claude Code, Codex, Antigravity IDE). It keeps a joined agent from ending its turn while the swarm still needs it. See [Staying in the swarm](#staying-in-the-swarm). Skip it with `--no-hooks`. **Codex asks you once to trust new hooks: approve the two swarm ones.**
3. **Adds a short note to the app's global instructions file.** If an agent is asked to join the swarm before its app has loaded the MCP tools, the note tells it to use the [shell fallback](#agents-without-the-mcp-tools) instead of giving up. Skip it with `--no-instructions`.

| `--only` name | Agent | MCP config | Hook / instructions |
|---|---|---|---|
| `claude` | Claude Code | user scope, via `claude mcp add-json` | `~/.claude/settings.json`, `~/.claude/CLAUDE.md` |
| `codex` | Codex | `~/.codex/config.toml` | `~/.codex/hooks.json`, `~/.codex/AGENTS.md` |
| `antigravity-ide` | Antigravity IDE | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/hooks.json`, `~/.gemini/config/GEMINI.md` |
| `antigravity` | Antigravity | `~/.gemini/antigravity/mcp_config.json` | |
| `gemini` | Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |
| `cursor` | Cursor | `~/.cursor/mcp.json` | |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` | |
| `claude-desktop` | Claude Desktop (chat) | `claude_desktop_config.json` | |

```bash
node src/index.js install --dry-run                              # show what it would change
node src/index.js install --only claude,codex,antigravity-ide    # only some agents
node src/index.js uninstall                                      # remove it everywhere
```

## Use it

Open the same project in each agent and tell them their role.

**Manager** (e.g. Claude Code):

> You are the swarm manager. Goal: add user login with email + password, with tests.

**Workers** (Codex, Antigravity, ...). Give each one a different name:

> Join the swarm as a worker named codex.

> Join the swarm as a worker named antigravity.

**Reviewer** (optional):

> Join the swarm as the reviewer.

That's all. The server tells each agent its playbook when it joins:

- The **manager** reads the repo, writes the plan to shared notes, splits the goal into tasks (each with its own files and acceptance criteria), assigns them, then watches the board and answers questions. When the goal is met and verified, it calls `swarm_finish`, which tells everyone to stop.
- **Workers** loop: claim a task, lock its files, do the work, mark it done with a summary, claim the next one. If there's no task yet, the claim waits until the manager posts one, so a worker that joins early or finishes first doesn't stop. A worker holds one task at a time.
- The **reviewer** checks tasks in `review` and either approves them or sends them back with notes.
- Agents are told to work on their own: no asking you for approval. Questions go to the manager.
- **Messages reach busy agents mid-task.** An agent doesn't have to be waiting in `swarm_inbox` to get a message:
  - **Any MCP agent:** unread messages are attached to the result of whatever swarm call it makes next. Workers are told to check between steps of a long task.
  - **Apps with the hook:** the hook also injects new messages after every tool the agent uses, such as a file edit or a shell command.

  Either way, each message is delivered once, marked as a "NEW SWARM MESSAGE", and the agent is told to act on it before continuing.
- The manager can see whether each agent is *waiting for work*, *working on #N*, or *idle (probably stopped)*. It gets an alert when work is assigned to an agent that stopped, so it can reassign the work or tell you which agent to nudge.

In Claude Code the prompts are also slash commands: `/mcp__swarm__manager`, `/mcp__swarm__worker`, `/mcp__swarm__reviewer`.

### Agents without the MCP tools

Most apps load MCP servers only when they start. If you ask an agent to join before restarting its app, or the agent has a shell but no MCP support, it can run every swarm tool from the shell. Each call behaves exactly like the MCP tool:

```bash
node src/index.js call swarm_join --as codex --role worker
node src/index.js call task_claim --as codex
node src/index.js call task_update --as codex --task_id 3 --status done --result "Added the login form"
```

Arguments go as `--key value`, or as one JSON object such as `'{"tasks":[...]}'`. Use the `--key value` form on Windows PowerShell, which mangles quotes inside JSON passed to programs. The instructions note that setup adds tells agents about this, so you don't have to.

### Antigravity keeps asking you before working?

That comes from Antigravity's own approval settings, not from the swarm. In Antigravity's Settings:

- **Review Policy** → *Always Proceed*: it stops waiting for you to review its plan.
- **Terminal Command Auto Execution** → *Always Proceed* (or *Auto*): it stops asking before running commands.
- **Terminal & Tooling Permissions → MCP Tools** → allow `swarm`: it can call the swarm tools without asking each time.

These settings let the agent act without your sign-off, so only use them on projects where that's fine.

### Watch the team from a terminal

```bash
npm run status
```

This shows a live board: agents, who's working on what, open tasks, locks and recent activity.

### Several projects at once

Each swarm has a name (default `default`). Use a different one per project, for example *"Join swarm `shop-app` as a worker named codex"*. Use `node src/index.js status --swarm shop-app` to watch it. To start over, run `node src/index.js reset` or ask the manager to reset the swarm.

## Tools

| Tool | What it does |
|---|---|
| `swarm_join` | Join with a name and role; returns the team, the board and your playbook |
| `swarm_status` | Overview of agents, tasks, locks, notes |
| `task_create` | Add tasks (batch), with `assignee`, `priority`, `depends_on` (`"$1"` = first task in the batch) |
| `task_list` | Task details, filtered by status, assignee or id |
| `task_claim` | Take the best available task (or a specific one). Waits for one if there's none yet. One task at a time |
| `task_update` | Status (`todo / in_progress / blocked / review / done / cancelled`), notes, result, reassign |
| `message_send` | Message an agent, a role (`manager`, `worker`), a list, or `all` |
| `swarm_inbox` | Unread messages and board activity. Waits until something arrives |
| `note_set` / `note_get` | Shared notes |
| `file_lock` | Lock, unlock or list advisory file locks. Locking a held file waits until it's free. Locks are released when the task is done, or when their holder has been inactive for 10 minutes |
| `swarm_finish` | Manager only: end the swarm and tell everyone to stop. A new task reopens it |
| `swarm_leave` / `swarm_reset` | Go offline / wipe the swarm |

## Staying in the swarm

An agent only works while its app is running a turn, and the app decides when the turn ends. swarm-mcp keeps agents going in two layers.

**1. In the MCP server (every agent):**
- **Idle agents wait inside a call.** When there's nothing to do, `task_claim`, `swarm_inbox` and `file_lock` wait until something happens.
- **No dead ends.** Every reply ends with the next tool to call. The instructions say a timeout is a reason to call again, not to stop.
- **The wait adapts to each app.** Apps cut off long tool calls at different points, and some agents give up after a timeout error. So the server learns each app's limit from the name it sends when it connects, and stores it in `~/.swarm-mcp/clients.json`. It starts at 45 seconds and doubles after each full wait, up to 30 minutes. If a call gets cancelled, it drops back below that point, and a second cancel at about the same point becomes a hard cap. Progress pings go out every 5 seconds for apps that use them to keep a call alive.

**2. A Stop hook (apps with Claude-style hooks: Claude Code, Codex, Antigravity IDE):**
- When a joined agent is about to end its turn, the hook tells it to keep going: workers call `task_claim`, the manager calls `swarm_inbox`.
- It only acts on conversations that joined a swarm. A `PostToolUse` hook records which conversation is which agent when it calls `swarm_join`, so your other chats in the same app aren't affected. The same hook delivers messages after each tool use.
- It lets the agent stop when:
  - the manager has called `swarm_finish`
  - the agent called `swarm_leave` (the instructions tell agents to do this when you ask them to stop)
  - the swarm has been quiet for 2 hours
  - the agent ignored the hook twice in a row without touching the swarm, which guards against endless loops

If an agent still ends its turn, the manager sees it as stopped and gets an alert. Tell that agent "keep working in the swarm" and it picks up where it left off.

## Manual config

If your agent isn't detected, add this to its MCP config (use your own path):

```json
{
  "mcpServers": {
    "swarm": {
      "command": "node",
      "args": ["C:/path/to/swarm_mcp/src/index.js"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.swarm]
command = "node"
args = ['C:\path\to\swarm_mcp\src\index.js']
tool_timeout_sec = 3700
```

For an app with Claude-style hooks, the Stop hook is `node "<path>/src/index.js" hook stop`. It also needs `node "<path>/src/index.js" hook post-tool` as a `PostToolUse` hook.

Optional env vars:

- `SWARM_AGENT` + `SWARM_ROLE`: join automatically under a fixed name.
- `SWARM_NAME`: the default swarm.
- `SWARM_MCP_HOME`: where state is stored (default `~/.swarm-mcp`).
- `SWARM_WAIT_SECONDS`: a fixed wait for `task_claim`, `swarm_inbox` and `file_lock`, which turns off the learning. The shell fallback uses 90s by default. `SWARM_MAX_WAIT_SECONDS`: the most it will ever learn (1800).
- `SWARM_IDLE_SECONDS`: how long an agent with no task and no wait counts as active before it's shown as stopped (90).
- `SWARM_CLIENT`: the client's display name. By default it's the name the client sends when it connects.

## Notes

- After updating swarm-mcp, restart the agents. Each one keeps running the server code it started with.
- File locks are advisory. They stop well-behaved agents from colliding, not the filesystem.

## Test

```bash
npm test
```

- `test/smoke.js` starts three server processes (a manager and two workers) and checks:
  - concurrent claims, dependencies, locks, messages and notes
  - the one-task-at-a-time rule, and that a held file lock waits until it's released
  - that a waiting worker gets a task posted later, and that a message also wakes it
  - that a busy agent gets a message with its next swarm call, exactly once
  - progress pings and cancellation, and that the wait length is learned from a cancelled or silently dropped call
  - the second-manager warning and the alert about work sitting with a stopped agent
- `test/hooks.js` checks:
  - the shell fallback
  - the Stop hook: who it holds back, the loop guard, and `swarm_leave` / `swarm_finish`
  - that messages are injected after any tool use, and when stopping
  - that the installer adds hooks and instructions without touching your own settings, and removes them cleanly
