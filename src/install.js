// One-command setup: registers swarm-mcp with every coding agent found on this machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXTRA_IDS, editHooks, editInstructions } from "./extras.js";

const SERVER_NAME = "swarm";
const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

const serverDef = (client) => ({ command: "node", args: [ENTRY], env: { SWARM_CLIENT: client } });

// JSON configs using the common { "mcpServers": { name: {command,args,env} } } shape.
// id: what --only matches. create: write the file if its folder exists; otherwise only touch existing files.
const JSON_TARGETS = [
  // Antigravity IDE keeps its settings (config.json, mcp_config.json) in ~/.gemini/config.
  { id: "antigravity-ide", client: "Antigravity IDE", file: path.join(HOME, ".gemini", "config", "mcp_config.json"), create: true },
  { id: "antigravity", client: "Antigravity", file: path.join(HOME, ".gemini", "antigravity", "mcp_config.json"), create: true },
  { id: "gemini", client: "Gemini CLI", file: path.join(HOME, ".gemini", "settings.json") },
  { id: "cursor", client: "Cursor", file: path.join(HOME, ".cursor", "mcp.json"), create: true },
  { id: "windsurf", client: "Windsurf", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), create: true },
  {
    id: "claude-desktop",
    client: "Claude Desktop",
    file:
      process.platform === "win32"
        ? path.join(APPDATA, "Claude", "claude_desktop_config.json")
        : process.platform === "darwin"
          ? path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : path.join(HOME, ".config", "Claude", "claude_desktop_config.json"),
    create: true,
  },
];

const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");

function has(cmd) {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const verb = (remove, dryRun) => (dryRun ? (remove ? "would remove from" : "would add to") : remove ? "removed from" : "added to");

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.swarm-backup`);
}

function editJson(target, remove, dryRun) {
  const exists = fs.existsSync(target.file);
  if (!exists && !(target.create && fs.existsSync(path.dirname(target.file)) && !remove)) return null;
  let config = {};
  if (exists) {
    const raw = fs.readFileSync(target.file, "utf8");
    if (raw.trim()) {
      try {
        config = JSON.parse(raw);
      } catch {
        return `skipped ${target.file} (not valid JSON — add it by hand, see README)`;
      }
    }
  }
  config.mcpServers ||= {};
  if (remove) {
    if (!config.mcpServers[SERVER_NAME]) return null;
    delete config.mcpServers[SERVER_NAME];
  } else config.mcpServers[SERVER_NAME] = serverDef(target.client);
  if (!dryRun) {
    backup(target.file);
    fs.writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return `${verb(remove, dryRun)} ${target.client}: ${target.file}`;
}

function stripCodexBlock(lines) {
  // Drop [mcp_servers.swarm] and its sub-tables up to the next unrelated table header.
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = header[1] === `mcp_servers.${SERVER_NAME}` || header[1].startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out;
}

function editCodex(remove, dryRun) {
  if (!fs.existsSync(path.dirname(CODEX_CONFIG)) && !has("codex")) return null;
  const toml = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, "utf8") : "";
  if (remove && !toml.includes(`[mcp_servers.${SERVER_NAME}]`)) return null;
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  // Only our block changes; the rest of the file keeps its exact text.
  const body = stripCodexBlock(toml.split(/\r?\n/)).join(eol).trimEnd();
  const block = remove
    ? ""
    : [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "node"`,
        `args = ['${ENTRY}']`,
        // swarm_inbox blocks while waiting for work; Codex's default 60s tool timeout is too short.
        "tool_timeout_sec = 3700",
        "",
        `[mcp_servers.${SERVER_NAME}.env]`,
        `SWARM_CLIENT = "Codex"`,
      ].join(eol);
  const next = [body, block].filter(Boolean).join(eol + eol) + eol;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
    backup(CODEX_CONFIG);
    fs.writeFileSync(CODEX_CONFIG, next);
  }
  return `${verb(remove, dryRun)} Codex: ${CODEX_CONFIG}`;
}

