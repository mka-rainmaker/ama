# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-06-24

Java baseline refinements from real battle-test feedback: same-package resolution, tier-honest query
results, and visible (not silently dropped) dependency supertypes.

### Added

- **`node().externalSupertypes`** (`src/query/service.ts`): the `node` tool now lists the simple
  names of `Inherits`/`Implements` targets that stayed unresolved `type:<Name>` candidates — a
  supertype/interface with no on-disk node, i.e. a JDK / third-party / cross-module dependency type.
  The data was already in the store; the inheritance queries just skipped it. Surfaced so the
  dependency a class extends is visible instead of silently dropped (#49).

### Fixed

- **Java same-package resolution** (`src/graph/type-edges.ts`, `src/graph/python-calls.ts`): the
  baseline call/type resolvers were import-guided (a Python/TS module model), so a same-package
  sibling — which needs no `import` in Java — never resolved, leaving `find_callers` /
  `find_callees` / `find_implementations` empty on real (Maven) repos. Candidates now also resolve
  against same-directory siblings (a Java package maps to a directory under its source root), gated
  to `.java`. Wildcard and cross-module-source-root resolution remain a deep-tier concern (#46).
- **Tier-honest baseline queries**: `index_status` no longer reports a misleading
  `callsTotal: 0 / callsResolved: 0` for a baseline-only index — that stat is a deep-tier
  measurement a baseline analyzer never populates, so it's omitted unless measured; and an empty
  **baseline**-tier relationship result (`find_callers` / `find_callees` / `find_implementations` /
  `impact_analysis`) now carries an explicit caveat, so "not resolved at this tier" is
  distinguishable from "genuinely none" (#46).

## [0.4.0] - 2026-06-23

Java baseline analyzer taken to its maximum **honest baseline** level (Phase 1). Every Java node and
edge stays tier `baseline`; the analyzer emits only primitives and whole-store passes infer the rest.

### Added

- **`deriveTypeEdges` spine** (`src/graph/type-edges.ts`): a new whole-store resolver that resolves
  `type:<SimpleName>` candidates on `Inherits`/`Implements`/`UsesType` edges to the
  `Class`/`Interface`/`Enum` they name, via the same import/ancestor resolution used for `call:`
  candidates. Mirrors `deriveCallEdges`; pure and single-file-reindex safe. Wired into the indexer
  via `replaceEdgesByProvenance("type", …)` **before** `deriveDispatchEdges`, because dispatch
  consumes the resolved hierarchy.
- **Type hierarchy** — `class extends` → `Inherits`, `interface extends` → `Inherits`,
  `implements` → `Implements` (generics stripped to the base type). `deriveDispatchEdges` then
  derives `Overrides` + virtual-dispatch `Calls` from the resolved hierarchy. Lights up
  `find_implementations` / `find_overrides` / `find_overridden_by` / `find_interfaces` for Java
  (all empty before).
- **Constructors + `new`** — `constructor_declaration` is now a `Method` node (added to
  `JAVA_SYMBOL_TYPES` so qualified-name chaining works); `object_creation_expression` (`new Foo(...)`)
  is a call site resolved within- or cross-file via the existing `call:` machinery.
- **Fields + type-uses** — `field_declaration` → `Property` nodes per `variable_declarator`
  (multi-declarator `int a, b;` handled); `UsesType` edges from field (and param/return) types to the
  declaring type. Powers `find_type_users` / `find_types_used`.
- **Routes beyond Spring MVC** — JAX-RS (annotation-driven: class `@Path` prefix + method `@Path` +
  `@GET`/`@POST`/`@PUT`/`@DELETE`/`@PATCH` verb → `Route` node + `References` → handler) and Javalin
  (call-site `app.get/post(...)` → `Route` + handler). Reuses the Spring `Route` → handler model and
  `joinJavaRoutePath`. Surfaced by `find_handlers` / `find_routes` / `find_referrers`, and a Route
  handler is a reachable entry point in `impact_analysis` / `affected` via the `Route → References →
  handler` edge — no fabricated `Calls` edge for framework dispatch.

### Known limitations

- External-JAR enums/types are not indexable at the baseline tier (no bytecode/classpath reader), so
  references to them simply do not resolve (no edge) — the same as JDK supertypes. This is a
  documented limitation slated for the deep-tier JVM sidecar (tracked in #15), not a bug.
- Overloaded constructors/methods ambiguous by simple name stay skipped; true disambiguation is
  deep-tier work.

[0.4.0]: https://github.com/mka-rainmaker/ama/releases/tag/v0.4.0
