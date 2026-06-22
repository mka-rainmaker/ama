import * as fs from "node:fs";
import * as path from "node:path";
import { type GraphEdge, type GraphNode, fileId, symbolId } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";

/** Extensions an SFC `<script>` import may resolve to — sibling components, plus
 *  the TS/JS modules they pull in (composables, stores, utils). */
const SFC_EXTENSIONS = [".vue", ".svelte", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

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

/** Concatenated source of every `<script>` block in an SFC (Vue allows two:
 *  `<script>` and `<script setup>`; Svelte allows `<script context="module">`). */
function scriptBlocks(code: string): string {
  let out = "";
  for (const m of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) out += `${m[1]}\n`;
  return out;
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
 * Baseline (syntactic) analyzer for single-file components: a `.vue`/`.svelte` file
 * becomes a {@link "Component"} node named after the file, and the modules its
 * `<script>` imports become File→File `Imports` edges, so SFCs are searchable and
 * connected in the import graph. Deep `<script>` symbol/call analysis is out of scope
 * (a follow-up); this is breadth, like the other baseline analyzers. (ama-krw)
 */
export class SfcAnalyzer implements Analyzer {
  readonly tier = "baseline";

  constructor(
    readonly language: string,
    readonly extensions: readonly string[],
  ) {}

  analyze(root: string, files: string[]): AnalysisResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const rel of files) {
      // Per-file isolation, like the BaselineAnalyzer: one unreadable SFC must not
      // lose the batch. Build locally and merge on success.
      try {
        const code = fs.readFileSync(path.join(root, rel), "utf8");
        const endLine = code.split("\n").length;
        const id = fileId(rel);
        nodes.push({
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
        nodes.push({
          id: componentId,
          kind: "Component",
          name,
          file: rel,
          qualifiedName: name,
          tier: "baseline",
          range: { startLine: 1, endLine },
        });
        edges.push({ from: id, to: componentId, kind: "Defines" });
        // <script> imports → File→File Imports edges (the import graph).
        for (const specifier of importSpecifiers(scriptBlocks(code))) {
          const target = sfcCandidates(specifier, rel).find((c) =>
            fs.existsSync(path.join(root, c)),
          );
          if (target && target !== rel)
            edges.push({ from: id, to: fileId(target), kind: "Imports" });
        }
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
