# AGENTS.md — working with the Ama codebase

Instructions for AI coding agents (and humans) contributing to **Ama**, a local-first
code-intelligence MCP server written in TypeScript. This file is shared and committed; keep any
machine-specific or personal setup out of it (put that in a local, git-ignored instructions file).

Start here: [`README.md`](README.md) for the story, [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md)
for the development loop, and `docs/plans/` for design docs. The backlog lives in
[**GitHub Issues**](https://github.com/mka-rainmaker/ama/issues) — `gh issue list` to see open work,
`gh issue create` to file something.

## What Ama is

Ama parses code into a queryable graph of symbols and relationships and serves it to agents over MCP.
Its distinguishing bet is **deep, language-specific parsing**: where a language's real compiler is
available (the TypeScript Compiler API, Roslyn for .NET, native Java tooling, …), Ama uses it to
resolve types, overloads, generics, imports, and cross-file binding — far beyond a syntactic pass.
A universal **baseline** parser provides breadth for everything else.

TypeScript is the first supported language, and Ama is itself written in TypeScript — so Ama can
index its own source. **That self-indexing is the built-in regression test for every change.**

### Non-goals

**Telemetry is a deliberate non-goal.** Ama collects no usage analytics and makes no network calls
of its own — it reads local source and serves the graph to a locally-connected MCP client; the only
outbound traffic is whatever that client itself makes. A code-intelligence tool runs over private
source, so the privacy default is "nothing leaves the machine," and any future feature must preserve it.

## Insights — required, no exceptions

Whenever you discover an **insight** — a non-obvious technical lesson, gotcha, root cause, or "aha"
about this codebase, the TypeScript Compiler API, tree-sitter, the MCP SDK, or the development loop
itself — **append it to [`docs/insights/README.md`](docs/insights/README.md)** (under "## Log") as
part of the same change. Keep each entry short: `date · area · the lesson`. This log is how lessons
compound across iterations — it is the point.

## Working norms

- **stdout is sacred.** In `src/mcp` (the MCP server), stdout carries JSON-RPC only. Never write to
  stdout there (`console.log`, `process.stdout.write`, stray `print`s). **All logging goes to stderr**
  (`console.error`). A single stray stdout write corrupts the protocol stream.

- **Tests run against source; the server runs from the build.** `npm test` (vitest) executes the
  TypeScript sources directly, so test results reflect your changes immediately. The MCP server,
  however, runs from compiled output in `dist/`. Analyzer/server changes are therefore **not live in a
  running MCP client until `npm run build` and the client is restarted.** Verify changes with
  `npm test`; treat a live re-index as post-restart confirmation.

- **Branch → PR → merge.** `main` is protected — never push to it directly. Work on a short-lived
  branch, open a pull request, and let CI (build, type-check, test, lint) **and** a code-owner review
  pass before a **squash-merge**. Use [Conventional Commits](https://www.conventionalcommits.org/) and
  reference the issue (`Closes #123`).

- **Capability tiers, reported honestly.** Each language analyzer declares a tier — `deep` (semantic)
  or `baseline` (syntactic) — and tools surface which tier produced a result. Never let partial or
  baseline-only coverage look like complete, semantic coverage. When a tool *can't* answer something,
  say so (and file a GitHub issue).

- **Test-first.** Write a failing test, watch it fail for the right reason, then write the minimal code
  to pass. New analyzer behavior especially: construct a fixture where *only* the slice under test can
  produce the expected node/edge, so the test genuinely fails before the change.

## The development loop (short version)

Ama improves by **dogfooding** — you use Ama's own MCP tools on Ama's own source to find a gap, fix it
test-first, and the server gets better. One issue per iteration:

1. **Index.** `index_repository(".")`; record before counts via `index_status()`.
2. **Pick an open issue** (`gh issue list`) and assign yourself. Favor small, high-signal gaps that
   Ama's own source exercises (analyzer `KNOWN GAPS` comments are great picks).
3. **Understand** by using Ama's tools — `search_symbol`/`search_code`, `find_callers`/`find_callees`,
   the relationship tools (`find_implementations`/`find_interfaces`/`find_importers`/`find_imports`/
   `find_type_users`/`find_types_used`), the higher-order ones (`node`, `impact_analysis`, `affected`,
   `get_graph_schema`, `explore`), and `get_code_snippet`; `sync_index` reconciles on-disk edits. If a
   tool can't answer what you need, that's a gap — file it (`gh issue create`).
4. **Change it test-first** (RED → GREEN → REFACTOR). Keep `KNOWN GAPS` comments truthful.
5. **Verify:** full suite green **and** Ama still re-indexes itself cleanly; record after counts.
6. **Log the insight** in `docs/insights/README.md`.
7. **Finish:** commit on a branch, open a PR (`Closes #N`); a green suite, passing CI, and a clean
   self-index are the gate. Squash-merge once CI + review are green.

Full runbook: [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md).

## Code style & stack

- **Node.js 24+**, **TypeScript** (`strict`), **ESM**. Use `.js` extensions on relative imports
  (NodeNext resolution) and `import type` for type-only imports.
- **MCP:** `@modelcontextprotocol/sdk` over stdio and Streamable HTTP. **Tests:** `vitest`. **Format/lint:** Biome.
- Keep the layering clean: `graph/` (model) → `analyzers/` (per-language, tiered) → `store/` →
  `query/` → `mcp/` + `cli/`. Avoid leaking analyzer- or store-specific types across layers.
- Match the surrounding code's naming, comments, and idioms. Prefer small, well-commented passes over
  clever density — analyzer code is read far more than it's written.

## Quick reference

| Need | Do |
|---|---|
| Build | `npm run build` |
| Run tests | `npm test` |
| Type-check only | `npm run typecheck` |
| Lint | `npm run lint` (assert the exit code — don't eyeball a tail) |
| Find / file work | `gh issue list` / `gh issue create` |
| Run the MCP server | `node dist/mcp/server.js` (after `npm run build`) |
| Restart-free dev loop | `npm run serve:dev` (HTTP from source, live reload) → point `.mcp.json` at `http://localhost:7077/mcp`; see `docs/SELF_IMPROVEMENT_LOOP.md` |
| Finish an iteration | branch → PR (`Closes #N`) → CI + review green → squash-merge |
