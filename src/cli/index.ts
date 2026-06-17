#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { serverStamp } from "../mcp/build-info.js";
import { indexCommand, initCommand, uninitCommand } from "./commands/lifecycle.js";
import { searchCommand } from "./commands/search.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";

/** Global options parsed from argv and handed to each command. */
export interface CliContext {
  /** True when `--json` was passed; commands should emit machine-readable JSON. */
  readonly json: boolean;
  /** Write a line to stdout. */
  write(line: string): void;
}

/** A subcommand of the `ama` CLI. */
export interface CliCommand {
  readonly name: string;
  readonly summary: string;
  run(args: string[], ctx: CliContext): number | Promise<number>;
}

function usage(commands: readonly CliCommand[]): string {
  const lines = ["Usage: ama [--json] <command> [args]", "", "Commands:"];
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
  return command.run(positional.slice(1), { json, write: out });
}

/** Registered commands. More domain commands (search/sync/…) are added here
 * as the CLI epic progresses (ama-5gs.4+). */
export const COMMANDS: readonly CliCommand[] = [
  initCommand,
  indexCommand,
  searchCommand,
  statusCommand,
  syncCommand,
  uninitCommand,
];

export async function main(): Promise<void> {
  process.exit(await run(process.argv.slice(2), COMMANDS));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
