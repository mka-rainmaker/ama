import type { GraphEdge, GraphNode } from "./types.js";

/** The TS analyzer tags a `prisma.<model>` client access with a candidate edge whose target
 *  is this prefix + the accessed property (lowercased) — a model *name*, not a node id. A
 *  whole-graph pass ({@link derivePrismaReferences}) resolves it to the model node. (ama-kvv) */
export const PRISMA_REF_PREFIX = "prisma:model:";

/**
 * Resolve the raw `prisma-ref` candidates into `prisma` References edges pointing at schema
 * model nodes. Pure and whole-graph — it needs both the TS candidates and the Prisma model
 * nodes in view, which only the indexer has once every analyzer has run, so (like
 * {@link deriveDispatchEdges}) it can't be computed inside a single analyzer's batch. A
 * candidate whose model name matches no schema model is dropped, so false positives from
 * the name-based detection (`db.connect()`, an HTTP `client.users`) self-filter. (ama-kvv)
 */
export function derivePrismaReferences(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const modelByName = new Map<string, string>();
  for (const n of nodes) {
    // A Prisma model is a Class node defined in a .prisma file (see PrismaAnalyzer).
    if (n.kind === "Class" && n.file.endsWith(".prisma"))
      modelByName.set(n.name.toLowerCase(), n.id);
  }
  if (modelByName.size === 0) return [];
  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (e.provenance !== "prisma-ref" || !e.to.startsWith(PRISMA_REF_PREFIX)) continue;
    const modelId = modelByName.get(e.to.slice(PRISMA_REF_PREFIX.length));
    if (modelId && modelId !== e.from) {
      out.push({ from: e.from, to: modelId, kind: "References", provenance: "prisma" });
    }
  }
  return out;
}
