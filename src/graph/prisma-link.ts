import type { GraphEdge, GraphNode } from "./types.js";

/** The TS analyzer tags a `prisma.<model>` client access with a candidate edge whose target
 *  is this prefix + the accessed property (lowercased) — a model *name*, not a node id. A
 *  whole-graph pass ({@link derivePrismaReferences}) resolves it to the model node. (ama-kvv) */
export const PRISMA_REF_PREFIX = "prisma:model:";

/** The TS analyzer also tags each field key used in a `prisma.<model>` query (the keys of its
 *  where/select/data/orderBy objects) with this prefix + `<model>.<field>` (lowercased).
 *  {@link derivePrismaReferences} resolves it to the schema's `Model.field` Property. (ama-bgu) */
export const PRISMA_FIELD_REF_PREFIX = "prisma:field:";

/**
 * Resolve the raw `prisma-ref` candidates into `prisma` References edges pointing at schema
 * nodes — a `prisma:model:` candidate → the model Class, a `prisma:field:` candidate → the
 * `Model.field` Property. Pure and whole-graph — it needs both the TS candidates and the Prisma
 * schema nodes in view, which only the indexer has once every analyzer has run, so (like
 * {@link deriveDispatchEdges}) it can't be computed inside a single analyzer's batch. A
 * candidate that matches no schema model/field is dropped, so false positives from the
 * name-based detection (`db.connect()`, an HTTP `client.users`) self-filter. (ama-kvv, ama-bgu)
 */
export function derivePrismaReferences(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const modelByName = new Map<string, string>();
  const fieldByName = new Map<string, string>();
  for (const n of nodes) {
    // Prisma schema nodes (see PrismaAnalyzer): a model is a Class, a field a Property
    // qualified as `Model.field` — both defined in a .prisma file.
    if (!n.file.endsWith(".prisma")) continue;
    if (n.kind === "Class") modelByName.set(n.name.toLowerCase(), n.id);
    else if (n.kind === "Property") fieldByName.set(n.qualifiedName.toLowerCase(), n.id);
  }
  if (modelByName.size === 0) return [];
  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (e.provenance !== "prisma-ref") continue;
    const targetId = e.to.startsWith(PRISMA_FIELD_REF_PREFIX)
      ? fieldByName.get(e.to.slice(PRISMA_FIELD_REF_PREFIX.length))
      : e.to.startsWith(PRISMA_REF_PREFIX)
        ? modelByName.get(e.to.slice(PRISMA_REF_PREFIX.length))
        : undefined;
    if (targetId && targetId !== e.from) {
      out.push({ from: e.from, to: targetId, kind: "References", provenance: "prisma" });
    }
  }
  return out;
}
