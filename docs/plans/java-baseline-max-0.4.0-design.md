# Ama 0.4.0 — Java baseline, taken to its maximum honest level

**Status:** validated design (Phase 1). Branch `feat/java-baseline-max-0.4.0`.
**Scope:** push the Java analyzer to its maximum *honest baseline* tier. Everything here stays
tier `baseline`. The deep JVM sidecar (Roslyn-style semantic resolution) is **Phase 2 / issue #15**
and is explicitly out of scope.

## 1. Goal

Java today emits symbols and within-file call edges, but `find_implementations`,
`find_overrides`, `find_overridden_by`, `find_interfaces`, `find_type_users`, `find_types_used`
all come back empty, and routes only cover Spring MVC. We close those gaps **without lying about
the tier**: the per-file analyzer keeps emitting cheap, certain *primitives*; whole-store derivation
passes infer the relationships from them.

## 2. Architecture — the reuse spine

The pipeline already has a clean split that we extend rather than fork:

```
per-file analyzer  ─▶  symbols + within-file edges + "prefix:name" CANDIDATE edges
                          │
whole-store passes  ─▶  resolve candidates to concrete node ids (import/ancestor graph)
   (src/indexer/indexer.ts)
```

Existing whole-store passes (each idempotent via `store.replaceEdgesByProvenance`):

- **`deriveCallEdges`** (`src/graph/python-calls.ts`) — resolves `call:<name>` candidates to `Calls`
  edges through the import graph. Provenance `call`.
- **`deriveDispatchEdges`** (`src/graph/dispatch.ts`, language-agnostic) — consumes **resolved**
  `Inherits`/`Implements`/`Defines` edges to emit `Overrides` + virtual-dispatch `Calls`.
  Provenance `dispatch`.

**NEW pass — `deriveTypeEdges`** in `src/graph/type-edges.ts`, a near-copy of `deriveCallEdges`:

```ts
export const TYPE_REF_PREFIX = "type:";
export function deriveTypeEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[];
```

It resolves `type:SimpleName` endpoints on candidate `Inherits` / `Implements` / `UsesType` edges to
the target `Class` / `Interface` / `Enum` node, using the **same import-graph + ancestor resolution**
the call pass uses. Signature mirrors `deriveCallEdges(nodes, edges)` exactly — **no third `base`
param**; the relinker passes the pre-filtered base-edge slice as the second arg (the spec's
"`deriveTypeEdges(nodes, base)`" maps onto this shape).

Differences from `deriveCallEdges`:
- candidate predicate keys on `kind ∈ {Inherits, Implements, UsesType}` + `provenance === "heuristic"`
  + `to.startsWith(TYPE_REF_PREFIX)`;
- the by-name target index is built over `Class | Interface | Enum` nodes (not `Function | Method`);
- emitted edges keep their **original kind** (`Inherits`/`Implements`/`UsesType`) and carry
  provenance `type`;
- unresolved candidates (JDK/external supertypes) and self-edges are **dropped**, never left dangling
  — exactly like unresolved `call:` candidates today.

### Wiring (`src/indexer/indexer.ts`)

Add a `relinkTypes(store)` helper shaped like `relinkCalls`:

```ts
const nodes = [...store.allNodes()];
const base  = store.allEdges().filter(e => e.provenance !== "type");
store.replaceEdgesByProvenance("type", deriveTypeEdges(nodes, base));
```

Invoke it at **both** sites (whole-store + single-file reindex), positioned **BEFORE** dispatch
derivation, because dispatch consumes *resolved* hierarchy edges:

- `reindexFile()`: insert `relinkTypes(store)` **before** `redispatch(store)`.
- `index()`: place `relinkTypes(store)` among the relinkers; if hierarchy-dependent dispatch is also
  re-derived here, it must run after `relinkTypes`.

Import (`Imports`) edges are analyzer-emitted, never carry a derived provenance, so they survive
every `replaceEdgesByProvenance` and are available to `deriveTypeEdges` at the wiring point — the same
guarantee `deriveCallEdges` relies on.

### Required type-system change

`EdgeProvenance` (`src/graph/types.ts`) does **not** currently include `"type"`. Add it to the union,
and update `getGraphSchema`'s hard-coded `edgeProvenance` tally object (`src/query/service.ts`) so the
new key is counted (otherwise `noUncheckedIndexedAccess` indexing yields `NaN` counts and/or fails
typecheck).

