import * as fs from "node:fs";
import * as path from "node:path";
import { type GraphEdge, type GraphNode, fileId, symbolId } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";

/**
 * Baseline (syntactic) analyzer for the env-file family — `.env` and `name.env` (by extension) plus
 * `.env.example` / `.env.local` / … (by {@link DotenvAnalyzer.matchesFile}). Each `KEY=value` line
 * becomes a Variable value-origin node; blank lines and `#` comments are skipped. The file is a File
 * node and each key gets a Defines edge from it. Only key *names* are read, never values — so a
 * committed `.env.example` makes config keys first-class, queryable graph nodes. (#53)
 */
export class DotenvAnalyzer implements Analyzer {
  readonly language = "dotenv";
  readonly tier = "baseline" as const;
  readonly extensions: readonly string[] = [".env"];

  /** Claim the whole env-file family, including `.env.example` whose trailing extension is
   *  `.example` (so the extension map alone would miss it). */
  matchesFile(path: string): boolean {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.endsWith(".env") || base.startsWith(".env.");
  }

  analyze(root: string, files: string[]): AnalysisResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const rel of files) {
      try {
        const code = fs.readFileSync(path.join(root, rel), "utf8");
        this.analyzeFile(rel, code, nodes, edges);
      } catch (err) {
        console.error(
          `[ama] dotenv analyzer failed on ${rel}; skipping it. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { nodes, edges };
  }

  private analyzeFile(rel: string, code: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const lines = code.split("\n");
    const fid = fileId(rel);
    nodes.push({
      id: fid,
      kind: "File",
      name: path.basename(rel),
      file: rel,
      qualifiedName: "",
      tier: "baseline",
      range: { startLine: 1, endLine: lines.length },
    });

    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      const line = (lines[i] ?? "").trim();

      // Skip blank lines and comments.
      if (!line || line.startsWith("#")) continue;

      // Find the first '=' to split key and value.
      const eqIdx = line.indexOf("=");
      if (eqIdx < 0) continue;

      const key = line.slice(0, eqIdx).trim();
      if (!key) continue;

      // Emit a Variable node for this key.
      const varId = symbolId({ file: rel, qualifiedName: key });
      nodes.push({
        id: varId,
        kind: "Variable",
        name: key,
        file: rel,
        qualifiedName: key,
        tier: "baseline",
        range: { startLine: ln, endLine: ln },
      });

      // File defines this variable.
      edges.push({ from: fid, to: varId, kind: "Defines" });
    }
  }
}
