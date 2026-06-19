import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) specs for C and C++. Both share a grammar family: structs,
 * unions, enums, and typedefs carry a `name` field, while a `function_definition`
 * nests its name in a `declarator` chain — the analyzer's `symbolName` drills that
 * for us. C++ adds classes and namespaces; a method defined inline is a
 * `function_definition` inside the class body, so it surfaces as a Function
 * qualified under its class (e.g. `Sample.square`). (ama-s8q.9)
 */
export const cSpec: LanguageSpec = {
  language: "c",
  extensions: [".c"],
  grammar: "c",
  symbols: {
    function_definition: { kind: "Function" },
    struct_specifier: { kind: "Class" },
    union_specifier: { kind: "Class" },
    enum_specifier: { kind: "Enum" },
    type_definition: { kind: "TypeAlias" },
  },
};

export const cppSpec: LanguageSpec = {
  language: "cpp",
  // `.h` routes here: the C++ grammar is a superset, so it parses C headers too.
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".h"],
  grammar: "cpp",
  symbols: {
    function_definition: { kind: "Function" },
    struct_specifier: { kind: "Class" },
    union_specifier: { kind: "Class" },
    enum_specifier: { kind: "Enum" },
    type_definition: { kind: "TypeAlias" },
    class_specifier: { kind: "Class" },
    namespace_definition: { kind: "Module" },
  },
};
