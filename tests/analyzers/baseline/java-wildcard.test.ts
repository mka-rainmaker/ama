import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import {
  type GraphEdge,
  type GraphNode,
  deriveTypeEdges,
  symbolId,
} from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/java-wildcard");
const FILES = ["com/app/User.java", "com/lib/Base.java"];

/**
 * Scope-aware resolution (#34 failure mode #2): `import com.lib.*` brings the whole `com.lib` package
 * into scope, so `class User extends Base` resolves to `com.lib.Base` even though `Base` is neither a
 * same-package sibling nor a specific import. The resolver treats a wildcard import as a directory
 * (package) scope, mirroring same-package resolution.
 */
describe("Java wildcard import resolution (#34 failure mode #2)", () => {
  let nodes: GraphNode[];
  let edges: GraphEdge[];
  beforeAll(async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(root, FILES);
    nodes = result.nodes;
    const base = result.edges.filter((e) => e.provenance !== "type");
    edges = [...base, ...deriveTypeEdges(nodes, base)];
  });

  it("resolves a supertype reached through a wildcard package import (no specific import)", () => {
    expect(
      edges.some(
        (e) =>
          e.kind === "Inherits" &&
          e.provenance === "type" &&
          e.from === symbolId({ file: "com/app/User.java", qualifiedName: "User" }) &&
          e.to === symbolId({ file: "com/lib/Base.java", qualifiedName: "Base" }),
      ),
    ).toBe(true);
  });
});
