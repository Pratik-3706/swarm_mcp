// Optional extras the installer adds next to the MCP registration:
//  - Stop hooks for apps with Claude-style hooks, so a joined agent can't end its turn mid-swarm (see hook.js).
//  - A short block in each agent's global instruction file, so an agent asked to join the swarm in an app
//    that hasn't loaded the MCP server yet uses the shell fallback (cli.js) instead of giving up.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const MARK_START = "<!-- swarm-mcp:start -->";
const MARK_END = "<!-- swarm-mcp:end -->";

// format "claude": { hooks: { Event: [{ matcher?, hooks: [{type, command, timeout}] }] } } (Claude Code, Codex)
// format "antigravity": { <name>: { enabled, Event: [{ matcher?, hooks: [...] }] } }
// The PostToolUse hook runs after every tool ("*"): it notes swarm_join / swarm_leave, and hands a joined
// agent any messages that arrived while it was busy. For conversations outside a swarm it does nothing.
const HOOK_TARGETS = [
  { id: "claude", app: "Claude Code", file: path.join(HOME, ".claude", "settings.json"), format: "claude", matcher: "*" },
  { id: "codex", app: "Codex", file: path.join(CODEX_HOME, "hooks.json"), format: "claude", matcher: "*" },
  { id: "antigravity-ide", app: "Antigravity IDE", file: path.join(HOME, ".gemini", "config", "hooks.json"), format: "antigravity", matcher: "*" },
];

const INSTRUCTION_TARGETS = [
  { id: "claude", app: "Claude Code", file: path.join(HOME, ".claude", "CLAUDE.md") },
  { id: "codex", app: "Codex", file: path.join(CODEX_HOME, "AGENTS.md") },
  { id: "antigravity-ide", app: "Antigravity IDE", file: path.join(HOME, ".gemini", "config", "GEMINI.md") },
  { id: "gemini", app: "Gemini CLI", file: path.join(HOME, ".gemini", "GEMINI.md"), only: path.join(HOME, ".gemini", "settings.json") },
];

const isOurs = (command) => typeof command === "string" && /swarm/i.test(command) && /index\.js"?\s+hook\s+(stop|post-tool|pre-tool)\s*$/.test(command);

function hookCommands(entry) {
  const cmd = (kind) => ({ type: "command", command: `node "${entry.replace(/\\/g, "/")}" hook ${kind}`, timeout: 30 });
  return { stop: cmd("stop"), post: cmd("post-tool"), pre: cmd("pre-tool") };
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeFile(file, content, backup) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, content);
}

export function editHooks(id, entry, { remove, dryRun, verb, backup }) {
  const t = HOOK_TARGETS.find((x) => x.id === id);
  if (!t || !fs.existsSync(path.dirname(t.file))) return null;
  let config;
  try {
    config = readJson(t.file);
  } catch {
    return `skipped hooks for ${t.app}: ${t.file} is not valid JSON`;
  }
  const before = JSON.stringify(config);
  const { stop, post, pre } = hookCommands(entry);
  if (t.format === "claude") {
    config.hooks ||= {};
    const ours = { Stop: { hooks: [stop] }, PreToolUse: { matcher: t.matcher, hooks: [pre] }, PostToolUse: { matcher: t.matcher, hooks: [post] } };
    for (const event of Object.keys(ours)) {
      const groups = (config.hooks[event] || [])
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
        .filter((g) => g.hooks.length);
      if (!remove) groups.push(ours[event]);
      if (groups.length) config.hooks[event] = groups;
      else delete config.hooks[event];
    }
    if (!Object.keys(config.hooks).length) delete config.hooks;
  } else if (remove) delete config["swarm-mcp"];
  else
    config["swarm-mcp"] = {
      enabled: true,
      Stop: [{ hooks: [stop] }],
      PreToolUse: [{ matcher: t.matcher, hooks: [pre] }],
      PostToolUse: [{ matcher: t.matcher, hooks: [post] }],
    };
  if (JSON.stringify(config) === before && remove) return null;
  if (!dryRun) writeFile(t.file, `${JSON.stringify(config, null, 2)}\n`, backup);
  const trust = id === "codex" && !remove ? " (Codex asks you once to trust new hooks: approve the swarm ones)" : "";
  return `${verb(remove, dryRun)} ${t.app} hooks: ${t.file}${trust}`;
}

function instructionsBlock(entry) {
  const run = `node "${entry.replace(/\\/g, "/")}"`;
  return `${MARK_START}
## Swarm (multi-agent teamwork)

When the user asks you to join, connect to, manage or work in "the swarm":
- Use the swarm MCP tools (swarm_join, task_claim, task_update, swarm_inbox, ...) and follow the playbook swarm_join returns.
- If those tools aren't available in this session (most apps load MCP servers only at startup), don't give up and don't ask the user to start anything: run the same tools from your shell. They behave exactly the same:
  - \`${run} call swarm_join --as <your-name> --role <worker|manager|reviewer> --project "<this project folder>"\`
  - \`${run} call task_claim --as <your-name>\` (waits for work)
  - \`${run} call task_update --as <your-name> --task_id 3 --status done --result "what changed"\`
  - \`${run} call message_send --as <your-name> --reply_to 7 --content "your answer"\`
  - Any tool works this way: \`call <tool> --as <your-name> --<arg> <value> ...\`. Mention to the user that restarting the app loads the MCP tools.
- Every swarm message must be answered. When one shows up ("NEW SWARM MESSAGE"), stop and reply with message_send(reply_to=<its number>) before anything else; your other tools are blocked until you do.
- Once joined, stay in the swarm and keep working or waiting until the manager calls swarm_finish, or the user tells you to stop (then call swarm_leave first).
${MARK_END}`;
}

export function editInstructions(id, entry, { remove, dryRun, verb, backup }) {
  const t = INSTRUCTION_TARGETS.find((x) => x.id === id);
  if (!t || !fs.existsSync(path.dirname(t.file)) || (t.only && !fs.existsSync(t.only))) return null;
  const current = fs.existsSync(t.file) ? fs.readFileSync(t.file, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const start = current.indexOf(MARK_START);
  const end = current.indexOf(MARK_END);
  const without = start >= 0 && end > start ? (current.slice(0, start) + current.slice(end + MARK_END.length)).replace(/\s+$/, "") : current.replace(/\s+$/, "");
  if (remove && start < 0) return null;
  const next = remove ? (without ? without + eol : "") : `${without ? without + eol + eol : ""}${instructionsBlock(entry).replace(/\n/g, eol)}${eol}`;
  if (next === current) return null;
  if (!dryRun) {
    if (remove && !next) fs.rmSync(t.file, { force: true });
    else writeFile(t.file, next, backup);
  }
  return `${verb(remove, dryRun)} ${t.app} instructions: ${t.file}`;
}

export const EXTRA_IDS = [...new Set([...HOOK_TARGETS, ...INSTRUCTION_TARGETS].map((t) => t.id))];
