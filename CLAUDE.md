# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

**[`AGENTS.md`](AGENTS.md) is the canonical, committed contributor guide — read it before working.**
This file (`CLAUDE.md`) is git-ignored (`.gitignore`: "Local-only Claude instructions") and only
distills the essentials. When the two disagree, `AGENTS.md` wins.

## Current state: pre-implementation scaffold

The only git-tracked file is `LICENSE`; the rest (configs, `README.md`, `AGENTS.md`) is still
untracked. **The `src/`, `docs/`, `tests/`, and `.beads/` directories do not exist yet** — `README.md`
and `AGENTS.md` describe the *target* architecture, not what's on disk. Don't go looking for source
files the docs reference; you'll likely be creating them.

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

## Architecture (the planned pipeline)

```
source files ─▶ analyzer (deep | baseline) ─▶ graph (nodes + edges) ─▶ store ─▶ query ─▶ MCP tools
```

Keep this layering clean and don't leak analyzer- or store-specific types across boundaries:
`graph/` (language-agnostic model) → `analyzers/` (per-language, each declaring its tier) →
`store/` (in-memory now, SQLite later) → `query/` → `mcp/` (and later `cli/`). The TypeScript deep
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
- **Branch, then merge.** No feature work straight to `main`; use a short-lived `loop/NN-<topic>`
  branch (one isolated, revertable commit) and fast-forward. Use Conventional Commits.
- **Log insights as you go.** Non-obvious lessons get appended to `docs/insights/README.md` (under
  "## Log") as part of the same change — this is a required step, not optional.

## Stack conventions

Node.js **24+**, TypeScript `strict` + `noUncheckedIndexedAccess`, **ESM** with NodeNext resolution:
use **`.js` extensions on relative imports** and `import type` for type-only imports
(`verbatimModuleSyntax` is on). MCP via `@modelcontextprotocol/sdk`; validation via `zod`; tests via
`vitest`; format/lint via Biome (2-space indent, 100 cols, double quotes).

## Issue tracking

The backlog lives in **beads** (`bd`): `bd ready` to see actionable work, `bd update <id> --claim` to
claim. See `docs/ISSUE_TRACKING.md` (once it exists) and the full loop in `docs/SELF_IMPROVEMENT_LOOP.md`.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
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
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
