import * as fs from "node:fs";
import * as path from "node:path";
import {
  type GraphEdge,
  type GraphNode,
  TYPE_REF_PREFIX,
  type Tier,
  fileId,
  symbolId,
} from "../../graph/index.js";
import type { AnalysisResult, Analyzer } from "../types.js";
import { parseClassFile } from "./classfile.js";

/**
 * Analyzer for compiled Java bytecode (.class files) — reads the type hierarchy straight from the
 * constant pool with NO JVM, so a dependency JAR's classes (no on-disk source) can still join the
 * graph. The superclass/interfaces are the compiler's resolved truth, but this emits them as the same
 * simple-name `type:<Name>` candidates the Java source analyzer does, relinked by `deriveTypeEdges` —
 * so the OUTPUT is baseline-tier. (Using bytecode's full FQNs for precise deep resolution is a
 * follow-up; tier stays honest until then.) (#47/#48)
 */
export class JavaBytecodeAnalyzer implements Analyzer {
  readonly language = "java-bytecode";
  readonly tier: Tier = "baseline";
  readonly extensions: readonly string[] = [".class"];

  analyze(root: string, files: string[]): AnalysisResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const rel of files) {
      try {
        this.analyzeFile(root, rel, nodes, edges);
      } catch (err) {
        console.error(
          `[ama] bytecode analyzer failed on ${rel}; skipping it. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { nodes, edges };
  }

  private analyzeFile(root: string, rel: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const fullPath = path.join(root, rel);
    const bytes = fs.readFileSync(fullPath);
    const uint8 = new Uint8Array(bytes);

    const classFile = parseClassFile(uint8);

    // File node
    const fid = fileId(rel);
    nodes.push({
      id: fid,
      kind: "File",
      name: path.basename(rel),
      file: rel,
      qualifiedName: "",
      tier: "baseline",
    });

    // Extract simple name (last dot-separated segment of FQN)
    const simpleName = classFile.thisClass.split(".").pop() ?? classFile.thisClass;

    // Class or Interface node
    const kind = classFile.isInterface ? "Interface" : "Class";
    const nodeId = symbolId({
      file: rel,
      qualifiedName: simpleName,
    });

    nodes.push({
      id: nodeId,
      kind,
      name: simpleName,
      file: rel,
      qualifiedName: simpleName,
      tier: "baseline",
    });

    // Defines edge from file to class
    edges.push({
      from: fid,
      to: nodeId,
      kind: "Defines",
    });

    // Inherits edge to superclass (if not Object)
    if (classFile.superClass) {
      const superSimple = classFile.superClass.split(".").pop() ?? classFile.superClass;
      edges.push({
        from: nodeId,
        to: `${TYPE_REF_PREFIX}${superSimple}`,
        kind: "Inherits",
        provenance: "heuristic",
      });
    }

    // Implements edges for each interface (skip java.lang.* as per baseline convention)
    for (const iface of classFile.interfaces) {
      if (!iface.startsWith("java.lang.")) {
        const ifaceSimple = iface.split(".").pop() ?? iface;
        edges.push({
          from: nodeId,
          to: `${TYPE_REF_PREFIX}${ifaceSimple}`,
          kind: "Implements",
          provenance: "heuristic",
        });
      }
    }
  }
}
