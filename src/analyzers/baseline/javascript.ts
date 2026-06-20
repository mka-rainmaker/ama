import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

const JS_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx"];

/** Candidate repo-relative files for a relative JS specifier, resolved against the
 *  importer's directory. An explicit extension is used as-is; otherwise each JS
 *  extension and an `/index.*` variant is tried. A bare/package specifier (not
 *  `./` or `../`) is external and yields no candidates. (ama-2dn) */
function jsCandidates(specifier: string, importerRel: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const base = path.posix.join(path.posix.dirname(importerRel), specifier);
  if (/\.(?:js|mjs|cjs|jsx)$/.test(specifier)) return [base];
  return [...JS_EXTENSIONS.map((e) => base + e), ...JS_EXTENSIONS.map((e) => `${base}/index${e}`)];
}

/** Resolve a JS module dependency to candidate files: an ES `import`/`export … from`
 *  (its `source` field) or a CommonJS `require("…")` call. (ama-2dn) */
function jsImports(node: Parser.SyntaxNode, importerRel: string): string[][] | undefined {
  let str: Parser.SyntaxNode | null = null;
  if (node.type === "import_statement" || node.type === "export_statement") {
    str = node.childForFieldName("source");
  } else if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    if (callee?.type === "identifier" && callee.text === "require") {
      str =
        node.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "string") ?? null;
    }
  }
  if (!str) return undefined;
  const specifier =
    str.namedChildren.find((c) => c.type === "string_fragment")?.text ??
    str.text.replace(/^['"`]|['"`]$/g, "");
  const candidates = jsCandidates(specifier, importerRel);
  return candidates.length > 0 ? [candidates] : [];
}

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
  resolveImports: jsImports,
};
