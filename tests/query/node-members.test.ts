import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultIndexer } from "../../src/indexer/indexer.js";
import { QueryService } from "../../src/query/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/ts-node-members");

/**
 * node() answers "everything about one node", but it omitted the symbols the node
 * defines — so node(SomeClass) listed no methods/properties. It should include them
 * as structured members. (ama-as5)
 */
describe("node() includes a container's members (ama-as5)", () => {
  let q: QueryService;
  beforeAll(async () => {
    const { store } = await createDefaultIndexer().index(root);
    q = new QueryService(store, root);
  });

  it("lists the symbols a class defines", () => {
    const names = q.node("Box")?.members.map((m) => m.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
  });

  it("leaves a leaf (a plain function) with no members", () => {
    expect(q.node("run")?.members).toEqual([]);
  });
});
