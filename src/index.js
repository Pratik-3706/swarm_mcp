#!/usr/bin/env node
// swarm-mcp — let multiple AI coding agents collaborate through one MCP server.
//
//   swarm-mcp                 run the MCP server over stdio (what agents launch)
//   swarm-mcp install         register with Claude Code, Codex, Antigravity, Cursor, ...
//   swarm-mcp uninstall       remove those registrations
//   swarm-mcp update [--check] pull the latest version from GitHub and refresh the installed apps
//   swarm-mcp status [--watch] [--swarm name]   show the board in a terminal
//   swarm-mcp reset  [--swarm name]             wipe a swarm
//   swarm-mcp call <tool> --as <name> [json]    run a swarm tool from a shell (no MCP needed)
//   swarm-mcp hook pre-tool|post-tool|stop    hook helper for apps with Claude-style hooks
//   swarm-mcp dashboard [--swarm s] [--project p]   live board on http://127.0.0.1:56432
//   swarm-mcp report [--swarm s]                plain-English status

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, reportText, summarize } from "./server.js";
import { startDashboard } from "./dashboard.js";
import { SwarmStore, existingBoardRoot, listSwarms } from "./store.js";

// Board commands default to the project board of the current folder, if it has one.
const boardProject = () => option("project") || existingBoardRoot(process.cwd());
import { installedAgents, runInstall } from "./install.js";
import { runCall } from "./cli.js";
import { runHook } from "./hook.js";
import { checkForUpdatesInBackground, runUpdate } from "./update.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function printStatus(swarm) {
  const store = new SwarmStore(swarm, { project: boardProject() });
  const state = await store.view();
  const recent = state.events.slice(-12).map((e) => `  ${e.at.slice(11, 19)} ${e.text}`);
  return `${summarize(state, null)}\n\nRecent activity:\n${recent.join("\n") || "  (none)"}`;
}

switch (cmd) {
  case undefined:
  case "serve": {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    checkForUpdatesInBackground();
    break;
  }
  case "update":
    runUpdate({ check: flag("check"), install: !flag("no-install") });
    break;
  case "install":
  case "uninstall": {
    let only = option("only")?.toLowerCase().split(",").map((s) => s.replace(/\s+/g, ""));
    if (flag("installed")) {
      only = installedAgents();
      if (!only.length) {
        console.log("swarm isn't installed in any app yet. Run: node src/index.js install");
        break;
      }
    }
    runInstall({
      remove: cmd === "uninstall",
      dryRun: flag("dry-run"),
      only,
      hooks: !flag("no-hooks"),
      instructions: !flag("no-instructions"),
    });
    break;
  }
  case "call":
    await runCall(rest);
    break;
  case "dashboard":
    await startDashboard({ swarm: option("swarm") || "default", project: boardProject(), open: !flag("no-open") });
    break;
  case "report":
    console.log(reportText(await new SwarmStore(option("swarm") || "default", { project: boardProject() }).view()));
    break;
  case "hook":
    await runHook(rest[0]);
    break;
  case "status": {
    const swarm = option("swarm") || "default";
    if (!flag("watch")) {
      console.log(await printStatus(swarm));
      const others = listSwarms().filter((s) => s !== swarm);
      if (others.length) console.log(`\nOther swarms: ${others.join(", ")} (use --swarm <name>)`);
      break;
    }
    for (;;) {
      const out = await printStatus(swarm);
      process.stdout.write(`\x1b[2J\x1b[H${out}\n\n(refreshing every 2s — Ctrl+C to exit)\n`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  case "reset":
    await new SwarmStore(option("swarm") || "default", { project: boardProject() }).reset();
    console.log(`Swarm "${option("swarm") || "default"}" reset.`);
    break;
  default:
    console.log(
      "Usage: swarm-mcp [serve | update [--check] [--no-install] | install [--installed] [--dry-run] [--only claude,codex,antigravity-ide,...] [--no-hooks] [--no-instructions] | uninstall | status [--watch] [--swarm name] | reset [--swarm name] | call <tool> --as <name> [--role r] [--swarm s] [--arg value] | dashboard [--swarm s] [--project p] [--no-open] | report [--swarm s] | hook pre-tool|post-tool|stop]",
    );
    process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
