import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type GraphEdge,
  type GraphNode,
  derivePrismaReferences,
  symbolId,
} from "../../src/graph/index.js";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import type { Store } from "../../src/store/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/prisma-link");

/**
 * The payoff of Prisma-awareness: a `prisma.<model>` call in TS links to the schema model
 * node, so find_referrers/impact_analysis cross the code↔schema boundary. The TS analyzer
 * emits a raw candidate; a whole-graph pass resolves it to the model by name. (ama-kvv)
 */
describe("Prisma client → model linkage (ama-kvv)", () => {
  describe("derivePrismaReferences (pure)", () => {
    const model: GraphNode = {
      id: "M",
      kind: "Class",
      name: "User",
      file: "schema.prisma",
      qualifiedName: "User",
      tier: "deep",
    };

    it("resolves a prisma-ref candidate to the model node by name", () => {
      const candidates: GraphEdge[] = [
        { from: "fn", to: "prisma:model:user", kind: "References", provenance: "prisma-ref" },
      ];
      expect(derivePrismaReferences([model], candidates)).toEqual([
        { from: "fn", to: "M", kind: "References", provenance: "prisma" },
      ]);
    });

    it("drops a candidate with no matching model", () => {
      const candidates: GraphEdge[] = [
        { from: "fn", to: "prisma:model:ghost", kind: "References", provenance: "prisma-ref" },
      ];
      expect(derivePrismaReferences([model], candidates)).toEqual([]);
    });
  });

  describe("end-to-end via the indexer", () => {
    let store: Store;
    beforeAll(async () => {
      ({ store } = await createDefaultIndexer().index(root));
    });
    const links = (fn: string, modelName: string) =>
      [...store.allEdges()].some(
        (e) =>
          e.provenance === "prisma" &&
          e.kind === "References" &&
          e.from === symbolId({ file: "repo.ts", qualifiedName: fn }) &&
          e.to === symbolId({ file: "schema.prisma", qualifiedName: modelName }),
      );

    it("links prisma.<model> usage in TS to the schema model node", () => {
      expect(links("listUsers", "User")).toBe(true);
      expect(links("createPost", "Post")).toBe(true);
    });
  });
});
