import type { GraphEdge, GraphNode } from "./types.js";

/**
 * Derive the dispatch edges of a graph: `Overrides` edges (a subtype method
 * overriding/implementing a supertype method of the same name) and the fan-out of
 * interface/superclass method calls to each subtype's implementation. Both are
 * whole-graph inferences over `Implements`/`Inherits`/`Defines`/`Calls` edges, so
 * they can only be computed with the *full* node/edge set in view — which is why
 * a single-file reindex can't reproduce them and the indexer re-derives them over
 * the whole store instead (ama-tr1). Pure: returns the derived edges (tagged
 * `provenance: "dispatch"`) rather than mutating its input, so the same function
 * serves the per-batch analyze() and the store-level re-derivation.
 *
 * Only the input `edges` are fanned (never the freshly-derived ones), so a
 * fan-out never cascades. Language-agnostic — it reads node/edge *kinds* only.
 */
export function deriveDispatchEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as [string, GraphNode]));
  const definerOf = new Map<string, string>(); // member id -> container id
  const subtypes = new Map<string, string[]>(); // supertype id -> implementing/extending subtype ids
  const methodsByContainer = new Map<string, Map<string, string>>(); // container -> name -> method id
  for (const edge of edges) {
    if (edge.kind === "Defines") {
      definerOf.set(edge.to, edge.from);
      const member = byId.get(edge.to);
      if (member?.kind === "Method") {
        const byName = methodsByContainer.get(edge.from) ?? new Map<string, string>();
        byName.set(member.name, edge.to);
        methodsByContainer.set(edge.from, byName);
      }
    } else if (edge.kind === "Implements" || edge.kind === "Inherits") {
      const list = subtypes.get(edge.to) ?? [];
      list.push(edge.from);
      subtypes.set(edge.to, list);
    }
  }

  const derived: GraphEdge[] = [];
  // Overrides: a subtype method of the same name as a supertype method
  // overrides/implements it. Independent of any call. (ama-hft.11)
  for (const [superId, subIds] of subtypes) {
    const superMethods = methodsByContainer.get(superId);
    if (!superMethods) continue;
    for (const subId of subIds) {
      const subMethods = methodsByContainer.get(subId);
      if (!subMethods) continue;
      for (const [name, subMethodId] of subMethods) {
        const superMethodId = superMethods.get(name);
        if (superMethodId && superMethodId !== subMethodId) {
          derived.push({
            from: subMethodId,
            to: superMethodId,
            kind: "Overrides",
            provenance: "dispatch",
          });
        }
      }
    }
  }

  // Fan-out: a call to a super/interface method may reach each subtype's override.
  for (const edge of edges) {
    if (edge.kind !== "Calls") continue;
    const target = byId.get(edge.to);
    if (target?.kind !== "Method") continue;
    const container = definerOf.get(edge.to);
    if (!container) continue;
    const containerKind = byId.get(container)?.kind;
    if (containerKind !== "Interface" && containerKind !== "Class") continue;
    for (const subId of subtypes.get(container) ?? []) {
      const override = methodsByContainer.get(subId)?.get(target.name);
      if (override && override !== edge.to) {
        derived.push({ from: edge.from, to: override, kind: "Calls", provenance: "dispatch" });
      }
    }
  }
  return derived;
}
