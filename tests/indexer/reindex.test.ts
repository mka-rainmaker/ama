import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmaSession } from "../../src/mcp/session.js";

// Single-file re-index (ama-gd5.1): re-analyze one changed file and merge its
// delta into the live store, without a full rebuild. The hard part is keeping
// the graph correct across files — a re-analyzed file's edges into files this
// pass never walks must still resolve, and edges owned by those other files
// must survive untouched. The fixture cross-references a <-> b to test both.
describe("single-file re-index (reindexFile)", () => {
  let dir: string;
  let session: AmaSession;
  const write = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);

  const A = [
    'import { helper } from "./b.js";',
    "export function target(): void {",
    "  helper();",
    "}",
    "export interface Shape { kind: string; }",
    "",
  ].join("\n");
  const B = [
    'import { target } from "./a.js";',
    'import type { Shape } from "./a.js";',
    "export function helper(): void {}",
    "export function caller(s: Shape): void {",
    "  void s;",
    "  target();",
    "}",
    "",
  ].join("\n");

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-reindex-"));
    write("a.ts", A);
    write("b.ts", B);
    session = new AmaSession();
    await session.indexRepository(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a symbol added to only the re-indexed file", async () => {
    expect(session.searchSymbol("added")).toEqual([]);
    write("b.ts", `${B}export function added(): void {}\n`);
    await session.reindexFile("b.ts");
    const hit = session.searchSymbol("added").find((n) => n.kind === "Function");
    expect(hit?.file).toBe("b.ts");
  });

  it("re-resolves a re-indexed file's outbound edges against files it never walks", async () => {
    expect(session.findCallees("caller").map((n) => n.name)).toContain("target");
    expect(session.findImports("b.ts").map((n) => n.name)).toEqual(
      expect.arrayContaining(["target", "Shape"]),
    );

    write("b.ts", `${B}export function added(): void {}\n`); // change b only
    await session.reindexFile("b.ts");

    // Re-analyzing b alone never walks a, so caller->target and b's imports must
    // be re-resolved by location against a's still-present nodes.
    expect(session.findCallees("caller").map((n) => n.name)).toContain("target");
    expect(session.findImports("b.ts").map((n) => n.name)).toEqual(
      expect.arrayContaining(["target", "Shape"]),
    );
  });

  it("leaves edges owned by a file that was not re-indexed untouched", async () => {
    // a.ts calls helper (in b). That edge is owned by a, not b.
    expect(session.findCallees("target").map((n) => n.name)).toContain("helper");
    write("b.ts", B.replace("void s;", "void s; // touched"));
    await session.reindexFile("b.ts");
    // Reconciling b must not disturb a's call into b.
    expect(session.findCallees("target").map((n) => n.name)).toContain("helper");
  });

  it("drops a symbol removed from the re-indexed file", async () => {
    expect(session.searchSymbol("caller").some((n) => n.kind === "Function")).toBe(true);
    write("b.ts", "export function helper(): void {}\n"); // caller deleted
    await session.reindexFile("b.ts");
    expect(session.searchSymbol("caller").filter((n) => n.kind === "Function")).toEqual([]);
    // helper survives the edit, so a's call into it stays valid.
    expect(session.findCallees("target").map((n) => n.name)).toContain("helper");
  });
});