// Arguments go straight to the exe (no shell), so paths and JSON need no quoting.
function claude(...args) {
  try {
    return execFileSync("claude", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    throw new Error(String(err.stderr || err.stdout || err.message).trim());
  }
}

function editClaudeCode(remove, dryRun) {
  if (!has("claude")) return null;
  if (dryRun) return `${verb(remove, dryRun)} Claude Code (user scope)`;
  try {
    claude("mcp", "remove", "--scope", "user", SERVER_NAME);
  } catch {
    if (remove) return null; // wasn't installed
  }
  if (remove) return "removed from Claude Code (user scope)";
  claude("mcp", "add-json", "--scope", "user", SERVER_NAME, JSON.stringify({ type: "stdio", ...serverDef("Claude Code") }));
  return "added to Claude Code (user scope — available in every project)";
}

export const AGENT_IDS = ["claude", "codex", ...JSON_TARGETS.map((t) => t.id)];

/** Agents that already have swarm registered, so an update refreshes those and adds nothing new. */
export function installedAgents() {
  const ids = [];
  try {
    if (has("claude")) claude("mcp", "get", SERVER_NAME), ids.push("claude");
  } catch {
    // not registered in Claude Code
  }
  if (fs.existsSync(CODEX_CONFIG) && fs.readFileSync(CODEX_CONFIG, "utf8").includes(`[mcp_servers.${SERVER_NAME}]`)) ids.push("codex");
  for (const t of JSON_TARGETS) {
    try {
      if (JSON.parse(fs.readFileSync(t.file, "utf8")).mcpServers?.[SERVER_NAME]) ids.push(t.id);
    } catch {
      // missing or unreadable config: not installed there
    }
  }
  return ids;
}

export function runInstall({ remove = false, dryRun = false, only = null, hooks = true, instructions = true } = {}) {
  // "antigravity ide", "antigravity-ide" and "antigravityide" all mean the same agent.
  const squash = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  only &&= only.map((o) => AGENT_IDS.find((id) => squash(id) === squash(o)) || o);
  const unknown = (only || []).filter((o) => !AGENT_IDS.includes(o));
  if (unknown.length) {
    console.log(`Unknown agent(s): ${unknown.join(", ")}. Choose from: ${AGENT_IDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const results = [];
  const attempt = (id, client, fn) => {
    if (only && !only.includes(id)) return;
    try {
      const r = fn();
      if (r) results.push(`  ✔ ${r}`);
    } catch (err) {
      results.push(`  ✘ ${client}: ${err.message.split("\n")[0]}`);
    }
  };
  attempt("claude", "Claude Code", () => editClaudeCode(remove, dryRun));
  attempt("codex", "Codex", () => editCodex(remove, dryRun));
  for (const t of JSON_TARGETS) attempt(t.id, t.client, () => editJson(t, remove, dryRun));
  // Uninstall always removes the extras; install adds them unless --no-hooks / --no-instructions.
  const ctx = { remove, dryRun, verb, backup };
  for (const id of EXTRA_IDS) {
    if (hooks || remove) attempt(id, id, () => editHooks(id, ENTRY, ctx));
    if (instructions || remove) attempt(id, id, () => editInstructions(id, ENTRY, ctx));
  }

  console.log(`swarm-mcp ${remove ? "uninstall" : "install"}${dryRun ? " (dry run — nothing written)" : ""}`);
  console.log(results.length ? results.join("\n") : "  No supported agents found.");
  if (!remove) {
    console.log(`
Server entry: node "${ENTRY}"
Restart your agents (or reload MCP servers) so they pick it up. Then, in each agent:

  Manager:  "You are the swarm manager. Goal: <what to build>"
  Workers:  "Join the swarm as a worker named codex"   (use a different name per agent)

Watch the board from a terminal:  node "${ENTRY}" status --watch`);
  }
}
