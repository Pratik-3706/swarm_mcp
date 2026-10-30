// Self-update from GitHub.
//
//   swarm-mcp update            pull the latest version, reinstall dependencies if they changed,
//                               and refresh the setup in every app where swarm is installed
//   swarm-mcp update --check    only say whether a newer version is available
//   swarm-mcp update --no-install   pull, but leave app configs alone
//
// The MCP server also checks in the background (at most once a day) and mentions a newer
// version to agents when they join, so nobody has to remember to look.

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { swarmHome } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "index.js");
const CHECK_EVERY_MS = 24 * 3600_000;
const cacheFile = () => path.join(swarmHome(), "update-check.json");

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commitsBehind() {
  git("fetch", "--quiet", "origin");
  return Number(git("rev-list", "--count", "HEAD..@{u}"));
}

export function runUpdate({ check = false, install = true } = {}) {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    console.log(`${ROOT} is not a git checkout, so it can't update itself. Reinstall with:\n  git clone https://github.com/Pratik-3706/swarm_mcp.git && cd swarm_mcp && npm run setup`);
    process.exitCode = 1;
    return;
  }
  let behind;
  try {
    behind = commitsBehind();
  } catch (err) {
    console.log(`Couldn't reach GitHub: ${String(err.stderr || err.message).trim().split("\n")[0]}`);
    process.exitCode = 1;
    return;
  }
  saveCheck(behind);
  if (!behind) return console.log(`swarm-mcp is up to date (${git("rev-parse", "--short", "HEAD")}).`);
  const pending = git("log", "--format=  %h %s", "HEAD..@{u}");
  if (check) return console.log(`A newer swarm-mcp is available (${behind} new commit${behind > 1 ? "s" : ""}):\n${pending}\nRun: node "${ENTRY}" update`);

  if (git("status", "--porcelain", "--untracked-files=no")) {
    console.log(`You have local changes in ${ROOT}, so the update was skipped. Commit or stash them, then run update again.`);
    process.exitCode = 1;
    return;
  }
  const before = git("rev-parse", "HEAD");
  git("merge", "--ff-only", "--quiet", "@{u}");
  console.log(`Updated swarm-mcp to ${git("rev-parse", "--short", "HEAD")}:\n${pending}`);

  const changed = git("diff", "--name-only", before, "HEAD").split("\n");
  if (changed.some((f) => f === "package.json" || f === "package-lock.json")) {
    console.log("\nDependencies changed, installing them...");
    execSync("npm install --no-audit --no-fund", { cwd: ROOT, stdio: "inherit" });
  }
  if (install) {
    // A fresh process, so the installer that runs is the version just pulled.
    console.log("");
    execFileSync(process.execPath, [ENTRY, "install", "--installed"], { stdio: "inherit" });
  }
  saveCheck(0);
  console.log("\nRestart your agents (or start new chats) to load the new version.");
}

function saveCheck(behind) {
  try {
    fs.mkdirSync(swarmHome(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ checkedAt: new Date().toISOString(), behind, head: git("rev-parse", "HEAD") }));
  } catch {
    // The check is a convenience; never fail over it.
  }
}

/** Kick off a background check if the last one is older than a day. Never blocks or throws. */
export function checkForUpdatesInBackground() {
  try {
    if (process.env.SWARM_NO_UPDATE_CHECK || !fs.existsSync(path.join(ROOT, ".git"))) return;
    const last = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (Date.now() - Date.parse(last.checkedAt) < CHECK_EVERY_MS) return;
  } catch {
    // no cache yet: check now
  }
  const child = execFile("git", ["-C", ROOT, "fetch", "--quiet", "origin"], { windowsHide: true }, (err) => {
    if (err) return;
    try {
      saveCheck(Number(git("rev-list", "--count", "HEAD..@{u}")));
    } catch {
      // ignore
    }
  });
  child.unref?.();
}

/** A line for agents when a newer version is known to exist, else "". */
export function updateNotice() {
  try {
    const last = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (!last.behind || last.head !== git("rev-parse", "HEAD")) return "";
    return `Note: a newer swarm-mcp is available (${last.behind} new commit${last.behind > 1 ? "s" : ""}). Tell the user, or update it yourself by running: node "${ENTRY.replace(/\\/g, "/")}" update`;
  } catch {
    return "";
  }
}
