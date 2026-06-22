import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SfcAnalyzer } from "../../src/analyzers/sfc/analyzer.js";
import type { AnalysisResult } from "../../src/analyzers/types.js";
import { fileId, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/sfc");

/**
 * A `.vue`/`.svelte` single-file component was indexed by no analyzer at all. The SFC
 * analyzer gives it baseline breadth: a Component node named from the file, the modules
 * its `<script>` imports wired into the File→File import graph, and the `<script>`'s own
 * symbols (offset back to file lines). (ama-krw, ama-q1u)
 */
describe("SfcAnalyzer (.vue/.svelte) (ama-krw)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new SfcAnalyzer("vue", [".vue"]).analyze(root, ["Widget.vue", "Card.vue"]);
  });

  it("emits a Component node named from the filename", () => {
    const widget = result.nodes.find(
      (n) => n.id === symbolId({ file: "Widget.vue", qualifiedName: "Widget" }),
    );
    expect(widget?.kind).toBe("Component");
    expect(widget?.name).toBe("Widget");
    expect(widget?.tier).toBe("baseline");
  });

  it("wires the <script> imports into the file import graph", () => {
    const imports = result.edges
      .filter((e) => e.kind === "Imports" && e.from === fileId("Widget.vue"))
      .map((e) => e.to);
    expect(imports).toContain(fileId("helper.ts")); // ./helper → helper.ts (extensionless)
    expect(imports).toContain(fileId("Card.vue")); // ./Card.vue → Card.vue (explicit)
  });

  it("emits <script> symbols with file-relative line numbers (offset-mapped)", () => {
    const greet = result.nodes.find(
      (n) => n.id === symbolId({ file: "Widget.vue", qualifiedName: "greet" }),
    );
    expect(greet?.kind).toBe("Function");
    // `function greet` is on file line 12 — the parsed <script> row offset back to it.
    expect(greet?.range.startLine).toBe(12);
  });
});

/**
 * The SfcAnalyzer is registered for `.svelte` too (same engine), and SFCs lean on
 * dynamic `import()` for lazy components/routes — both must be covered. (ama-grb)
 */
describe("SfcAnalyzer on Svelte + dynamic imports (ama-grb)", () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    result = await new SfcAnalyzer("svelte", [".svelte"]).analyze(root, [
      "Toggle.svelte",
      "Panel.svelte",
    ]);
  });
  const importsFrom = (rel: string) =>
    result.edges.filter((e) => e.kind === "Imports" && e.from === fileId(rel)).map((e) => e.to);

  it("detects a .svelte file as a Component", () => {
    const toggle = result.nodes.find(
      (n) => n.id === symbolId({ file: "Toggle.svelte", qualifiedName: "Toggle" }),
    );
    expect(toggle?.kind).toBe("Component");
    expect(toggle?.name).toBe("Toggle");
  });

  it("captures static and dynamic (lazy) <script> imports", () => {
    const imports = importsFrom("Toggle.svelte");
    expect(imports).toContain(fileId("helper.ts")); // static: import { helper } from "./helper"
    expect(imports).toContain(fileId("Panel.svelte")); // dynamic: import("./Panel.svelte")
  });
});
