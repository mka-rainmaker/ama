import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyzerRegistry } from "../../src/analyzers/registry.js";
import { Indexer, assertSafeRoot } from "../../src/indexer/indexer.js";

describe("assertSafeRoot — unsafe-root guardrail (ama-m8k.10)", () => {
  it("rejects the filesystem root", () => {
    expect(() => assertSafeRoot(path.parse(process.cwd()).root)).toThrow(/refus/i);
  });

  it("rejects the home directory", () => {
    expect(() => assertSafeRoot(os.homedir())).toThrow(/refus/i);
  });

  it("rejects a system directory", () => {
    expect(() => assertSafeRoot("/etc")).toThrow(/refus/i);
  });

  it("allows a normal project directory", () => {
    expect(() => assertSafeRoot("/home/dev/my-project")).not.toThrow();
  });
});

describe("Indexer.index wires the guardrail (ama-m8k.10)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  // Safe to call: the guard throws before any filesystem walk.
  it("refuses to index the filesystem root", async () => {
    await expect(
      new Indexer(new AnalyzerRegistry()).index(path.parse(process.cwd()).root),
    ).rejects.toThrow(/refus/i);
  });

  it("still indexes a normal directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-safe-root-"));
    dirs.push(dir);
    await expect(new Indexer(new AnalyzerRegistry()).index(dir)).resolves.toBeDefined();
  });
});
