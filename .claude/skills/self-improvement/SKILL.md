---
name: self-improvement
description: Use when asked to run the loop, run a self-improvement iteration, self-improve Ama, dogfood Ama on itself, or work an Ama backlog item (tracked in beads / bd) — in the ama repo.
---

# Ama Self-Improvement Loop

## Overview

Ama improves itself: you use **Ama's own MCP tools on Ama's own source** to find a gap, fix it
test-first, and the server gets better. The dogfooding is the point — if you understand the code
with Read/Grep instead of Ama's tools, you ran a normal dev task, **not** a loop iteration.

Two non-negotiables: (1) you must actually **call Ama's MCP tools** (not grep/Read) to understand
the code; (2) every iteration ends with Ama **re-indexing itself** (the built-in regression test)
and an **insight logged**.

## Step 0 — Verify Ama is connected (do this FIRST, every time)

Run `/mcp` (or confirm the `index_repository` / `search_symbol` tools exist). **If Ama's tools are
NOT available, STOP and tell the user** — do not proceed by reading files. The loop is impossible
without the live server. Recovery the user must do:

1. `node --version` → must be ≥ 24.
2. `npm run build` (the server runs from compiled `dist/`, not the TypeScript source).
3. **Restart Claude Code from the repo root** so it reads `.mcp.json` and spawns Ama.

You cannot restart Claude Code yourself — so if it is not connected, hand back to the user.

**Don't *assume* it's connected.** The only proof is calling a tool and getting a real result —
`index_repository(".")` returning counts (step 1) is that proof. If `/mcp` is ambiguous or the call
doesn't actually run, treat the server as down and STOP. "Probably connected" is not connected.

## Environment gotchas (will waste your time if unknown)

- A shell hook **`rtk`** wraps commands and **compacts their output**, hiding real vitest/tsc errors.
  To see true output: **`rtk proxy npx vitest run`** / **`rtk proxy npm run build`**.
- **Tests run against source; the server runs from `dist/`.** `npm test` (vitest) reflects your edits
  immediately, but a running MCP client won't see analyzer/server changes until `npm run build` +
  a Claude Code restart. **Verify with `npm test`; treat a live re-index as post-restart confirmation.**
- **stdout is sacred** in `src/mcp` — never `console.log` / `process.stdout.write` there (it corrupts
  the JSON-RPC stream). All logging goes to stderr (`console.error`).

## The cycle

1. **Index.** Call `index_repository(".")`; record before counts (`index_status`). It must succeed —
   that is the smoke signal.
2. **Pick ONE item** with `bd ready`, then **claim it**: `bd update <id> --claim`. One item, not a
   batch. Favor small, high-signal gaps Ama's *own* source exercises — analyzer `KNOWN GAPS` comments
   and items a prior iteration filed are the best-motivated picks. (Backlog is `bd` — see
   `docs/ISSUE_TRACKING.md`.)
3. **Dogfood — understand via Ama's tools, not grep.** Use `search_symbol` to locate code,
   `find_callers` / `find_callees` for blast radius, `get_code_snippet` to read it. If a tool *can't*
   answer something you need, that itself is a captured gap → file it (see Out-of-scope finds).
4. **Change it test-first** (**REQUIRED SUB-SKILL:** superpowers:test-driven-development): failing
   test → minimal implementation → green. Construct the fixture so the test fails for the *right
   reason* before the change. Keep `KNOWN GAPS` comments truthful if you shift one. Respect the
   layering (`graph/ → analyzers/ → store/ → query/ → mcp/`), `.js` import extensions, `import type`.
5. **Verify:** full suite green (`npm test`) **and** the self-index gate (`tests/self-index.test.ts`)
   **and** re-index — confirm Ama still indexes itself and the counts moved as expected. Record after
   counts. Lint clean: `npm run lint` (use `biome check --write .` to auto-fix imports/format).
6. **Log the insight** (REQUIRED): append to `docs/insights/README.md` under "## Log" as
   `date · area · lesson` — what changed, before/after self-index counts, any non-obvious finding.
7. **Finish — automatically, no review gate, don't ask:** `bd close <id> -r "<what changed +
   before/after counts>"`, then `bd export -o .beads/issues.jsonl` and `git add .beads/`. Commit on a
   `loop/NN-<topic>` branch (Conventional Commits), fast-forward `main`, **push `main` to origin**,
   and **delete the local `loop/NN` branch**. Running the loop *is* the authorization to commit and
   push — the green suite + clean self-index are the only gate.

## Out-of-scope finds (don't silently absorb them)

While dogfooding you will trip over bugs or gaps unrelated to the claimed item. Never swallow them:

- **Not blocking delivery of the current item** → file it immediately and stay on scope:
  `bd create "…" -t bug|task -l <area> --deps discovered-from:<claimed-id>`.
- **Blocking delivery** → fix it *now* as part of this iteration (you cannot ship the item around it),
  and note it in the close reason.

## Red flags — you are NOT running the loop

- You understood the code with Read/Grep and never called an Ama MCP tool → not dogfooding.
- You skipped the `docs/insights/` entry → the project's whole premise is compounding lessons.
- You batched several backlog items → keep iterations atomic and reviewable.
- You committed feature work straight to `main` instead of via a `loop/NN` branch.
- You stopped before pushing "to be conservative" — for this loop, finishing *includes* the push.
- You merged/pushed with a red suite or a failing self-index — green is the unconditional gate.
- Ama wasn't connected and you "made do" by reading files instead of stopping.

## Quick reference

| Need | Do |
|---|---|
| Is Ama live? | `/mcp`; if not → STOP, user runs `npm run build` + restarts Claude Code |
| See real test/build errors | `rtk proxy npx vitest run` / `rtk proxy npm run build` |
| Pick work | `bd ready` → `bd update <id> --claim` (one item; see `docs/ISSUE_TRACKING.md`) |
| Understand code | `search_symbol` / `find_callers` / `find_callees` / `get_code_snippet` (NOT grep) |
| Out-of-scope find | non-blocking → `bd create … --deps discovered-from:<id>`; blocking → fix now |
| Verify a change | `npm test` + self-index gate (MCP is cached until rebuild + restart) |
| Finish | `bd close` → `bd export` → `git add .beads/` → `loop/NN` branch → commit → ff `main` → push origin → delete branch (no review gate) |
