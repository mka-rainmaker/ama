import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../src/analyzers/baseline/java.js";
import { deriveTypeEdges } from "../../src/graph/index.js";
import { QueryService } from "../../src/query/service.js";
import { InMemoryStore } from "../../src/store/memory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/java-external");

/**
 * End-to-end (#47): the Java analyzer emits a `type:Runnable` candidate for `implements Runnable`,
 * deriveTypeEdges can't resolve it (no on-disk node), the candidate survives in the store, and
 * node() surfaces `Runnable` as an external supertype rather than dropping it — mirroring the
 * indexer's relinkTypes order. Proves the whole pipeline, not just the query helper.
 */
describe("node() surfaces an unresolved JDK/dependency supertype end-to-end (#47)", () => {
  let q: QueryService;
  beforeAll(async () => {
    const { nodes, edges } = await new BaselineAnalyzer(javaSpec).analyze(root, [
      "com/app/Worker.java",
    ]);
    const base = edges.filter((e) => e.provenance !== "type");
    const all = [...base, ...deriveTypeEdges(nodes, base)];
    const store = new InMemoryStore();
    for (const node of nodes) store.addNode(node);
    for (const edge of all) store.addEdge(edge);
    q = new QueryService(store, root);
  });

  it("reports `Runnable` (a JDK type, no on-disk node) as an external supertype", () => {
    const view = q.node("Worker");
    if (!view) throw new Error("expected a node");
    expect(view.externalSupertypes).toEqual(["Runnable"]);
  });
});
