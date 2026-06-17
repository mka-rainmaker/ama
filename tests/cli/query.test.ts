import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import {
  calleesCommand,
  callersCommand,
  exploreCommand,
  nodeCommand,
  renderExploration,
  renderNodeList,
  renderNodeView,
} from "../../src/cli/commands/query.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { GraphNode } from "../../src/graph/types.js";
import type { Exploration, NodeView } from "../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "../fixtures/ts-calls");

const MAIN: GraphNode = {
  id: "f.ts#main",
  kind: "Function",
  name: "main",
  file: "f.ts",
  qualifiedName: "main",
  range: { startLine: 5, endLine: 7 },
  tier: "deep",
};
const HELPER: GraphNode = {
  id: "f.ts#helper",
  kind: "Function",
  name: "helper",
  file: "f.ts",
  qualifiedName: "helper",
  range: { startLine: 1, endLine: 3 },
  tier: "deep",
};
const VIEW: NodeView = { node: MAIN, callers: [], callees: [HELPER], dependents: [] };
const EXP: Exploration = {
  question: "helper",
  byFile: { "f.ts": [HELPER] },
  relationships: [{ symbol: "helper", callers: [MAIN], callees: [] }],
  blastRadius: [MAIN],
};

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("renderNodeList", () => {
  it("lists hits with location and reports the count under a label", () => {
    const text = renderNodeList("callers", "helper", [MAIN], false);
    expect(text).toContain("main");
    expect(text).toContain("f.ts:5");
    expect(text.toLowerCase()).toContain("caller");
  });

  it("reports nothing found when the list is empty", () => {
    expect(renderNodeList("callers", "helper", [], false).toLowerCase()).toContain("no callers");
  });

  it("emits the raw node array as JSON", () => {
    expect(JSON.parse(renderNodeList("callers", "helper", [MAIN], true))).toEqual([MAIN]);
  });
});

describe("renderNodeView", () => {
  it("shows the node with its callers/callees/dependents in human form", () => {
    const text = renderNodeView(VIEW, false);
    expect(text).toContain("main");
    expect(text).toContain("helper");
    expect(text.toLowerCase()).toContain("callers");
    expect(text.toLowerCase()).toContain("callees");
    expect(text.toLowerCase()).toContain("dependents");
  });

  it("includes the source snippet in human form when present", () => {
    const withSnippet: NodeView = {
      ...VIEW,
      snippet: {
        id: MAIN.id,
        file: MAIN.file,
        startLine: 5,
        endLine: 7,
        text: "function main() {\n  return helper();\n}",
      },
    };
    expect(renderNodeView(withSnippet, false)).toContain("return helper();");
  });

  it("emits the raw NodeView as JSON", () => {
    expect(JSON.parse(renderNodeView(VIEW, true))).toEqual(VIEW);
  });
});

describe("renderExploration", () => {
  it("shows the question and the blast radius in human form", () => {
    const text = renderExploration(EXP, false);
    expect(text).toContain("helper");
    expect(text.toLowerCase()).toContain("blast radius");
  });

  it("emits the raw Exploration as JSON", () => {
    expect(JSON.parse(renderExploration(EXP, true))).toEqual(EXP);
  });
});

describe("query commands", () => {
  const tmpDirs: string[] = [];
  const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };

  async function indexFixture(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-query-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "index.db");
    process.env.AMA_ROOT = fixtureRoot;
    await indexCommand.run([fixtureRoot], { json: true, write: () => {} });
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

  it("callers finds who calls a symbol", async () => {
    await indexFixture();
    const out = capture();
    const code = await callersCommand.run(["helper"], { json: true, write: out.write });
    expect(code).toBe(0);
    expect((JSON.parse(out.text()) as GraphNode[]).some((n) => n.name === "main")).toBe(true);
  });

  it("callees finds what a symbol calls", async () => {
    await indexFixture();
    const out = capture();
    const code = await calleesCommand.run(["main"], { json: true, write: out.write });
    expect(code).toBe(0);
    expect((JSON.parse(out.text()) as GraphNode[]).some((n) => n.name === "helper")).toBe(true);
  });

  it("node shows a symbol and its relationships", async () => {
    await indexFixture();
    const out = capture();
    const code = await nodeCommand.run(["main"], { json: true, write: out.write });
    expect(code).toBe(0);
    const view = JSON.parse(out.text()) as NodeView;
    expect(view.node.name).toBe("main");
    expect(view.callees.some((n) => n.name === "helper")).toBe(true);
  });

  it("node distinguishes 'not found' from 'no index'", async () => {
    await indexFixture();
    const out = capture();
    const code = await nodeCommand.run(["NoSuchSymbol"], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("not found");
    expect(out.text().toLowerCase()).not.toContain("no index");
  });

  it("explore answers a question with a blast radius", async () => {
    await indexFixture();
    const out = capture();
    const code = await exploreCommand.run(["helper"], { json: true, write: out.write });
    expect(code).toBe(0);
    const exp = JSON.parse(out.text()) as Exploration;
    expect(exp.question).toBe("helper");
    expect(exp.blastRadius.length).toBeGreaterThan(0);
  });

  it("reports no index (exit 1) when none exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-query-"));
    tmpDirs.push(dir);
    process.env.AMA_DB = path.join(dir, ".ama", "missing.db");
    process.env.AMA_ROOT = fixtureRoot;
    const out = capture();
    const code = await callersCommand.run(["helper"], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("no index");
  });

  it("reports a usage error (exit 1) when the symbol ref is missing", async () => {
    const out = capture();
    const code = await callersCommand.run([], { json: false, write: out.write });
    expect(code).toBe(1);
    expect(out.text().toLowerCase()).toContain("usage");
  });
});

describe("CLI command registration", () => {
  it("registers callers, callees, node, and explore", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["callers", "callees", "node", "explore"]));
  });
});
