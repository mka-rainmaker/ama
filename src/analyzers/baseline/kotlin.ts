import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for Kotlin. tree-sitter-kotlin uses one
 * `class_declaration` for class / interface / enum class (refined to Enum by its
 * `enum_class_body`; interfaces stay Class at this tier), `object_declaration`
 * for singletons, and `function_declaration` for functions — methods nest under
 * their class (e.g. `Sample.square`). None carry a `name` field, so the analyzer
 * reads the name from the first identifier child. (ama-0ze)
 */
export const kotlinSpec: LanguageSpec = {
  language: "kotlin",
  extensions: [".kt", ".kts"],
  grammar: "kotlin",
  symbols: {
    class_declaration: { kind: "Class", kindByChild: { enum_class_body: "Enum" } },
    object_declaration: { kind: "Class" },
    function_declaration: { kind: "Function" },
  },
};
