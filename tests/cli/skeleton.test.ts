import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { skeletonCommand } from "../../src/cli/commands/query.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { FileSkeleton } from "../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const expressRoot = path.resolve(here, "../fixtures/ts-express");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("skeleton CLI command", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexExpress(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-skel-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = expressRoot;
    await indexCommand.run([expressRoot], { json: true, write: () => {} });
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

  it("prints a file's outline and dependents as JSON", async () => {
    await indexExpress();
    const out = capture();
    const code = await skeletonCommand.run(["app.ts"], { json: true, write: out.write });
    expect(code).toBe(0);
    const skel = JSON.parse(out.text()) as FileSkeleton;
    expect(skel.file.kind).toBe("File");
    expect(skel.symbols.map((n) => n.name)).toContain("listUsers");
  });

  it("renders a human-readable outline with a dependents line", async () => {
    await indexExpress();
    const out = capture();
    await skeletonCommand.run(["app.ts"], { json: false, write: out.write });
    expect(out.text()).toContain("listUsers");
    expect(out.text()).toContain("dependents");
  });

  it("errors with a non-zero code for an unknown file", async () => {
    await indexExpress();
    const out = capture();
    const code = await skeletonCommand.run(["does-not-exist.ts"], { json: true, write: out.write });
    expect(code).toBe(1);
  });

  it("is registered in the command list", () => {
    expect(COMMANDS.map((c) => c.name)).toContain("skeleton");
  });
});
