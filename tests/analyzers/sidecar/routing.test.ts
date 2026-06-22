import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { csharpSpec } from "../../../src/analyzers/baseline/csharp.js";
import { AnalyzerRegistry } from "../../../src/analyzers/registry.js";
import { SidecarAnalyzer } from "../../../src/analyzers/sidecar/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.resolve(here, "../../fixtures/sidecar/mock-sidecar.mjs");
const deepSidecar = () => new SidecarAnalyzer("csharp", [".cs"], process.execPath, [mock]);
const bogusSidecar = () => new SidecarAnalyzer("csharp", [".cs"], "ama-no-such-binary-xyzzy", []);

/**
 * Routing: a deep sidecar takes over a language the baseline also claims, but only when
 * it's actually available — otherwise the baseline keeps it. (ama-3bb.4)
 */
describe("analyzer routing: deep-if-available, else baseline (ama-3bb.4)", () => {
  it("prefers a deep analyzer over baseline for a shared extension, either order", () => {
    const baselineFirst = new AnalyzerRegistry();
    baselineFirst.register(new BaselineAnalyzer(csharpSpec));
    baselineFirst.register(deepSidecar());
    expect(baselineFirst.forFile("a.cs")?.tier).toBe("deep");

    const deepFirst = new AnalyzerRegistry();
    deepFirst.register(deepSidecar());
    deepFirst.register(new BaselineAnalyzer(csharpSpec));
    expect(deepFirst.forFile("a.cs")?.tier).toBe("deep");
  });

  it("registers an available sidecar, so it wins over the baseline", async () => {
    const registry = new AnalyzerRegistry();
    registry.register(new BaselineAnalyzer(csharpSpec));
    expect(await registry.registerIfAvailable(deepSidecar())).toBe(true);
    expect(registry.forFile("a.cs")?.tier).toBe("deep");
  });

  it("leaves the language to baseline when the sidecar is unavailable", async () => {
    const registry = new AnalyzerRegistry();
    registry.register(new BaselineAnalyzer(csharpSpec));
    expect(await registry.registerIfAvailable(bogusSidecar())).toBe(false);
    expect(registry.forFile("a.cs")?.tier).toBe("baseline");
  });

  it("probes availability via the ready handshake", async () => {
    expect(await deepSidecar().isAvailable()).toBe(true);
    expect(await bogusSidecar().isAvailable()).toBe(false);
  });
});
