import type { LanguageSpec } from "./analyzer.js";

/**
 * Baseline (syntactic) spec for Python. Functions and classes are the symbols
 * worth a node; methods are `function_definition` too (Python doesn't
 * distinguish them syntactically), so they surface as Functions qualified under
 * their class (e.g. `Greeter.hello`). Decorated defs nest a `function_definition`
 * inside a `decorated_definition`, which the analyzer's recursion already reaches.
 */
export const pythonSpec: LanguageSpec = {
  language: "python",
  extensions: [".py"],
  grammar: "python",
  symbols: {
    function_definition: { kind: "Function" },
    class_definition: { kind: "Class" },
  },
};