## 3. The four wins — primitives → inferred relationships

Java emits only certain primitives; the passes infer everything else.

### Win 1 — Type hierarchy (`find_implementations` / `find_overrides` / `find_overridden_by` / `find_interfaces`)

`collectHierarchy` CST walk emits **candidate** edges with `type:SimpleName` endpoints:

- `class extends Base` → `Inherits`. CST: `class_declaration.childForFieldName("superclass")` →
  the type is a **positional** child of `superclass` (`namedChildren[0]`), not a named field.
- `interface extends A, B` → `Inherits`. CST: positional `extends_interfaces` child (no field) →
  `type_list` → each member.
- `class implements A, B` → `Implements`. CST: `childForFieldName("interfaces")` → node type
  `super_interfaces` → `type_list` → members. **Naming asymmetry trap:** interface-extends is
  `extends_interfaces` (positional), class-implements is `super_interfaces` (via the `interfaces`
  field); both wrap a `type_list`. `collectHierarchy` must handle both shapes.

Endpoint = a local node id if the supertype is defined in the same file, else a `type:SimpleName`
candidate. We **do not** compute `@Override` or signatures — `deriveDispatchEdges` derives
`Overrides` + dispatch from the resolved hierarchy + the `Defines` edges `walkSymbols` already emits.

> Note: `findInterfaces` only traverses `Implements`. Interface-extends-interface produces an
> `Inherits` edge and therefore surfaces via inheritance/impact traversal, **not** via
> `find_interfaces`. This is intended current behavior, not a gap to patch here.

### Win 2 — Constructors + `new` (`find_callers` on constructors, instantiation call sites)

- Add `constructor_declaration` to `JAVA_SYMBOL_TYPES` so it becomes a `Method` node and participates
  in qualified-name chaining. CST: fields `name` (same simple name as the class) + `parameters` +
  `body`; **no `type` field** (distinguishes it from `method_declaration`). Qualified name becomes
  e.g. `Animal.Animal`.
- `new Foo(...)` → `object_creation_expression`. Treat it as a call site in `collectCalls`: callee
  simple name = the constructed type, read from `childForFieldName("type")` then **stripped to the
  base `type_identifier`** (handles `generic_type`/`scoped_type_identifier`). Resolved within-file or
  cross-file via the existing `call:` candidate machinery.
- **Anonymous-class guard:** `new Foo(){...}` is an `object_creation_expression` that *also* has a
  `class_body` child — guard it so its body is not walked as a named class and the construction is
  handled carefully.

### Win 3 — Fields + type-uses (`find_type_users` / `find_types_used`)

- `field_declaration` → one `Property` node **per `variable_declarator`**. The `declarator` field
  exposes only the **first** declarator; `int a, b;` requires iterating `namedChildren` filtered to
  `variable_declarator`, or `b` is dropped.
- `UsesType` candidate edges from field types (and optionally parameter + return types) → declaring
  type via `type:` candidates. Type-node stripping is multi-shaped and must be deliberate:
  - `generic_type` → `namedChildren[0]` (base `type_identifier`);
  - `array_type` → element is its first child (has a `dimensions` field);
  - `scoped_type_identifier` (`Foo.Bar`) → base is the **LAST** `type_identifier` (`Bar`) — a naive
    "first type_identifier" rule is wrong here;
  - `void_type` (return types) → **skip**, nothing to resolve;
  - primitives (`integral_type` etc.) → no candidate.

### Win 4 — Routes beyond Spring MVC

Reuse the existing Spring `Route` → `References` → handler model + `joinJavaRoutePath`.

- **JAX-RS — annotation-driven.** Class-level `@Path` prefix + method-level `@Path` + a verb marker
  annotation (`@GET/@POST/@PUT/@DELETE/@PATCH`) → a `Route` node + `References` → handler method.
  Annotations live under a `modifiers` child as `annotation` (with `annotation_argument_list` →
  `string_literal` → `string_fragment`) or `marker_annotation` (verbs, no args); both expose
  `childForFieldName("name")` — reuses the existing `annotationsOf` pattern.
- **Javalin — call-site.** `app.get("/path", handler)` parses as `method_invocation` with
  `object=identifier ("app")`, `name=identifier ("get")`, `arguments=argument_list` (path =
  `string_literal` → `string_fragment`; handler = next argument). Reuses the `method_invocation`
  iteration `javaCalls` already does.

