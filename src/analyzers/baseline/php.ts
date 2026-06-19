import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for PHP. Each top-level construct has its own CST
 * node type — class/interface/trait/enum declarations, free functions, and
 * methods inside a class body — so each maps directly to a graph kind, and
 * methods qualify under their type (e.g. `Sample.square`). A trait is a set of
 * reusable method implementations, so it's modelled as a Class (the closest
 * kind); there's no dedicated Trait kind.
 */
export const phpSpec: LanguageSpec = {
  language: "php",
  extensions: [".php"],
  grammar: "php",
  symbols: {
    class_declaration: { kind: "Class" },
    interface_declaration: { kind: "Interface" },
    trait_declaration: { kind: "Class" },
    enum_declaration: { kind: "Enum" },
    function_definition: { kind: "Function" },
    method_declaration: { kind: "Method" },
  },
};
