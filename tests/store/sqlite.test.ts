import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../src/graph/index.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { runStoreContract } from "./contract.js";

// Same contract as the in-memory store — proves the two backends are at parity.
runStoreContract("SqliteStore (in-memory db)", () => new SqliteStore());

describe("SqliteStore persistence", () => {
  it("survives close and reopen of a file-backed database", () => {
    const file = path.join(
      os.tmpdir(),
      `ama-store-${process.pid}-${Math.floor(performance.now())}.db`,
    );
    const fn: GraphNode = {
      id: "x.ts#f",
      kind: "Function",
      name: "f",
      file: "x.ts",
      qualifiedName: "f",
      tier: "deep",
      range: { startLine: 1, endLine: 3 },
    };
    try {
      const writer = new SqliteStore(file);
      writer.addNode(fn);
      writer.addEdge({ from: "x.ts#f", to: "x.ts#g", kind: "Calls" });
      writer.close();

      const reader = new SqliteStore(file);
      expect(reader.getNode("x.ts#f")).toEqual(fn);
      expect(reader.edgesFrom("x.ts#f", "Calls").map((e) => e.to)).toEqual(["x.ts#g"]);
      expect(reader.nodeCount).toBe(1);
      // The FTS5 index persists too — search works without re-indexing.
      expect(reader.searchByName("f").map((n) => n.id)).toEqual(["x.ts#f"]);
      reader.close();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("opens file-backed databases in WAL mode", () => {
    const file = path.join(
      os.tmpdir(),
      `ama-wal-${process.pid}-${Math.floor(performance.now())}.db`,
    );
    try {
      const store = new SqliteStore(file);
      store.addNode({
        id: "x.ts#f",
        kind: "Function",
        name: "f",
        file: "x.ts",
        qualifiedName: "f",
        tier: "deep",
      });
      // WAL keeps a `-wal` sidecar until checkpoint; its presence proves the mode.
      expect(fs.existsSync(`${file}-wal`)).toBe(true);
      store.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(`${file}${suffix}`, { force: true });
      }
    }
  });
});
