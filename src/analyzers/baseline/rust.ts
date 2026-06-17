import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for Rust. Rust gives each kind its own node type, so
 * the plain map suffices: struct → Class, enum → Enum, trait → Interface, fn →
 * Function. Trait methods nest under the trait (`Shape.area`); methods defined
 * in separate `impl` blocks are top-level `function_item`s (the impl isn't a
 * container), so they surface unqualified — acceptable for a syntactic tier.
 */
export const rustSpec: LanguageSpec = {
  language: "rust",
  extensions: [".rs"],
  grammar: "rust",
  symbols: {
    function_item: { kind: "Function" },
    // A bodyless fn (trait method declaration, extern block) is a signature item.
    function_signature_item: { kind: "Function" },
    struct_item: { kind: "Class" },
    enum_item: { kind: "Enum" },
    trait_item: { kind: "Interface" },
  },
};
