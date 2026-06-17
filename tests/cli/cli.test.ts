import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CliCommand, run } from "../../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf8")) as {
  version: string;
};

/** Collect everything written to a stream into an array of lines. */
function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("CLI framework", () => {
  it("prints the package version for --version", async () => {
    const out = capture();
    const code = await run(["--version"], [], out.write, out.write);
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain(pkg.version);
  });

  it("lists commands for --help (and for no args)", async () => {
    const cmds: CliCommand[] = [{ name: "greet", summary: "say hi", run: () => 0 }];
    const help = capture();
    expect(await run(["--help"], cmds, help.write, help.write)).toBe(0);
    expect(help.lines.join("\n")).toContain("greet");
    expect(help.lines.join("\n")).toContain("say hi");

    const bare = capture();
    expect(await run([], cmds, bare.write, bare.write)).toBe(0);
    expect(bare.lines.join("\n")).toContain("greet");
  });

  it("errors (exit 1) on an unknown command", async () => {
    const err = capture();
    const code = await run(["bogus"], [], () => {}, err.write);
    expect(code).toBe(1);
    expect(err.lines.join("\n")).toMatch(/unknown command/i);
  });

  it("dispatches to a command, forwarding args and the --json flag", async () => {
    let seen: { json: boolean; args: string[] } | undefined;
    const cmds: CliCommand[] = [
      {
        name: "greet",
        summary: "say hi",
        run: (args, ctx) => {
          seen = { json: ctx.json, args };
          return 0;
        },
      },
    ];
    const code = await run(
      ["greet", "--json", "alice"],
      cmds,
      () => {},
      () => {},
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ json: true, args: ["alice"] });
  });

  it("routes ctx.error to the err stream, leaving stdout clean", async () => {
    const out = capture();
    const err = capture();
    const cmds: CliCommand[] = [
      {
        name: "boom",
        summary: "diagnose",
        run: (_args, ctx) => {
          ctx.error?.("a diagnostic");
          return 1;
        },
      },
    ];
    const code = await run(["boom"], cmds, out.write, err.write);
    expect(code).toBe(1);
    expect(err.lines.join("\n")).toContain("a diagnostic");
    expect(out.lines.join("\n")).not.toContain("a diagnostic");
  });

  it("shows per-command help for `<command> --help` without running the command", async () => {
    let ran = false;
    const cmds: CliCommand[] = [
      {
        name: "greet",
        summary: "say hi",
        usage: "Usage: ama greet <name>",
        run: () => {
          ran = true;
          return 0;
        },
      },
    ];
    const out = capture();
    const code = await run(["greet", "--help"], cmds, out.write, out.write);
    expect(code).toBe(0);
    expect(ran).toBe(false);
    const text = out.lines.join("\n");
    expect(text).toContain("say hi");
    expect(text).toContain("Usage: ama greet <name>");
  });

  it("accepts -h and falls back to the summary when a command has no usage", async () => {
    let ran = false;
    const cmds: CliCommand[] = [
      {
        name: "plain",
        summary: "a plain command",
        run: () => {
          ran = true;
          return 0;
        },
      },
    ];
    const out = capture();
    const code = await run(["plain", "-h"], cmds, out.write, out.write);
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(out.lines.join("\n")).toContain("a plain command");
  });
});
