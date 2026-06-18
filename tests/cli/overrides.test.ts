import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { overriddenByCommand, overridesCommand } from "../../src/cli/commands/query.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-implements");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("overrides CLI commands (ama-38n)", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexFixture(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-overrides-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = root;
    await indexCommand.run([root], { json: true, write: () => {} });
  }

  afterEach(() => {
    for (const key of ["AMA_DB", "AMA_ROOT"] as const) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("overrides lists the interface method a class method overrides", async () => {
    await indexFixture();
    const out = capture();
    await overridesCommand.run(["FriendlyGreeter.greet"], { json: true, write: out.write });
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.qualifiedName);
    expect(names).toContain("Greeter.greet");
  });

  it("overridden-by lists every method that overrides an interface method", async () => {
    await indexFixture();
    const out = capture();
    await overriddenByCommand.run(["Greeter.greet"], { json: true, write: out.write });
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.qualifiedName).sort();
    expect(names).toEqual(["FriendlyGreeter.greet", "Person.greet"]);
  });

  it("registers overrides and overridden-by", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("overrides");
    expect(names).toContain("overridden-by");
  });
});
