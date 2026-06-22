# AGENTS.md — working with the Ama codebase

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

### Non-goals

**Telemetry is a deliberate non-goal.** Ama collects no usage analytics and makes no network calls
of its own — it reads local source and serves the graph to a locally-connected MCP client; the only
outbound traffic is whatever that client itself makes. A code-intelligence tool runs over private
source, so the privacy default is "nothing leaves the machine," and any future feature must preserve
it. (ama-da3)

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
3. **Understand** by using Ama's tools — `search_symbol`/`search_code`, `find_callers`/`find_callees`,
   the relationship tools (`find_implementations`/`find_interfaces`/`find_importers`/`find_imports`/
   `find_type_users`/`find_types_used`), the higher-order ones (`node`, `impact_analysis`, `affected`,
   `get_graph_schema`, `explore`), and `get_code_snippet`; `sync_index` reconciles on-disk edits. If a
   tool can't answer what you need, that's a gap — file it (`bd create … --deps discovered-from:<id>`).
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
| Pick work | `bd ready` → `bd update <id> --claim` |
| File a discovered gap | `bd create "…" -t task -l <area> --deps discovered-from:<id>` |
| Run the MCP server | `node dist/mcp/server.js` (after `npm run build`) |
| Restart-free dev loop | `npm run serve:dev` (HTTP from source, live reload) → point `.mcp.json` at `http://localhost:7077/mcp`; see `docs/SELF_IMPROVEMENT_LOOP.md` |
| Finish an iteration | `bd close <id> -r …` → `bd export -o .beads/issues.jsonl` → `git add .beads/` → branch → commit → ff `main` |

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
