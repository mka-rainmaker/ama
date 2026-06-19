import { describe, expect, it } from "vitest";
import {
  parse,
  parsersAllocated,
  supportedLanguages,
} from "../../../src/analyzers/baseline/treesitter.js";

describe("tree-sitter parsing primitive", () => {
  it("parses Python source into a CST with the grammar loaded on demand", async () => {
    const tree = await parse("python", "def greet(name):\n    return name\n");
    expect(tree.rootNode.type).toBe("module");
    expect(tree.rootNode.namedChild(0)?.type).toBe("function_definition");
  });

  it("parses a second language (JavaScript) — grammars load independently", async () => {
    const tree = await parse("javascript", "function add(a, b) {\n  return a + b;\n}\n");
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.namedChild(0)?.type).toBe("function_declaration");
  });

  it("lists the languages it has a bundled grammar for", () => {
    expect(supportedLanguages()).toContain("python");
    expect(supportedLanguages()).toContain("javascript");
  });

  it("rejects a language with no bundled grammar", async () => {
    await expect(parse("klingon", "nuqneH")).rejects.toThrow(/grammar/i);
  });

  it("reuses one parser across many parses instead of leaking one per call (ama-5o1)", async () => {
    const before = parsersAllocated();
    for (let i = 0; i < 25; i++) {
      const py = await parse("python", "x = 1");
      py.delete();
      const js = await parse("javascript", "const y = 2;");
      js.delete();
    }
    // The leak was a fresh Parser per call (50 here); a reused parser allocates ≤1.
    expect(parsersAllocated() - before).toBeLessThanOrEqual(1);
  });
});
