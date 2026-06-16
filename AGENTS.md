# AGENT.md — working with the Ama codebase

Instructions for AI coding agents (and humans) contributing to **Ama**, a local-first
code-intelligence MCP server written in TypeScript. This file is shared and committed; keep any
machine-specific or personal setup out of it (put that in a local, git-ignored instructions file).

Start here: [`README.md`](README.md) for the story, [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md)
for the development loop, and `docs/plans/` for design docs. The backlog lives in **beads** (`bd`) —
run `bd ready` to pick work; see [`docs/ISSUE_TRACKING.md`](docs/ISSUE_TRACKING.md).

## What Ama is

Ama parses code into a queryable graph of symbols and relationships and serves it to agents over MCP.
Its distinguishing bet is **deep, language-specific parsing**: where a language's real compiler is
available (the TypeScript Compiler API, Roslyn for .NET, native Java tooling, …), Ama uses it to
resolve types, overloads, generics, imports, and cross-file binding — far beyond a syntactic pass.
A universal **baseline** parser provides breadth for everything else.

TypeScript is the first supported language, and Ama is itself written in TypeScript — so Ama can
index its own source. **That self-indexing is the built-in regression test for every change.**

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

- **Branch, then merge.** Never commit feature work straight to `main`. Use a short-lived
  `loop/NN-<topic>` branch so each iteration is one isolated, revertable commit, then fast-forward
  `main`. Use [Conventional Commits](https://www.conventionalcommits.org/).

- **Capability tiers, reported honestly.** Each language analyzer declares a tier — `deep` (semantic)
  or `baseline` (syntactic) — and tools surface which tier produced a result. Never let partial or
  baseline-only coverage look like complete, semantic coverage. When a tool *can't* answer something,
  say so (and file it as a backlog item).

- **Standalone project.** Describe Ama's capabilities on their own terms. Don't position it relative
  to, or name, other specific tools in docs, code, comments, or commits.

- **Test-first.** Write a failing test, watch it fail for the right reason, then write the minimal code
  to pass. New analyzer behavior especially: construct a fixture where *only* the slice under test can
  produce the expected node/edge, so the test genuinely fails before the change.

## The development loop (short version)

Ama improves by **dogfooding** — you use Ama's own MCP tools on Ama's own source to find a gap, fix it
test-first, and the server gets better. One backlog item per iteration:

1. **Index.** `index_repository(".")`; record before counts via `index_status()`.
2. **Pick one** ready item (`bd ready`) and claim it (`bd update <id> --claim`). Favor small,
   high-signal gaps that Ama's own source exercises (analyzer `KNOWN GAPS` comments are great picks).
3. **Understand** by using Ama's tools (`search_symbol`, `find_callers`/`find_callees`,
   `get_code_snippet`). If a tool can't answer what you need, that's a gap — file it
   (`bd create … --deps discovered-from:<id>`).
4. **Change it test-first** (RED → GREEN → REFACTOR). Keep `KNOWN GAPS` comments truthful.
5. **Verify:** full suite green **and** Ama still re-indexes itself cleanly; record after counts.
6. **Log the insight** in `docs/insights/README.md`.
7. **Finish:** close the item (`bd close <id> -r "…"`), export beads state
   (`bd export -o .beads/issues.jsonl`), stage it (`git add .beads/`), commit on a `loop/NN` branch,
   fast-forward `main`. A green suite plus a clean self-index are the gate.

Full runbook: [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md).

## Code style & stack

- **Node.js 24+**, **TypeScript** (`strict`), **ESM**. Use `.js` extensions on relative imports
  (NodeNext resolution) and `import type` for type-only imports.
- **MCP:** `@modelcontextprotocol/sdk` over stdio. **Tests:** `vitest`. **Format/lint:** Biome.
- Keep the layering clean: `graph/` (model) → `analyzers/` (per-language, tiered) → `store/` →
  `query/` → `mcp/` (and later `cli/`). Avoid leaking analyzer- or store-specific types across layers.
- Match the surrounding code's naming, comments, and idioms. Prefer small, well-commented passes over
  clever density — analyzer code is read far more than it's written.

## Quick reference

| Need | Do |
|---|---|
| Build | `npm run build` |
| Run tests | `npm test` |
| Type-check only | `npm run typecheck` |
| Pick work | `bd ready` → `bd update <id> --claim` |
| File a discovered gap | `bd create "…" -t task -l <area> --deps discovered-from:<id>` |
| Run the MCP server | `node dist/mcp/server.js` (after `npm run build`) |
| Finish an iteration | `bd close <id> -r …` → `bd export -o .beads/issues.jsonl` → `git add .beads/` → branch → commit → ff `main` |
