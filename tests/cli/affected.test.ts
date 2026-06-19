import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { affectedCommand, globToRegExp } from "../../src/cli/commands/impact.js";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-affected");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("affected --tests CLI command (ama-5gs.9)", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexFixture(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-affected-"));
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

  it("returns the whole affected closure by default", async () => {
    await indexFixture();
    const out = capture();
    await affectedCommand.run(["core.ts"], { json: true, write: out.write });
    const files = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.file).sort();
    expect(files).toEqual(["core.test.ts", "user.ts"]);
  });

  it("filters to test files with --tests", async () => {
    await indexFixture();
    const out = capture();
    const code = await affectedCommand.run(["--tests", "core.ts"], {
      json: true,
      write: out.write,
    });
    expect(code).toBe(0);
    const files = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.file);
    expect(files).toEqual(["core.test.ts"]);
  });

  it("filters affected results by a --filter glob (ama-dx1)", async () => {
    await indexFixture();
    const out = capture();
    await affectedCommand.run(["--filter", "*.test.ts", "core.ts"], {
      json: true,
      write: out.write,
    });
    const files = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.file);
    expect(files).toEqual(["core.test.ts"]);
  });

  it("reads changed paths from stdin when no file args are given (ama-dx1)", async () => {
    await indexFixture();
    const out = capture();
    await affectedCommand.run([], {
      json: true,
      write: out.write,
      stdin: () => "core.ts\n",
    });
    const files = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.file).sort();
    expect(files).toEqual(["core.test.ts", "user.ts"]);
  });
});

describe("globToRegExp (ama-dx1)", () => {
  it("matches * within a path segment but not across separators", () => {
    expect(globToRegExp("*.test.ts").test("core.test.ts")).toBe(true);
    expect(globToRegExp("*.test.ts").test("src/core.test.ts")).toBe(false);
  });

  it("matches ** across path segments", () => {
    expect(globToRegExp("src/**").test("src/query/service.ts")).toBe(true);
    expect(globToRegExp("src/query/**").test("src/store/x.ts")).toBe(false);
  });
});
