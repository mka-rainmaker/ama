import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SfcAnalyzer } from "../../src/analyzers/sfc/analyzer.js";
import { fileId, symbolId } from "../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/sfc");

/**
 * A `.vue`/`.svelte` single-file component was indexed by no analyzer at all. The SFC
 * analyzer gives it baseline breadth: a Component node named from the file, and the
 * modules its `<script>` imports wired into the File→File import graph. (ama-krw)
 */
describe("SfcAnalyzer (.vue/.svelte) (ama-krw)", () => {
  const result = new SfcAnalyzer("vue", [".vue"]).analyze(root, ["Widget.vue", "Card.vue"]);

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
});
