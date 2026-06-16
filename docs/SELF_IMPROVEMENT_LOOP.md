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

The **HTTP dev loop** below removes this rebuild + restart step entirely when iterating on analyzer code.

---

## Restart-free dev loop (HTTP + live reload)

The rebuild + restart above is the price of the **stdio** transport: Claude Code *spawns* the server
and owns its stdin/stdout, so picking up changed code means killing and relaunching that process —
which only Claude Code can do, and Node can't hot-swap its own modules in place. Running Ama as a
**standalone HTTP server from source** inverts that lifecycle and removes the friction.

1. Start the dev server in a terminal (leave it running):

   ```sh
   npm run serve:dev    # tsx watch src/mcp/http.ts — restarts on any src/ change
   ```

   It serves MCP over Streamable HTTP on `http://localhost:7077/mcp`, persists the graph to
   `.ama/index.db`, and reopens that index for the repo root (`AMA_ROOT=.`) at startup.

2. Point `.mcp.json` at the URL instead of the stdio command, and restart Claude Code **once** to read it:

   ```json
   {
     "mcpServers": {
       "ama": { "type": "http", "url": "http://localhost:7077/mcp" }
     }
   }
   ```

   The committed `.mcp.json` stays stdio so a fresh clone works with no terminal server — switch locally
   when you want the dev loop.

Now edit Ama's own analyzer/server code and the change is **live on your next tool call**, no Claude
Code restart:

- `tsx watch` restarts the standalone server whenever a `src/` file changes.
- On restart the persistent SQLite index **reopens in ~1 ms** instead of re-indexing (ndw.2), and
  **connect-time catch-up** (gd5.4) reconciles anything that changed while it bounced.
- Claude Code's next request transparently **reconnects** to the URL, so you query the freshly-built
  analyzer immediately.

Because the server is now a process you *connect to* rather than one the client *spawns*, restarting it
no longer severs the session or drops the index. `run the loop` works under either transport; the HTTP
setup just removes the build + restart step when iterating on Ama's own code.

---

## Known gaps to expect

Ama's TypeScript analysis is intentionally partial in the MVP. The deep analyzer
(`src/analyzers/typescript/analyzer.ts`) emits nodes for File / Function / Class / Interface / Enum /
TypeAlias / Method / Property declarations, and `Defines`, `Calls`, `Inherits`, `Implements`,
`Imports`, and `UsesType` edges (`Calls` covers direct calls *and* `new` construction). For the live,
authoritative census run `get_graph_schema` — this prose drifts as the analyzer grows. What still
doesn't land:

- **Arrow functions and function expressions get no node** — `export const f = () => …` produces no
  Function node, and calls inside it are attributed to the nearest enclosing named function/method
  (or dropped at module top level).
- **get/set accessors get no node** — class fields/properties now do, but accessors don't, so their
  bodies' calls and their types are dropped or mis-attributed.
- **Generics, decorators, and interface-method dispatch are not yet modeled** — see the **Deeper
  TypeScript semantics** epic in `bd` (these are the best-motivated loop targets because Ama's own
  source exercises every one of them).

What already landed (and is *no longer* a gap): `Imports`/re-exports, `Inherits`, `Implements`, and
`UsesType` edges; type aliases and class/interface properties as nodes; `new`-expression construction
as `Calls` edges; and the **Higher-order query tools** epic (`node`, `impact_analysis`, `affected`,
`get_graph_schema`, `search_code`, `explore`).

`find_callers` / `find_callees` will still undercount wherever the above gaps apply — which is exactly
the kind of firsthand gap the loop is designed to surface and close.
