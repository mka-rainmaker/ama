import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

function node(over: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return { kind: "Function", file: "src/app.ts", qualifiedName: over.name, tier: "deep", ...over };
}

/**
 * A file "src/app.ts" defining two symbols (added out of source order), imported
 * by "src/other.ts" which has its own symbol — so the skeleton must list app's
 * symbols in line order, exclude the File node itself and other-file symbols, and
 * report the importer as a dependent.
 */
function setup(): QueryService {
  const store = new InMemoryStore();
  store.addNode(node({ id: "src/app.ts", name: "app.ts", kind: "File", qualifiedName: "" }));
  store.addNode(
    node({ id: "src/app.ts#beta", name: "beta", range: { startLine: 20, endLine: 25 } }),
  );
  store.addNode(
    node({ id: "src/app.ts#alpha", name: "alpha", range: { startLine: 5, endLine: 10 } }),
  );
  store.addNode(
    node({
      id: "src/other.ts",
      name: "other.ts",
      kind: "File",
      file: "src/other.ts",
      qualifiedName: "",
    }),
  );
  store.addNode(
    node({
      id: "src/other.ts#gamma",
      name: "gamma",
      file: "src/other.ts",
      range: { startLine: 1, endLine: 3 },
    }),
  );
  // other.ts imports a *symbol* of app.ts (the common named-import case — Imports
  // edges point at the symbol, not the file); star.ts imports the file itself
  // (import * / export *). Both make app.ts a dependency.
  store.addNode(
    node({
      id: "src/star.ts",
      name: "star.ts",
      kind: "File",
      file: "src/star.ts",
      qualifiedName: "",
    }),
  );
  store.addEdge({ from: "src/other.ts", to: "src/app.ts#alpha", kind: "Imports" });
  store.addEdge({ from: "src/star.ts", to: "src/app.ts", kind: "Imports" });
  return new QueryService(store, "/repo");
}

describe("QueryService.fileSkeleton (ama-m8k.5)", () => {
  it("lists the file's own symbols in source order", () => {
    const skel = setup().fileSkeleton("src/app.ts");
    expect(skel?.symbols.map((n) => n.name)).toEqual(["alpha", "beta"]);
  });

  it("excludes the File node itself and symbols from other files", () => {
    const skel = setup().fileSkeleton("src/app.ts");
    const names = skel?.symbols.map((n) => n.name) ?? [];
    expect(names).not.toContain("app.ts"); // the File node
    expect(names).not.toContain("gamma"); // lives in src/other.ts
  });

  it("reports files that import any of its symbols (or the file itself) as dependents", () => {
    const skel = setup().fileSkeleton("src/app.ts");
    expect(skel?.dependents.map((n) => n.id).sort()).toEqual(["src/other.ts", "src/star.ts"]);
  });

  it("resolves a file by basename too", () => {
    expect(setup().fileSkeleton("app.ts")?.file.id).toBe("src/app.ts");
  });

  it("returns undefined for an unknown file", () => {
    expect(setup().fileSkeleton("src/missing.ts")).toBeUndefined();
  });
});
