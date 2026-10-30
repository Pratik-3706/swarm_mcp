// Shell fallback: run any swarm tool from a terminal.
//
// For an agent whose app hasn't loaded the swarm MCP server yet (most apps load MCP servers
// only at startup), or that has no MCP support at all but can run shell commands. Each call
// runs the real server in-process, so behaviour is identical to the MCP tools.
//
//   swarm-mcp call <tool> --as <name> [--role worker] [--swarm default] [--arg value ...] ['{"json":"args"}']
//
// Tool arguments can be given as --key value (safest: Windows PowerShell mangles quotes inside
// JSON passed to programs) or as one JSON object. Values are parsed as JSON when they can be,
// so --task_id 3 is a number and --paths '["a","b"]' an array; --paths a,b also works.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { SwarmStore } from "./store.js";

// Agents' shell tools usually kill commands after about two minutes, so waits stay under that.
const SHELL_WAIT = Number(process.env.SWARM_WAIT_SECONDS) || 90;
const WAITING_TOOLS = ["task_claim", "swarm_inbox", "file_lock"];
const IDENTITY = ["as", "role", "swarm"];

const USAGE = `Usage: swarm-mcp call <tool> --as <your-name> [--role worker|manager|reviewer] [--swarm name] [--arg value ...] ['{"arg":"value"}']
Examples:
  swarm-mcp call swarm_join --as codex --role worker
  swarm-mcp call task_claim --as codex
  swarm-mcp call task_update --as codex --task_id 3 --status done --result "Added the login form"`;

function parseValue(key, raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return key === "paths" ? raw.split(",").map((p) => p.trim()) : raw;
  }
}

export function parseCall(argv) {
  const [tool, ...rest] = argv;
  const identity = {};
  let args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split(/=(.*)/s);
      const value = inline ?? rest[++i];
      if (IDENTITY.includes(key)) identity[key] = value;
      else args[key] = parseValue(key, value ?? "true");
    } else args = { ...JSON.parse(a), ...args };
  }
  return { tool, identity, args };
}

export async function runCall(argv) {
  const { tool, identity, args } = parseCall(argv);
  if (!tool || !identity.as) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const name = identity.as.trim().toLowerCase().replace(/\s+/g, "-");
  const store = new SwarmStore(identity.swarm || process.env.SWARM_NAME || "default");
  const existing = await store.view((state) => state.agents[name]);

  const server = createServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: process.env.SWARM_CLIENT || "swarm-cli", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (toolName, toolArgs) => {
    const r = await client.callTool({ name: toolName, arguments: toolArgs }, undefined, { timeout: 24 * 3600_000 });
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError };
  };

  try {
    // Every call is a fresh process, so it joins first; rejoining under the same role is silent.
    const role = identity.role || args.role || existing?.role || "worker";
    const joined = await call("swarm_join", { ...(tool === "swarm_join" ? args : {}), name, role, swarm: store.swarm });
    if (tool === "swarm_join" || joined.isError) {
      console.log(joined.text);
      if (joined.isError) process.exitCode = 1;
      return;
    }
    if (WAITING_TOOLS.includes(tool) && args.wait_seconds === undefined && !(tool === "file_lock" && args.action !== "lock"))
      args.wait_seconds = SHELL_WAIT;
    const result = await call(tool, args);
    console.log(result.text);
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
