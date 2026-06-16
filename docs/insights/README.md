# Insights

Non-obvious technical lessons about this codebase, its dependencies, and the
development loop. Append new entries under **## Log** as `date · area · lesson`.
This log is how lessons compound across iterations.

## Log

- 2026-06-16 · typescript-analyzer · Cross-file call resolution falls out for free *if* every file in an index pass shares one `ts.Program`. `getSymbolAtLocation(call.expression)` plus `getAliasedSymbol` follows imports and re-export chains to the original declaration; the only missing piece is a `Map<ts.Node, string>` from declaration node → graph id so a resolved symbol can be turned back into an edge target. Symbols resolving outside the analyzed set (library code) simply have no entry and are skipped — the graph never asserts an edge it can't back.
- 2026-06-16 · graph · Deriving a symbol id from `(file, qualifiedName)` rather than byte offset makes ids survive edits: moving a function within its file keeps every edge that points at it valid. The `range` lives on the node for snippet extraction but is deliberately excluded from the id.
- 2026-06-16 · mcp · The `@modelcontextprotocol/sdk` high-level `McpServer.registerTool(name, { inputSchema }, cb)` takes `inputSchema` as a Zod *raw shape* (`{ path: z.string() }`), not a `z.object(...)`. Tool results are `{ content: [{ type: "text", text }] }`; the `"text"` literal needs `as const` outside contextual position. `InMemoryTransport.createLinkedPair()` makes the whole server unit-testable against a real `Client` with no child process.
- 2026-06-16 · tooling · `biome format --write` does NOT apply the `organizeImports` assist — `biome check` still fails on unsorted imports. Use `biome check --write` to apply import sorting and other safe fixes. RTK compacts tool output; use `rtk proxy <cmd>` to see a tool's raw diagnostics.
- 2026-06-16 · store · Node 24's built-in `node:sqlite` (`DatabaseSync`) ships **FTS5**, so persistence + full-text symbol search needs zero native dependencies. The implicit `rowid` gives free insertion-order, letting the SQLite store match the in-memory store byte-for-byte under one shared `runStoreContract` — the cleanest way to guarantee two backends stay at parity.
- 2026-06-16 · store · `PRAGMA journal_mode=WAL` is a silent no-op on `:memory:` (returns `memory`), but on a file db it creates a `<db>-wal` sidecar that survives until checkpoint — an observable side effect you can assert in a test without exposing the connection internals.
- 2026-06-16 · tooling · Biome's `noUnusedTemplateLiteral` flags backtick strings with no `${}` (e.g. single-line SQL), but correctly exempts genuinely multi-line ones. It's an *unsafe* fix (`biome check --write --unsafe`) because converting quotes can change escaping — safe here since the SQL had no quotes/backslashes; the test suite is the real proof nothing broke.
