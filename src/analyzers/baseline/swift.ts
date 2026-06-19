import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for Swift. tree-sitter-swift carries a `name` field,
 * so no special extraction is needed. `class`, `struct`, and `enum` share one
 * `class_declaration` (an enum is refined to Enum by its `enum_class_body`;
 * structs stay Class at this tier); `protocol_declaration` is an Interface; and
 * `function_declaration` covers free functions and methods, which nest under
 * their type (e.g. `Sample.square`). (ama-p3a)
 */
export const swiftSpec: LanguageSpec = {
  language: "swift",
  extensions: [".swift"],
  grammar: "swift",
  symbols: {
    class_declaration: { kind: "Class", kindByChild: { enum_class_body: "Enum" } },
    protocol_declaration: { kind: "Interface" },
    function_declaration: { kind: "Function" },
  },
};
