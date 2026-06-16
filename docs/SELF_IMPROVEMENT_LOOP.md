# Ama self-improvement loop — runbook

Ama is a code-intelligence MCP server. It parses a repository into a graph of symbols and
relationships and exposes that graph to Claude Code through a handful of tools. This runbook
explains how to register Ama with Claude Code, point it at its own source, and run the iterative
loop in which Ama is used to improve Ama.

The headline signal of the loop is the **self-index**: every iteration, Ama must successfully index
its own source and return a sane, growing node/edge count (`tests/self-index.test.ts` guards this).
If a change breaks indexing, the loop cannot proceed — correctness is enforced by the loop's own
mechanics.

The day-to-day steps live in the **`self-improvement` skill** (`.claude/skills/self-improvement/`),
which Claude loads when you ask it to "run the loop". This document is the setup + reference behind it.

---

## One-time setup

1. **Node.js 24+.** The committed `.mcp.json` launches the server with `node`, so a 24.x Node must be
   on `PATH` for the shell that starts Claude Code.

   ```sh
   node --version   # must be >= 24
   ```

2. **Install dependencies and build the server.** The server runs from compiled output in `dist/`,
   so it must exist before Claude Code can launch it:

   ```sh
   npm install
   npm run build    # tsc -> dist/, producing dist/mcp/server.js
   ```

3. **Install beads (`bd`) and rebuild the issue DB.** The backlog lives in beads:

   ```sh
   brew install beads
   bd ready          # sanity-check: prints the claimable backlog
   ```

   Full workflow and the git model: `docs/ISSUE_TRACKING.md`.

---

## Wire-up

`.mcp.json` at the repository root registers Ama as a **project-scoped** stdio MCP server:

```json
{
  "mcpServers": {
    "ama": { "command": "node", "args": ["dist/mcp/server.js"] }
  }
}
```

The `args` path is relative to the project root, because Claude Code launches the server with the
project root as its working directory. To activate it, **restart / relaunch Claude Code from the
repository root** so it reads `.mcp.json` and spawns the Ama MCP process. Once connected, Ama's tools
become available:

- `index_repository(path)` — build/refresh the graph for a repo or project directory.
- `index_status()` — current index state: node/edge counts + per-language coverage and tier.
- `search_symbol(query, limit?)` — find symbols by name.
- `find_callers(symbol)` — who calls this symbol.
- `find_callees(symbol)` — what this symbol calls.
- `get_code_snippet(symbol)` — verbatim source for a symbol.

---

## The loop

```
┌──────────────────────────────────────────────────────────────────────┐
│ 0. /mcp → confirm Ama is connected (else STOP: build + restart)       │
│ 1. index_repository(".")              ← Ama indexes itself            │
│ 2. bd ready → bd update <id> --claim  ← one item                     │
│ 3. Understand it with Ama's OWN tools (search_symbol/find_callers/…)  │
│ 4. Change test-first; re-index; npm test green                        │
│ 5. Out-of-scope find? file (non-blocking) or fix now (blocking)       │
│ 6. Log an insight in docs/insights/README.md                          │
│ 7. bd close + export; commit on loop/NN; ff main; push; loop          │
└──────────────────────────────────────────────────────────────────────┘
```

The mechanics, gotchas, and red flags are in the `self-improvement` skill — read it (or ask Claude to
"run a self-improvement iteration"). The two rules that make it a *loop* and not a normal dev task:
you must understand the code through **Ama's own MCP tools** (not Read/Grep), and every iteration ends
with a clean **self-index** plus a logged **insight**.

---

## Rebuild note (important)

The server runs from compiled `dist/`, and Claude Code caches the running MCP process. So after
changing any server/analyzer code, the new behavior is **not** live until you both:

1. `npm run build`
2. **Restart Claude Code** so it relaunches the Ama process against the new `dist/`.

Test-only changes don't need this — `npm test` (vitest) runs the TypeScript sources directly, so the
suite always reflects your edits. The rebuild + restart cycle is only for the server you query through
MCP. (See also: `rtk` compacts command output — use `rtk proxy npx vitest run` to see raw errors.)

---

## Known gaps to expect

Ama's TypeScript analysis is intentionally partial in the MVP. The deep analyzer
(`src/analyzers/typescript/analyzer.ts`) emits nodes only for File / Function / Class / Interface /
Enum / Method declarations, and `Calls` edges only for direct call expressions. So today:

- **Arrow functions and function expressions get no node** — `export const f = () => …` produces no
  Function node, and calls inside it are attributed to the nearest enclosing named function/method
  (or dropped at module top level).
- **Class fields / properties and get/set accessors get no node** — only methods do, so calls inside
  initializers and accessors are dropped or mis-attributed.
- **`new Foo()` produces no `Calls` edge** — construction is a `NewExpression`, not a call expression.
- **Imports/re-exports, inheritance, interface dispatch, generics, decorators, and type usages are
  not yet edges** — see the **Deeper TypeScript semantics** epic in `bd` (these are the best-motivated
  loop targets because Ama's own source exercises every one of them).

`find_callers` / `find_callees` will undercount wherever the above applies — which is exactly the kind
of firsthand gap the loop is designed to surface and close.
