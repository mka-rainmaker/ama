import type { GraphEdge, GraphNode } from "./types.js";

/** The baseline type detector tags an unresolved type reference (a supertype, an interface, or a
 *  field/param/return type) with this prefix + the type's simple name; {@link deriveTypeEdges}
 *  resolves it whole-graph to a Class/Interface/Enum in the same or an imported file. (ama 0.4.0 S0) */
export const TYPE_REF_PREFIX = "type:";

const TYPE_CANDIDATE_KINDS = new Set<GraphEdge["kind"]>(["Inherits", "Implements", "UsesType"]);

/** A Java package maps to a directory under its source root, so a same-package sibling is reachable
 *  with no `import`. The directory is our same-package key. (#34, failure mode #1) */
function packageDir(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

/**
 * Resolve `type:<name>` candidates (raw provenance, emitted by the Java baseline analyzer for
 * supertypes/interfaces/field-types it can't resolve within the file) into concrete
 * `Inherits`/`Implements`/`UsesType` edges, by finding a Class/Interface/Enum named `<name>` in the
 * source's own file or in a file it imports. Import-guided + name-based — precise enough for the
 * syntactic tier; a name in no reachable file is dropped (JDK/JAR supertypes have no on-disk node, a
 * documented baseline limitation, #15). The derived edge KEEPS the candidate's kind and is tagged
 * `provenance: "type"`. Pure + whole-graph: the candidate and the target type only meet after every
 * file is indexed, so (like the call/dispatch derivers) it can't run inside one file's batch.
 *
 * Same-package resolution (#34): a type referenced without an explicit `import` (a same-package
 * sibling, the common Java case) has no `Imports` edge, so it's resolved against same-directory
 * siblings (a Java package maps to a directory). Gated to `.java`. Still unresolved at baseline:
 * a wildcard `import com.foo.*` and a type whose source root differs across Maven/Gradle modules
 * (the import path doesn't map to the on-disk file) — both deep-tier concerns (#15).
 *
 * Mirrors {@link ./python-calls.ts deriveCallEdges}; the second arg is the pre-filtered base edge
 * set (every edge whose provenance is not `type`), exactly as the indexer's relinker passes it. */
export function deriveTypeEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const fileOfNode = new Map<string, string>(); // any node id → its file
  const relOfFileNode = new Map<string, string>(); // File node id → repo-relative path
  const typesByFile = new Map<string, Map<string, string>>(); // file → simple name → type id
  const typesByDir = new Map<string, Map<string, string>>(); // Java package (dir) → simple name → id
  for (const n of nodes) {
    fileOfNode.set(n.id, n.file);
    if (n.kind === "File") {
      relOfFileNode.set(n.id, n.file);
    } else if (n.kind === "Class" || n.kind === "Interface" || n.kind === "Enum") {
      const simple = n.qualifiedName.slice(n.qualifiedName.lastIndexOf(".") + 1);
      let byName = typesByFile.get(n.file);
      if (!byName) {
        byName = new Map();
        typesByFile.set(n.file, byName);
      }
      if (!byName.has(simple)) byName.set(simple, n.id); // first definition wins on collision
      if (n.file.endsWith(".java")) {
        const dir = packageDir(n.file);
        let inDir = typesByDir.get(dir);
        if (!inDir) {
          inDir = new Map();
          typesByDir.set(dir, inDir);
        }
        if (!inDir.has(simple)) inDir.set(simple, n.id); // first definition wins on collision
      }
    }
  }
  const importsOf = new Map<string, string[]>(); // importer file → imported files
  for (const e of edges) {
    if (e.kind !== "Imports") continue;
    const from = relOfFileNode.get(e.from);
    const to = relOfFileNode.get(e.to);
    if (!from || !to) continue;
    const list = importsOf.get(from);
    if (list) list.push(to);
    else importsOf.set(from, [to]);
  }
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!TYPE_CANDIDATE_KINDS.has(e.kind) || !e.to.startsWith(TYPE_REF_PREFIX)) continue;
    const name = e.to.slice(TYPE_REF_PREFIX.length);
    const sourceFile = fileOfNode.get(e.from);
    if (!sourceFile) continue;
    // Same file first (nested types need no import), then the same Java package (a same-package
    // sibling needs no import — #34), then each explicitly imported file.
    let resolved = typesByFile.get(sourceFile)?.get(name);
    if (!resolved && sourceFile.endsWith(".java")) {
      resolved = typesByDir.get(packageDir(sourceFile))?.get(name);
    }
    if (!resolved) {
      for (const imported of importsOf.get(sourceFile) ?? []) {
        const id = typesByFile.get(imported)?.get(name);
        if (id) {
          resolved = id;
          break;
        }
      }
    }
    if (!resolved || resolved === e.from) continue;
    const key = `${e.from} ${e.kind} ${resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: resolved, kind: e.kind, provenance: "type" });
  }
  return out;
}
