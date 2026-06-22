import type { GraphEdge, GraphNode } from "./types.js";

/** A baseline call detector tags a TestClient-style `client.<verb>("/path")` call with this
 *  prefix + `METHOD /concrete-path`; {@link deriveRouteTestEdges} resolves it to the Route it
 *  exercises. (ama-f2c) */
export const ROUTE_REF_PREFIX = "route:";

/** Split a route/concrete path into segments, ignoring a trailing slash. */
function pathSegments(p: string): string[] {
  return p.replace(/\/+$/, "").split("/").filter(Boolean);
}

/** Whether a concrete request path matches a route pattern — `:param` / `*` segments are wildcards. */
function pathMatches(routeSegs: string[], concreteSegs: string[]): boolean {
  if (routeSegs.length !== concreteSegs.length) return false;
  return routeSegs.every(
    (rs, i) => rs === concreteSegs[i] || rs.startsWith(":") || rs.startsWith("*"),
  );
}

/**
 * Resolve `route:<METHOD> <path>` candidates (provenance `call-ref`, emitted for a TestClient-style
 * `client.<verb>("/path")` call) into `References` edges from the calling test to the Route node it
 * exercises — matching the concrete request path against each Route's pattern (param-aware). The
 * existing route→handler edge then lets impact_analysis(handler) reach the test. A method-agnostic
 * `ANY` route (Django) matches any verb. Pure + whole-graph: the test call and the Route node (a
 * different file) only meet after every file is indexed, like the dispatch/prisma derivers. (ama-f2c)
 */
export function deriveRouteTestEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const routesByMethod = new Map<string, { segs: string[]; id: string }[]>();
  for (const n of nodes) {
    if (n.kind !== "Route") continue;
    const sp = n.name.indexOf(" ");
    if (sp < 0) continue;
    const method = n.name.slice(0, sp);
    const entry = { segs: pathSegments(n.name.slice(sp + 1)), id: n.id };
    const list = routesByMethod.get(method);
    if (list) list.push(entry);
    else routesByMethod.set(method, [entry]);
  }
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (
      e.kind !== "References" ||
      e.provenance !== "call-ref" ||
      !e.to.startsWith(ROUTE_REF_PREFIX)
    )
      continue;
    const spec = e.to.slice(ROUTE_REF_PREFIX.length);
    const sp = spec.indexOf(" ");
    if (sp < 0) continue;
    const method = spec.slice(0, sp);
    const concrete = pathSegments(spec.slice(sp + 1));
    const candidates = [
      ...(routesByMethod.get(method) ?? []),
      ...(routesByMethod.get("ANY") ?? []),
    ];
    const matched = candidates.find((r) => pathMatches(r.segs, concrete));
    if (!matched || matched.id === e.from) continue;
    const key = `${e.from} ${matched.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: matched.id, kind: "References", provenance: "route-test" });
  }
  return out;
}
