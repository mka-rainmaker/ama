# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

**[`AGENTS.md`](AGENTS.md) is the canonical, committed contributor guide — read it before working.**
This file (`CLAUDE.md`) is committed too and distills the essentials for coding agents working in
this repo. When the two disagree, `AGENTS.md` wins.

## Current state

Ama is **built, published, and public** (`@mka-rainmaker/ama`, v0.5) — `src/`, `tests/`, and `docs/`
all exist, the suite is green. Deep tier = TypeScript (compiler API) + Java (source semantics + JVM
bytecode); baseline tier = tree-sitter for
~14 more languages, plus a heuristic Python call graph (incl. FastAPI test-impact) and framework-route
detection across TS/Python/Go/PHP/Java/Rust. Self-contained, no-Node install bundles ship via the
GitHub Actions release workflow (`curl | sh` / PowerShell) alongside the npm package.

## Use Ama on Ama (dogfooding)

When working in this repo, **answer structural questions with Ama's own MCP tools, not by reading
files**: `search_symbol` / `find_callers` / `find_callees` / `get_code_snippet` to locate and read
code, and `impact_analysis` / `explore` for blast radius. Run `index_repository(".")` first; after
edits the watcher auto-syncs (or call `sync_index`). Using Ama to change Ama *is* the
self-improvement loop — it's how regressions surface. If Ama's MCP tools aren't connected, treat
that as a finding (see [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md)).

## What Ama is

A local-first **code-intelligence MCP server** (TypeScript). It parses a codebase into a queryable
graph of symbols + relationships and serves it to AI agents over MCP (stdio), so one tool call
answers "who calls this?" / "what breaks if I change this?" instead of many file reads. The
distinguishing bet: **deep, language-specific parsing** (the TypeScript Compiler API today; Roslyn,
native Java tooling later) over a universal **baseline** syntactic parser used for breadth.

## Commands

```bash
npm run build         # tsc → dist/
npm run typecheck     # tsc --noEmit
npm test              # vitest run (executes TS sources directly)
npm run test:watch    # vitest watch mode
npm run lint          # biome check .
npm run format        # biome format --write .
npm run serve         # node dist/mcp/server.js  (requires a prior build)
```

Run a single test: `npx vitest run tests/path/to/file.test.ts`, or by name: `npx vitest run -t "<name>"`.
Tests live in `tests/**/*.test.ts` (see `vitest.config.ts`); `tsconfig.json` excludes `tests/` from the build.

## Architecture (the pipeline)

```
source files ─▶ analyzer (deep | baseline) ─▶ graph (nodes + edges) ─▶ store ─▶ query ─▶ MCP tools
```

Keep this layering clean and don't leak analyzer- or store-specific types across boundaries:
`graph/` (language-agnostic model) → `analyzers/` (per-language, each declaring its tier) →
`store/` (in-memory or SQLite+FTS5) → `query/` → `mcp/` + `cli/`. The TypeScript deep
analyzer is the reference implementation.

## Non-obvious rules that shape the code

- **stdout is sacred in `src/mcp`.** That stream carries JSON-RPC only — a single stray
  `console.log`/`process.stdout.write` corrupts the protocol. **All logging goes to stderr**
  (`console.error`).
- **Tests run against source; the server runs from `dist/`.** `npm test` reflects edits immediately,
  but a running MCP client won't see analyzer/server changes until `npm run build` + client restart.
- **Self-indexing is the built-in regression test.** A change isn't done until the suite is green
  **and** Ama re-indexes its own source cleanly.
- **Report capability tiers honestly.** Each analyzer is `deep` (semantic) or `baseline` (syntactic),
  and every tool result surfaces which tier produced it. Never let baseline-only coverage look complete.
- **Branch → PR → merge.** `main` is protected: no direct pushes. Work on a short-lived branch, open a
  PR, and let CI (build/typecheck/test/lint) + a code-owner review pass before a squash-merge. Use
  Conventional Commits and reference the issue (`Closes #N`).
- **Log insights as you go.** Non-obvious lessons get appended to `docs/insights/README.md` (under
  "## Log") as part of the same change — this is a required step, not optional.

## Stack conventions

Node.js **24+**, TypeScript `strict` + `noUncheckedIndexedAccess`, **ESM** with NodeNext resolution:
use **`.js` extensions on relative imports** and `import type` for type-only imports
(`verbatimModuleSyntax` is on). MCP via `@modelcontextprotocol/sdk`; validation via `zod`; tests via
`vitest`; format/lint via Biome (2-space indent, 100 cols, double quotes).

## Issue tracking

Issues and the backlog live in [**GitHub Issues**](https://github.com/mka-rainmaker/ama/issues):
`gh issue list` to find actionable work, `gh issue create` to file a gap. Reference issues from PRs
with `Closes #N`. (Do not use TodoWrite or markdown TODO lists for project tracking.)
