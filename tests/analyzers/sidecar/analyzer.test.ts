import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SidecarAnalyzer } from "../../../src/analyzers/sidecar/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.resolve(here, "../../fixtures/sidecar/mock-sidecar.mjs");

/**
 * The TS-side harness: spawn a subprocess sidecar, speak the protocol, and surface its
 * deep nodes/edges — proven end-to-end against a mock sidecar before any real
 * Roslyn/Java tool exists. (ama-3bb.1)
 */
describe("SidecarAnalyzer (ama-3bb.1)", () => {
  it("round-trips an analyze request to a subprocess and returns its deep nodes", async () => {
    const analyzer = new SidecarAnalyzer("mock", [".mock"], process.execPath, [mock]);
    expect(analyzer.tier).toBe("deep");
    const result = await analyzer.analyze("/some/root", ["a.mock", "b.mock"]);
    // The mock echoes one deep File node per requested file.
    expect(result.nodes.map((n) => n.id)).toEqual(["a.mock", "b.mock"]);
    expect(result.nodes.every((n) => n.tier === "deep")).toBe(true);
  });

  it("rejects when the sidecar command can't be spawned", async () => {
    const analyzer = new SidecarAnalyzer("nope", [".x"], "ama-no-such-sidecar-binary-xyzzy", []);
    await expect(analyzer.analyze("/some/root", ["a.x"])).rejects.toThrow();
  });
});
