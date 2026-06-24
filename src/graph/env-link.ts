import type { GraphEdge, GraphNode } from "./types.js";

/** The TS analyzer tags a `process.env.KEY` access with a candidate edge whose target
 *  is this prefix + the KEY name — a variable name, not a node id. A whole-graph pass
 *  ({@link deriveEnvReferences}) resolves it to the .env Variable node. (ama-#53) */
export const ENV_REF_PREFIX = "env:";

/**
 * Resolve raw `env:` candidate edges into References edges pointing at .env Variable
 * nodes. A candidate whose target starts with `env:KEY` is resolved to the Variable
 * node in a .env file whose name === KEY; a candidate with no matching key is dropped.
 * Pure and whole-graph — it requires both the TS candidates and the .env nodes in
 * view, which only the indexer has once every analyzer has run. (ama-#53)
 */
export function deriveEnvReferences(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const envByName = new Map<string, string>();
  for (const n of nodes) {
    // .env Variable nodes are declared in .env files.
    if (!n.file.endsWith(".env")) continue;
    if (n.kind === "Variable") {
      envByName.set(n.name, n.id);
    }
  }
  if (envByName.size === 0) return [];
  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (e.provenance !== "env-ref") continue;
    if (!e.to.startsWith(ENV_REF_PREFIX)) continue;
    const keyName = e.to.slice(ENV_REF_PREFIX.length);
    const targetId = envByName.get(keyName);
    if (targetId && targetId !== e.from) {
      out.push({ from: e.from, to: targetId, kind: "References", provenance: "env" });
    }
  }
  return out;
}
