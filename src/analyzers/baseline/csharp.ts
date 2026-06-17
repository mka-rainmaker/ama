import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for C#. Like Java, every kind has its own CST node
 * type. Structs and records are value/data types with members, mapped to Class
 * (the graph has no dedicated struct/record kind); methods nest under their
 * type's body (e.g. `Sample.Square`).
 */
export const csharpSpec: LanguageSpec = {
  language: "csharp",
  extensions: [".cs"],
  grammar: "csharp",
  symbols: {
    class_declaration: { kind: "Class" },
    interface_declaration: { kind: "Interface" },
    struct_declaration: { kind: "Class" },
    record_declaration: { kind: "Class" },
    enum_declaration: { kind: "Enum" },
    method_declaration: { kind: "Method" },
  },
};
