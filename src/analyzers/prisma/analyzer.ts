import * as fs from "node:fs";
import * as path from "node:path";
import { type GraphEdge, type GraphNode, type Tier, fileId, symbolId } from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";

/** A Prisma block opener: `model User {`, `enum Role {`, `datasource db {`, … */
const BLOCK_OPEN = /^(model|enum|type|datasource|generator)\s+(\w+)\b/;
/** A field line: `<name> <Type> …` — the type is the second token; `?`/`[]` modifiers
 *  follow it, so `\w+` captures the base type name. */
const FIELD = /^(\w+)\s+(\w+)/;

const braceDelta = (line: string): number =>
  (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);

/** Strip a `//` line comment (Prisma uses `//` and `///`). A `//` inside a default value
 *  is never read — only a field's first two tokens are — so this is safe here. */
const stripComment = (line: string): string => line.replace(/\/\/.*$/, "");

/**
 * Deep-tier analyzer for Prisma schemas. Parses `schema.prisma` into a queryable graph:
 * each `model`/`type` becomes a Class node and each `enum` an Enum node; fields are
 * Property nodes qualified by their model; and a field typed by another model/enum/type
 * emits a `UsesType` edge — the relation graph. `datasource`/`generator` blocks are
 * ignored. The schema is a simple declarative grammar, so a line parser suffices (no
 * tree-sitter wasm). Cross-code linkage (prisma client usage → model) is the deep TS
 * analyzer's job. (ama-cdg)
 */
export class PrismaAnalyzer implements Analyzer {
  readonly language = "prisma";
  readonly tier: Tier = "deep";
  readonly extensions: readonly string[] = [".prisma"];

  analyze(root: string, files: string[]): AnalysisResult {
    // Pass 1 — every declared type name and the file it lives in, so a relation field can
    // link across a multi-file schema (Prisma's `schema/` dir), not just within one file.
    const typeFile = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const rel of files) {
      try {
        const code = fs.readFileSync(path.join(root, rel), "utf8");
        sources.set(rel, code);
        for (const m of code.matchAll(/^\s*(?:model|enum|type)\s+(\w+)\s*\{/gm)) {
          typeFile.set(m[1] as string, rel);
        }
      } catch {
        // Unreadable file — skip; it simply contributes no nodes/links.
      }
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const [rel, code] of sources) {
      try {
        this.analyzeFile(rel, code, typeFile, nodes, edges);
      } catch (err) {
        console.error(
          `[ama] prisma analyzer failed on ${rel}; skipping it. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { nodes, edges };
  }

  private analyzeFile(
    rel: string,
    code: string,
    typeFile: Map<string, string>,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    const lines = code.split("\n");
    const fid = fileId(rel);
    nodes.push({
      id: fid,
      kind: "File",
      name: path.basename(rel),
      file: rel,
      qualifiedName: "",
      tier: "deep",
      range: { startLine: 1, endLine: lines.length },
    });

    let current: { name: string; node: GraphNode; emitFields: boolean } | null = null;
    let skipDepth = 0; // >0 while inside an ignored datasource/generator block

    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      const line = stripComment(lines[i] ?? "").trim();
      if (!line) continue;

      if (skipDepth > 0) {
        skipDepth += braceDelta(line); // back to 0 at the block's closing `}`
        continue;
      }

      if (current === null) {
        const open = line.match(BLOCK_OPEN);
        if (!open) continue;
        const kw = open[1] as string;
        const name = open[2] as string;
        if (kw === "datasource" || kw === "generator") {
          skipDepth = braceDelta(line); // +1 on the opener line
          continue;
        }
        const node: GraphNode = {
          id: symbolId({ file: rel, qualifiedName: name }),
          kind: kw === "enum" ? "Enum" : "Class",
          name,
          file: rel,
          qualifiedName: name,
          tier: "deep",
          range: { startLine: ln, endLine: ln },
        };
        nodes.push(node);
        edges.push({ from: fid, to: node.id, kind: "Defines" });
        current = { name, node, emitFields: kw !== "enum" };
        if (line.includes("}")) current = null; // single-line block (rare)
        continue;
      }

      if (line.includes("}")) {
        if (current.node.range) current.node.range.endLine = ln;
        current = null;
        continue;
      }
      if (!current.emitFields || line.startsWith("@@")) continue;

      const field = line.match(FIELD);
      if (!field) continue;
      const fieldName = field[1] as string;
      const typeName = field[2] as string;
      const fieldQn = `${current.name}.${fieldName}`;
      const fieldNodeId = symbolId({ file: rel, qualifiedName: fieldQn });
      nodes.push({
        id: fieldNodeId,
        kind: "Property",
        name: fieldName,
        file: rel,
        qualifiedName: fieldQn,
        tier: "deep",
        range: { startLine: ln, endLine: ln },
      });
      edges.push({ from: current.node.id, to: fieldNodeId, kind: "Defines" });
      // A field typed by another declared model/enum/type is a relation → UsesType.
      const targetFile = typeFile.get(typeName);
      if (targetFile) {
        edges.push({
          from: current.node.id,
          to: symbolId({ file: targetFile, qualifiedName: typeName }),
          kind: "UsesType",
        });
      }
    }
  }
}
