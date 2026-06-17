import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import { handlersCommand, routesCommand } from "../../src/cli/commands/query.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const expressRoot = path.resolve(here, "../fixtures/ts-express");

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("route CLI commands", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexExpress(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-routes-"));
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

  it("handlers lists the handler a route maps to", async () => {
    await indexExpress();
    const out = capture();
    await handlersCommand.run(["GET /users"], { json: true, write: out.write });
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.name);
    expect(names).toContain("listUsers");
  });

  it("routes lists the routes that map to a handler", async () => {
    await indexExpress();
    const out = capture();
    await routesCommand.run(["listUsers"], { json: true, write: out.write });
    const names = (JSON.parse(out.text()) as GraphNode[]).map((n) => n.name);
    expect(names).toContain("GET /users");
  });

  it("registers handlers and routes", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("handlers");
    expect(names).toContain("routes");
  });
});
