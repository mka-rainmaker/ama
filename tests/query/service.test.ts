import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-calls");

describe("QueryService", () => {
  let q: QueryService;
  beforeAll(async () => {
    const store = new InMemoryStore();
    const { nodes, edges } = await new TypeScriptAnalyzer().analyze(root, ["calls.ts"]);
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, root);
  });

  it("searches symbols by case-insensitive name substring", () => {
    const hits = q.searchSymbol("COMP");
    expect(hits.map((n) => n.qualifiedName)).toContain("Service.compute");
  });

  it("finds all callers of a function", () => {
    const names = q
      .findCallers("helper")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["Service.compute", "main"]);
  });

  it("finds the callees of a method", () => {
    const callees = q.findCallees("Service.compute");
    expect(callees.map((n) => n.name)).toContain("helper");
  });

  it("returns a verbatim source snippet for a symbol", () => {
    const snip = q.getCodeSnippet("helper");
    expect(snip?.startLine).toBe(1);
    expect(snip?.text).toContain("return 42;");
  });

  it("resolves an exact node id as well as a bare name", () => {
    const byName = q.getCodeSnippet("Service.compute");
    const byId = q.getCodeSnippet("calls.ts#Service.compute");
    expect(byId?.text).toBe(byName?.text);
  });

  it("returns empty / undefined for unknown symbols", () => {
    expect(q.findCallers("doesNotExist")).toEqual([]);
    expect(q.getCodeSnippet("doesNotExist")).toBeUndefined();
  });

  it("assembles a node view: definition, source, callers, callees, and dependents", () => {
    const view = q.node("helper");
    expect(view?.node.name).toBe("helper");
    expect(view?.snippet?.text).toContain("return 42;");
    expect(view?.callers.map((n) => n.qualifiedName).sort()).toEqual(["Service.compute", "main"]);
    // helper just returns a literal and isn't imported anywhere in this fixture.
    expect(view?.callees).toEqual([]);
    expect(view?.dependents).toEqual([]);
  });

  it("returns undefined from node() for an unknown ref", () => {
    expect(q.node("doesNotExist")).toBeUndefined();
  });

  it("computes the transitive blast radius of a symbol", () => {
    // helper <- {main, Service.compute}; Service.compute <- Service.run, so
    // Service.run is reached only transitively (it never calls helper directly).
    const names = q
      .impactAnalysis("helper")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["Service.compute", "Service.run", "main"]);
  });

  it("bounds the blast radius by depth", () => {
    const names = q
      .impactAnalysis("helper", 1)
      .map((n) => n.qualifiedName)
      .sort();
    // Depth 1 = direct callers only; Service.run (depth 2) is excluded.
    expect(names).toEqual(["Service.compute", "main"]);
  });

  it("returns empty impact for an entry point and for unknown refs", () => {
    expect(q.impactAnalysis("main")).toEqual([]);
    expect(q.impactAnalysis("doesNotExist")).toEqual([]);
  });

  it("summarizes the graph schema: node and edge kinds with counts", () => {
    const schema = q.getGraphSchema();
    expect(schema.nodes.Function).toBe(2); // helper, main
    expect(schema.nodes.Method).toBe(2); // Service.run, Service.compute
    expect(schema.nodes.Class).toBe(1); // Service
    // main->helper, Service.run->Service.compute, Service.compute->helper
    expect(schema.edges.Calls).toBe(3);
    expect(schema.edges.Defines).toBeGreaterThan(0);
  });
});

const implRoot = path.resolve(here, "../fixtures/ts-implements");

describe("QueryService implements queries", () => {
  let q: QueryService;
  beforeAll(async () => {
    const store = new InMemoryStore();
    const { nodes, edges } = await new TypeScriptAnalyzer().analyze(implRoot, ["impl.ts"]);
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, implRoot);
  });

  it("finds every class that implements an interface", () => {
    const names = q
      .findImplementations("Greeter")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["FriendlyGreeter", "Person"]);
  });

  it("finds the interfaces a class implements", () => {
    const names = q
      .findInterfaces("Person")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["Greeter", "Named"]);
  });

  it("returns empty for a class with no heritage and unknown symbols", () => {
    expect(q.findInterfaces("Plain")).toEqual([]);
    expect(q.findImplementations("Plain")).toEqual([]);
    expect(q.findImplementations("doesNotExist")).toEqual([]);
  });
});

const importsRoot = path.resolve(here, "../fixtures/ts-imports");

describe("QueryService imports queries", () => {
  let q: QueryService;
  beforeAll(async () => {
    const store = new InMemoryStore();
    const { nodes, edges } = await new TypeScriptAnalyzer().analyze(importsRoot, [
      "lib.ts",
      "barrel.ts",
      "main.ts",
    ]);
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, importsRoot);
  });

  it("finds the symbols a file imports", () => {
    const names = q
      .findImports("main.ts")
      .map((n) => n.name)
      .sort();
    // `lib.ts` is the File node — main.ts's `import * as lib` targets the whole module.
    expect(names).toEqual(["Widget", "greet", "lib.ts", "makeDefault"]);
  });

  it("finds every file that imports a symbol, including via a re-export barrel", () => {
    const names = q
      .findImporters("greet")
      .map((n) => n.name)
      .sort();
    expect(names).toEqual(["barrel.ts", "main.ts"]);
  });

  it("finds the single file importing a symbol used in one place", () => {
    const names = q.findImporters("Widget").map((n) => n.name);
    expect(names).toEqual(["main.ts"]);
  });

  it("returns empty for a file that imports nothing and for unknown refs", () => {
    expect(q.findImports("lib.ts")).toEqual([]);
    expect(q.findImports("doesNotExist")).toEqual([]);
    expect(q.findImporters("doesNotExist")).toEqual([]);
  });
});

const usesTypeRoot = path.resolve(here, "../fixtures/ts-usestype");

describe("QueryService UsesType queries", () => {
  let q: QueryService;
  beforeAll(async () => {
    const store = new InMemoryStore();
    const { nodes, edges } = await new TypeScriptAnalyzer().analyze(usesTypeRoot, ["usetype.ts"]);
    for (const n of nodes) store.addNode(n);
    for (const e of edges) store.addEdge(e);
    q = new QueryService(store, usesTypeRoot);
  });

  it("finds every symbol that uses a type in a param/return/property", () => {
    const names = q
      .findTypeUsers("Widget")
      .map((n) => n.qualifiedName)
      .sort();
    // Widget annotates build's param, make's param, Holder's property, and many's array param.
    expect(names).toEqual(["Factory.make", "Holder", "build", "many"]);
  });

  it("finds users of a type referenced only as a return type", () => {
    const names = q
      .findTypeUsers("Gadget")
      .map((n) => n.qualifiedName)
      .sort();
    expect(names).toEqual(["Factory.make", "build"]);
  });

  it("finds the types a symbol uses, attributing properties to the enclosing class", () => {
    const fromBuild = q
      .findTypesUsed("build")
      .map((n) => n.name)
      .sort();
    expect(fromBuild).toEqual(["Gadget", "Widget"]);
    expect(q.findTypesUsed("Holder").map((n) => n.name)).toEqual(["Widget"]);
  });

  it("returns empty for a primitive-only signature and for unknown refs", () => {
    expect(q.findTypesUsed("plain")).toEqual([]);
    expect(q.findTypesUsed("doesNotExist")).toEqual([]);
    expect(q.findTypeUsers("doesNotExist")).toEqual([]);
  });
});
