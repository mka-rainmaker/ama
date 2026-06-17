import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for Go. Go declares named types with a single
 * `type_spec` node regardless of whether the body is a struct, interface, or
 * alias — so it uses {@link SymbolRule.kindByChild} to refine: a `struct_type`
 * child → Class, an `interface_type` child → Interface, else a TypeAlias.
 * Methods are top-level `method_declaration`s (the receiver isn't a container),
 * so they surface as Methods named for the function, not qualified by the type.
 */
export const goSpec: LanguageSpec = {
  language: "go",
  extensions: [".go"],
  grammar: "go",
  symbols: {
    function_declaration: { kind: "Function" },
    method_declaration: { kind: "Method" },
    type_spec: {
      kind: "TypeAlias",
      kindByChild: { struct_type: "Class", interface_type: "Interface" },
    },
  },
};
