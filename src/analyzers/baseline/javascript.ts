import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for JavaScript (and JSX — tree-sitter-javascript
 * parses JSX too). Unlike Python, JS distinguishes methods syntactically
 * (`method_definition`), so class methods surface as Method nodes qualified
 * under their class. The `.ts`/`.tsx` extensions stay with the deep TypeScript
 * analyzer; this claims the plain-JS variants.
 */
export const javascriptSpec: LanguageSpec = {
  language: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  grammar: "javascript",
  symbols: {
    function_declaration: { kind: "Function" },
    generator_function_declaration: { kind: "Function" },
    class_declaration: { kind: "Class" },
    method_definition: { kind: "Method" },
  },
};
