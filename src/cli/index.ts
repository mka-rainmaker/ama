#!/usr/bin/env node
import * as fs from "node:fs";
import { serverStamp } from "../mcp/build-info.js";
import { isEntrypoint } from "../runtime/entrypoint.js";
import { ensureBaselineWasmTier } from "../runtime/wasm-tier.js";
import { cyclesCommand } from "./commands/cycles.js";
import { filesCommand } from "./commands/files.js";
import { affectedCommand, impactCommand } from "./commands/impact.js";
import { installCommand, uninstallCommand } from "./commands/install.js";
import { indexCommand, initCommand, uninitCommand } from "./commands/lifecycle.js";
import {
  calleesCommand,
  callersCommand,
  exploreCommand,
  handlersCommand,
  implementationsCommand,
  importersCommand,
  importsCommand,
  interfacesCommand,
  nodeCommand,
  overriddenByCommand,
  overridesCommand,
  referrersCommand,
  returnsCommand,
  routesCommand,
  skeletonCommand,
  typeUsersCommand,
  typesUsedCommand,
} from "./commands/query.js";
import { searchCodeCommand, searchCommand } from "./commands/search.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { upgradeCommand } from "./commands/upgrade.js";

/** Global options parsed from argv and handed to each command. */
export interface CliContext {
  /** True when `--json` was passed; commands should emit machine-readable JSON. */
  readonly json: boolean;
  /** Write a result line to stdout. */
  write(line: string): void;
  /**
   * Write a diagnostic (usage, "no index", not-found) to stderr, keeping stdout
   * reserved for results so a `--json` consumer's stream stays clean. Optional:
   * `run()` always supplies it, but a direct `command.run(args, { write })` unit
   * call may omit it — use {@link emitError} so diagnostics fall back to stdout.
   */
  error?(line: string): void;
  /** Read all of piped stdin (for `git diff … | ama affected`); returns "" when
   *  stdin is a TTY or empty. Injectable so commands stay unit-testable. (ama-dx1) */
  stdin?(): string;
}

/** A subcommand of the `ama` CLI. */
export interface CliCommand {
  readonly name: string;
  readonly summary: string;
  /** One-line usage shown by `ama <command> --help`; falls back to the summary. */
  readonly usage?: string;
  run(args: string[], ctx: CliContext): number | Promise<number>;
}

function usage(commands: readonly CliCommand[]): string {
  const lines = ["Usage: ama [--json] <command> [args]", "", "Commands:"];
  // The MCP server is the primary way agents use Ama; the rest are one-shot CLI queries.
  lines.push(
    `  ${"mcp".padEnd(12)} serve the code-intelligence MCP server over stdio (for coding agents)`,
  );
  if (commands.length === 0) {
    lines.push("  (none registered yet)");
  } else {
    for (const command of commands) lines.push(`  ${command.name.padEnd(12)} ${command.summary}`);
  }
  return lines.join("\n");
}

/**
 * Parse argv and dispatch to a command, returning a process exit code. `out`/`err`
 * are injectable so the framework is unit-testable without touching real streams.
 * Unlike the MCP server, the CLI *owns* stdout, so writing results there is fine.
 */
export async function run(
  argv: string[],
  commands: readonly CliCommand[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  err: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const json = argv.includes("--json");
  const positional = argv.filter((arg) => arg !== "--json");
  const name = positional[0];

  if (name === undefined || name === "--help" || name === "-h") {
    out(usage(commands));
    return 0;
  }
  if (name === "--version" || name === "-v") {
    out(serverStamp.version);
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    err(`Unknown command: ${name}`);
    err(usage(commands));
    return 1;
  }
  const rest = positional.slice(1);
  // `ama <command> --help` shows the command's own help (and never reaches its
  // run(), so it can't be misread as an argument), before dispatching.
  if (rest.includes("--help") || rest.includes("-h")) {
    out(`ama ${command.name} — ${command.summary}`);
    if (command.usage) out(command.usage);
    return 0;
  }
  return command.run(rest, { json, write: out, error: err, stdin: readPipedStdin });
}

/** Read all of piped stdin synchronously; "" when stdin is a TTY (no pipe) so an
 *  interactive `ama affected` doesn't block waiting for input. (ama-dx1) */
function readPipedStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Registered commands. More domain commands (search/sync/…) are added here
 * as the CLI epic progresses (ama-5gs.4+). */
export const COMMANDS: readonly CliCommand[] = [
  affectedCommand,
  calleesCommand,
  callersCommand,
  cyclesCommand,
  exploreCommand,
  filesCommand,
  handlersCommand,
  impactCommand,
  implementationsCommand,
  importersCommand,
  importsCommand,
  indexCommand,
  initCommand,
  installCommand,
  interfacesCommand,
  nodeCommand,
  overriddenByCommand,
  overridesCommand,
  referrersCommand,
  returnsCommand,
  routesCommand,
  searchCodeCommand,
  searchCommand,
  skeletonCommand,
  statusCommand,
  syncCommand,
  typeUsersCommand,
  typesUsedCommand,
  uninitCommand,
  uninstallCommand,
  upgradeCommand,
];

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `ama mcp` serves the code-intelligence MCP protocol over stdio — the entry coding
  // agents spawn for a local server. WASM is already pinned by the entry guard; the stdio
  // server owns the process lifecycle (it stays alive on the transport until the client
  // disconnects), so unlike a query command it must not `process.exit`.
  if (argv[0] === "mcp") {
    const { main: serveMcp } = await import("../mcp/server.js");
    await serveMcp();
    return;
  }
  process.exit(await run(argv, COMMANDS));
}

if (isEntrypoint(import.meta.url)) {
  // Pin grammar WASM to the baseline compiler before any command can load it, or
  // an indexing command OOMs (ama-rgx). Re-execs once; the supervisor skips main.
  if (!ensureBaselineWasmTier()) {
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
