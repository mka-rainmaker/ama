import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypeScriptAnalyzer } from "../../src/analyzers/typescript/analyzer.js";
import type { GraphEdge, GraphNode } from "../../src/graph/index.js";
import { derivePrismaReferences } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-prisma-field");

/**
 * Field-level Prisma linkage: keys of where/select/orderBy/data objects in a `prisma.<model>`
 * query are tagged `prisma:field:<model>.<field>` and resolved to the schema's `Model.field`
 * Property node, so impact_analysis(User.email) reaches the code that queries it. (ama-bgu) */
describe("Field-level Prisma linkage (ama-bgu)", () => {
  it("the TS analyzer emits prisma:field candidates from query-arg object keys", async () => {
    const result = await new TypeScriptAnalyzer().analyze(root, ["queries.ts"]);
    const fieldRefs = result.edges
      .filter((e) => e.provenance === "prisma-ref" && e.to.startsWith("prisma:field:"))
      .map((e) => e.to);
    expect(fieldRefs).toContain("prisma:field:user.email"); // where + select shorthand
    expect(fieldRefs).toContain("prisma:field:user.name"); // where
    expect(fieldRefs).toContain("prisma:field:user.createdat"); // orderBy
  });

  it("derivePrismaReferences resolves a field candidate to its Model.field Property", () => {
    const nodes: GraphNode[] = [
      {
        id: "p",
        kind: "Property",
        name: "email",
        file: "schema.prisma",
        qualifiedName: "User.email",
        tier: "deep",
      },
      {
        id: "c",
        kind: "Class",
        name: "User",
        file: "schema.prisma",
        qualifiedName: "User",
        tier: "deep",
      },
    ];
    const edges: GraphEdge[] = [
      {
        from: "caller",
        to: "prisma:field:user.email",
        kind: "References",
        provenance: "prisma-ref",
      },
    ];
    expect(derivePrismaReferences(nodes, edges)).toContainEqual({
      from: "caller",
      to: "p",
      kind: "References",
      provenance: "prisma",
    });
  });
});