## 4. Honesty constraints (non-negotiable)

- Every Java node/edge is tier `baseline`. Raw analyzer edges carry provenance `heuristic`; derived
  edges carry their pass provenance (`type` / `dispatch` / `call`).
- **Overloads stay skipped.** Constructors/methods that collide by *simple name* are ambiguous at
  baseline; we **do not guess** which overload `new Foo(...)` targets — set to null/ambiguous, exactly
  like the existing `javaCalls` ambiguity handling. True disambiguation is deep-tier.
- **JAX-RS dispatch is implicit and must never be a fabricated `Calls` edge.** Model it as a
  first-class `Route` node + `References` → handler. `find_callers` staying **empty** for a JAX-RS
  handler is **correct**; the route surfaces via `find_handlers` / `find_routes` / `find_referrers`.
- **Route handlers are reachable entry points.** Verified: `impact_analysis` already reverse-traverses
  `IMPACT_EDGE_KINDS`, which **includes `References`**, and the edge runs `Route → References →
  handler`. So `impact_analysis(handler)` already reaches its `Route` (and onward to route-tests) with
  **no seeding change required**. `affected()` is intentionally file-granular (walks only
  `Imports`/`ImportsType`) and must **not** be given Route seeding. Keep a regression test asserting
  `impact_analysis(handler)` includes its `Route`, so a future drop of `References` from
  `IMPACT_EDGE_KINDS` can't silently dark out route reachability.
- **Dangling-endpoint discipline (#34 lesson).** The `collectCalls` / `collectHierarchy` CST walks
  must reproduce `walkSymbols`' dotted qualified names **exactly**, or edge endpoints dangle. Guard
  anonymous / local / nested classes and wildcard imports; verify the dotted chain stays consistent
  across all three walks.

## 5. Known limitations (deep-tier / #15)

These are **documented limitations, not bugs to hack around**:

- **External-JAR enums/types are not indexable at baseline.** There is no bytecode/classpath reader,
  so references to JDK supertypes (`Runnable`, `Comparable`), framework annotation classes
  (`javax.ws.rs.*`), and external enums simply **do not resolve** — the candidate produces **no edge**
  (dropped, not dangling).
- **Overloaded constructors/methods ambiguous by simple name are skipped.** Disambiguation needs full
  type/signature resolution — deep tier.
- `scoped_type_identifier` candidates resolve by **simple (last) name**, which can over-resolve when
  two same-named types exist in different packages; precise package resolution is deep tier.

## 6. Testing strategy (strict TDD, RED → GREEN per slice)

- **Fixtures** under `tests/analyzers/` (cross-file Java) + **pure resolver unit tests** under
  `tests/graph/` for `deriveTypeEdges` (assert candidate-in → resolved-edge-out, unresolved dropped,
  self-edge dropped, idempotent under single-file reindex).
- For each slice assert **three layers**: (a) the new raw candidate edges; (b) the derived
  `Overrides` / dispatch edges produced from them; (c) that the **query tools** return real results on
  cross-file fixtures — `find_implementations`, `find_overrides`, `find_overridden_by`,
  `find_interfaces`, `find_type_users`, `find_types_used`, `find_handlers` / `find_routes` /
  `find_referrers`, and `impact_analysis(handler)` includes the `Route`.
- Assert the honesty boundaries too: overloaded `new Foo(...)` is **not** wired to a single
  constructor; a JAX-RS handler's `find_callers` is **empty** while its route is found.
- **Gates:** `npm run typecheck`, `biome` (`npm run lint`), full `vitest` (includes the self-index
  regression — a change isn't done until Ama re-indexes its own source cleanly).

## 7. Phase 2 ceiling sketch — deep JVM sidecar (#15)

Baseline tops out at "syntactically certain, simple-name resolved." A deep JVM sidecar (out of scope
here) would lift the ceiling by:

- reading **bytecode / classpath** so external-JAR and JDK supertypes, enums, and annotations resolve
  (closing the biggest known limitation above);
- **full type & signature resolution**, enabling overload disambiguation (`new Foo(int)` vs
  `new Foo(String)`) and exact `@Override` matching instead of name-only;
- **package-precise** type resolution, removing the `scoped_type_identifier` over-resolution risk;
- richer dispatch (generics, type bounds, method references) beyond virtual-dispatch heuristics.

All of which would be reported at tier `deep`, leaving this Phase-1 work as the honest baseline floor.
