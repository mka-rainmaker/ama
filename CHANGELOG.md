# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-06-25

Deep-tier Java resolves into its **dependencies**, and every resolved edge now carries an honest
confidence. Calls and types that reach the JDK or a third-party JAR resolve instead of dropping, and
each edge says how sure the resolver is — without ever upgrading a guess into a fact.

### Added

- **Classpath / dependency resolution** (`src/analyzers/java-deep/classpath.ts`): a native JAR (ZIP)
  and `.class` reader loads dependency + JDK-runtime symbols (types, methods, supertypes), so a call
  or type reaching an external library resolves to an **external node** instead of dropping. Parsing
  is bounded and safe — per-archive and per-entry size guards (`AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES`
  / `AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES`), decompression-bomb protection, a class-count cap, and an
  LRU symbol cache — so a large or corrupt JAR can't exhaust memory or abort indexing. (Closes #47)
- **Edge confidence + strategy** (`GraphEdge.confidence` 0..1, `GraphEdge.strategy`): every resolved
  Java edge records how it was resolved — `exact-type`, `arity-fallback`, `implicit-constructor`, or
  `heuristic` — surfaced on query results and the sidecar protocol. Lets agents rank edges instead of
  treating "resolved" as binary.
- **External dependency nodes**: types/methods loaded from the classpath join the graph as first-class
  `Class`/`Method` nodes flagged `external: true` (synthetic `java:<binaryName>` file), so a dependency
  symbol is visible **and** clearly not your source.
- **Resolution diagnostics** (`ResolutionStats.diagnostics`): resolution *failures* are now counted by
  stable reason key (`missing-method`, `ambiguous-overload`, `arity-mismatch`, …), and a
  `bench:java-resolution` harness reports the per-repo resolution rate — making the gap measurable.

### Changed

- **Honest graded resolution**: richer inference (expression types, constructor resolution, local
  variable types, full hierarchy walks) raises Java coverage, but the resolver still **omits rather
  than guesses** — an `arity-fallback` whose argument types are positively wrong is dropped (or scored
  low), the hierarchy walk continues past a child arity-mismatch to find an inherited overload, and an
  implicit (no-source) constructor is a type-level `implicit-constructor` edge, never a fabricated
  method call.
- **Bounded resolution stats** (schema v6): the unresolved/diagnostics histograms persisted for
  `index_status` are capped (top 100 by count) with the remainder folded into `unresolvedOther` /
  `diagnosticsOther`, so dependency-scale resolution can't bloat the stored index.

## [0.5.1] - 2026-06-24

Deep-tier Java, for real. A source-semantic analyzer resolves Java calls and types to their actual
definitions — same-class, same-package (no import needed), single-type and wildcard imports,
nested/inner classes, records, lambdas, `this`/field receivers, and overloads — and emits them at
`deep` tier, with a `javac`+bytecode compiler-truth path and an **honest `baseline` fallback** when
neither semantic path applies. Closes the deep-tier sidecar (#15). Still native, no new dependencies.

### Added

- **Deep-tier Java analyzer** (`src/analyzers/java-deep/`): tree-sitter source semantics resolve
  method calls to their target definitions and field/parameter/return types to their declarations —
  across same-class, same-package (Java needs no `import` for siblings), single-type and wildcard
  imports, nested/inner classes (`Outer.Inner` → `Outer$Inner`), records, lambdas, and
  `this.field` / explicit-field receivers — disambiguating overloads by arity and parameter type.
  Emits `Calls` / `UsesType` / `Returns` / `Inherits` / `Implements` at `deep` tier. When a local
  `javac` can compile the project, resolved bytecode descriptors provide a second compiler-truth
  path; if both semantic paths fail the analyzer falls back to the Java baseline and **reports the
  lowered tier honestly**. (#15)
- **Bytecode call extraction** (`src/analyzers/java-bytecode/classfile.ts`): the `.class` reader now
  decodes method `Code` attributes — walking the instruction stream bounds-safely (incl. `wide`,
  `tableswitch` / `lookupswitch` padding, with clamped instruction lengths so a truncated or
  malformed class can never desync the scanner) and resolving
  `invokevirtual` / `invokespecial` / `invokestatic` / `invokeinterface` targets through the
  constant pool — feeding the compiler-truth path above.
- **Java record support (baseline)** (`src/analyzers/baseline/java.ts`): `record` declarations are
  class-like for routes, hierarchy, and field/type edges; each record component becomes a `Property`
  node.

### Changed

- **Per-result tier** (`AnalysisResult.tier`): a dynamic analyzer can lower its declared tier for a
  specific project (deep → baseline on fallback). The indexer, the per-language summary, and query
  results all honor the *effective* tier, so a Java index that fell back to baseline never looks
  fully `deep`.
- **Overload-aware symbol lookup** (`src/query/service.ts`): resolving a method by qualified name now
  also matches its overload-disambiguated form (`Foo.bar(int, String)`), so `find_callers` /
  `find_callees` on an overloaded method reach every signature instead of dropping the disambiguated
  nodes.

### Fixed

- **Spring route placeholders** (`src/analyzers/baseline/java.ts`): route-path normalization no
  longer mangles SpEL property placeholders — `@RequestMapping("${api.base}")` keeps its `${…}`
  instead of being rewritten into a `:`-style path variable.

## [0.5.0] - 2026-06-24

Deeper code intelligence: read resolved Java types straight from compiled bytecode (no JVM), export
the graph in a portable interchange format, make config keys first-class nodes, and resolve Java
wildcard imports. All implemented natively, no new dependencies.

### Added

- **Java bytecode analyzer** (`src/analyzers/java-bytecode/`): a pure-TypeScript `.class` reader
  (constant pool, access flags, this/super/interfaces — including the Long/Double two-slot rule) and
  an analyzer that emits Class/Interface nodes plus `Inherits`/`Implements` edges, so a dependency's
  compiled classes (no on-disk source) join the graph **without a JVM**. Emits the same simple-name
  `type:<Name>` candidates the Java source analyzer does (relinked by `deriveTypeEdges`), so it stays
  honestly `baseline`-tier; FQN-precise deep resolution is a follow-up. (#47/#48)
- **`export_code_intel` tool** (`src/export/codeintel.ts`): export the whole index as a portable,
  language-agnostic symbol/occurrence JSON — stable symbol ids plus definition/reference occurrences
  per file — for interop with external code-intelligence tools. (#17/#28)
- **Config-value provenance** (`src/analyzers/dotenv/`): a `.env`-family analyzer makes config keys
  first-class **value-origin** `Variable` nodes (searchable, locatable). Claims the whole family —
  `.env`, `.env.local`, `name.env`, and the committed `.env.example` (whose trailing extension is
  `.example`) — via a new optional `Analyzer.matchesFile()` registry hook. Only key *names* are read,
  never values. A whole-graph `deriveEnvReferences` resolver is wired and ready to link
  `process.env.KEY` reads to their origin (read-detection is a follow-up). (#53)

### Changed

- **Wildcard / scope-aware Java resolution**: `import com.foo.*` now resolves to the package's
  directory — a wildcard scope the type and call resolvers search after same-package and single-type
  imports — so a supertype or call reached only through a wildcard import resolves instead of
  dropping. (#34 failure mode #2)

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
