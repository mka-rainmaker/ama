import * as fs from "node:fs";
import * as path from "node:path";
import { type GraphEdge, type GraphNode, fileId, symbolId } from "../../graph/index.js";
import { parse } from "../baseline/treesitter.js";
import { type SymbolRule, walkSymbols } from "../baseline/walk.js";
import type { AnalysisResult, Analyzer } from "../types.js";

/** Extensions an SFC `<script>` import may resolve to — sibling components, plus
 *  the TS/JS modules they pull in (composables, stores, utils). */
const SFC_EXTENSIONS = [".vue", ".svelte", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Symbols a `<script>` defines, by tree-sitter-typescript node type (which parses
 *  plain JS too). Baseline-tier breadth: declarations, not calls/types. (ama-q1u) */
const SFC_SYMBOLS: Readonly<Record<string, SymbolRule>> = {
  function_declaration: { kind: "Function" },
  generator_function_declaration: { kind: "Function" },
  class_declaration: { kind: "Class" },
  abstract_class_declaration: { kind: "Class" },
  method_definition: { kind: "Method" },
  interface_declaration: { kind: "Interface" },
  type_alias_declaration: { kind: "TypeAlias" },
  enum_declaration: { kind: "Enum" },
};

/** Candidate repo-relative files for a relative SFC import specifier, resolved against
 *  the importer's directory. An explicit known extension is used as-is; otherwise each
 *  SFC/TS/JS extension and an `/index.*` variant is tried. A bare/package specifier
 *  (not `./` or `../`) is external and yields no candidates. (ama-krw) */
function sfcCandidates(specifier: string, importerRel: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const base = path.posix.join(path.posix.dirname(importerRel), specifier);
  if (/\.(?:vue|svelte|tsx?|jsx?|mjs|cjs)$/.test(specifier)) return [base];
  return [
    ...SFC_EXTENSIONS.map((e) => base + e),
    ...SFC_EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

/** Each `<script>` block's source paired with the file line its content starts on, so a
 *  symbol parsed out of the block maps back to a real file line. Vue allows two blocks
 *  (`<script>` + `<script setup>`); Svelte adds `<script context="module">`. */
function scriptBlocks(code: string): { code: string; lineOffset: number }[] {
  const blocks: { code: string; lineOffset: number }[] = [];
  for (const m of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const content = m[1] ?? "";
    const contentStart = (m.index ?? 0) + m[0].length - content.length - "</script>".length;
    const lineOffset = code.slice(0, contentStart).split("\n").length - 1;
    blocks.push({ code: content, lineOffset });
  }
  return blocks;
}

/** Module specifiers a `<script>` imports or re-exports: `… from "x"` (import,
 *  `export … from`), side-effect `import "x"`, and dynamic `import("x")` — the last
 *  is how SFCs lazy-load components/routes, so it belongs in the import graph too.
 *  Baseline (syntactic) breadth: a best-effort scan, not a full parse. (ama-krw, ama-grb) */
function importSpecifiers(script: string): string[] {
  const specs: string[] = [];
  for (const m of script.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1] as string);
  for (const m of script.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1] as string);
  for (const m of script.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1] as string);
  return specs;
}

/**
 * Baseline (syntactic) analyzer for single-file components. A `.vue`/`.svelte` file
 * becomes a {@link "Component"} node named after the file; the modules its `<script>`
 * imports become File→File `Imports` edges; and the symbols the `<script>` declares
 * (functions, classes, methods, types) become nodes with file-relative line numbers,
 * so SFCs are searchable, connected, and navigable. Calls/types resolution is deep-tier
 * and out of scope. One instance per language (vue/svelte) for honest coverage. (ama-krw, ama-q1u)
 */
export class SfcAnalyzer implements Analyzer {
  readonly tier = "baseline";

  constructor(
    readonly language: string,
    readonly extensions: readonly string[],
  ) {}

  async analyze(root: string, files: string[]): Promise<AnalysisResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const rel of files) {
      // Per-file isolation, like the BaselineAnalyzer: build locally, merge on success,
      // so a mid-parse throw on one SFC leaves no partial nodes behind.
      try {
        const code = fs.readFileSync(path.join(root, rel), "utf8");
        const fileNodes: GraphNode[] = [];
        const fileEdges: GraphEdge[] = [];
        const endLine = code.split("\n").length;
        const id = fileId(rel);
        fileNodes.push({
          id,
          kind: "File",
          name: path.basename(rel),
          file: rel,
          qualifiedName: "",
          tier: "baseline",
          range: { startLine: 1, endLine },
        });
        // The SFC file *is* a component, named from the filename (Foo.vue → Foo).
        const name = path.basename(rel, path.extname(rel));
        const componentId = symbolId({ file: rel, qualifiedName: name });
        fileNodes.push({
          id: componentId,
          kind: "Component",
          name,
          file: rel,
          qualifiedName: name,
          tier: "baseline",
          range: { startLine: 1, endLine },
        });
        fileEdges.push({ from: id, to: componentId, kind: "Defines" });
        for (const { code: script, lineOffset } of scriptBlocks(code)) {
          // <script> imports → File→File Imports edges (the import graph).
          for (const specifier of importSpecifiers(script)) {
            const target = sfcCandidates(specifier, rel).find((c) =>
              fs.existsSync(path.join(root, c)),
            );
            if (target && target !== rel)
              fileEdges.push({ from: id, to: fileId(target), kind: "Imports" });
          }
          // <script> declarations → symbol nodes, parsed with the TS grammar (it parses
          // plain JS too) and offset back to file lines. A WASM Tree must be freed.
          const tree = await parse("typescript", script);
          try {
            walkSymbols(tree.rootNode, SFC_SYMBOLS, rel, id, "", fileNodes, fileEdges, lineOffset);
          } finally {
            tree.delete();
          }
        }
        nodes.push(...fileNodes);
        edges.push(...fileEdges);
      } catch (err) {
        console.error(
          `[ama] ${this.language} analyzer failed on ${rel}; skipping it. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { nodes, edges };
  }
}
