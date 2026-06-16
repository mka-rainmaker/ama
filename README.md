# Ama 🐶

**Ama** is a local-first **code-intelligence server** that speaks the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It parses a codebase into a queryable knowledge graph of symbols and their relationships, then hands that graph to AI coding agents — so an agent can answer *"who calls this?"*, *"what breaks if I change this?"*, and *"show me this function and its callers"* in a **single tool call** instead of dozens of file reads.

Named after a puppy: small, eager, and a little smarter every day.

> Status: **early.** The first milestone is a working TypeScript-first vertical slice (index → graph → query over MCP, with the server able to index its own source). The roadmap below is mostly ahead of us, and the README describes where Ama is going as much as where it is.

## Why Ama

Most code-graph tools parse every language the same way: one fast, syntactic pass that sees *shapes* but not *meaning*. Ama takes a different bet — **use each language's real compiler when one exists.**

- **Deep tier — language-specific semantic analysis.** TypeScript via the TypeScript Compiler API; .NET via Roslyn; Java via its native tooling; and more over time. This resolves types, overloads, generics, imports/re-exports, interface dispatch, and cross-file symbol binding that a purely syntactic parser cannot.
- **Baseline tier — universal syntactic analysis for breadth.** Every other language still gets parsed for structure, so the whole repo is navigable from day one.

Every answer reports **which tier produced it**, so partial coverage never quietly masquerades as complete.

And because it's built for agents:

- **100% local.** No external APIs, no API keys, no telemetry by default. Your code never leaves your machine.
- **Cheaper and faster.** Fewer tool calls and fewer tokens per question, because one graph query replaces a pile of file reads.

## Roadmap

- [ ] **MVP (TypeScript-first):** index a TS project into an in-memory graph; `search_symbol`, `find_callers`, `find_callees`, `get_code_snippet` over MCP; Ama indexes its own source cleanly.
- [ ] Deeper TypeScript edges: type usages, imports/re-exports, inheritance, decorators, generics.
- [ ] Persistent storage (SQLite + full-text search) with per-file staleness tracking.
- [ ] Incremental re-indexing with a file watcher and debounced syncs.
- [ ] Baseline-tier breadth via a syntactic parser (JavaScript, Python, Go, Rust, Java, C#, …).
- [ ] **Deep-tier language analyzers** behind a sidecar protocol: .NET (Roslyn), Java (native tooling).
- [ ] Higher-order tools: `explore`, `impact_analysis`, `get_graph_schema`, `search_code`.
- [ ] Framework awareness (routes → handlers) and a `ama` CLI.

## How it works

```
 source files ──▶ analyzer (deep | baseline) ──▶ graph (nodes + edges) ──▶ store ──▶ query ──▶ MCP tools
```

- **Graph model** — language-agnostic `nodes` (File, Module, Class, Interface, Enum, Function, Method, …) and `edges` (Defines, Calls, Inherits, Implements, UsesType, Imports, …). Each symbol gets a stable, location-independent id.
- **Analyzers** — pluggable per language, each declaring its tier (`deep` or `baseline`). The TypeScript deep analyzer is the reference implementation.
- **Store** — in-memory for the MVP, graduating to SQLite with full-text search.
- **Query service** — search, call-graph traversal, code snippets, and (later) impact analysis.
- **MCP server** — exposes the query surface over stdio.

## MCP tools

| Tool | What it does |
|---|---|
| `index_repository(path)` | Build the graph for a directory or project. Run first. |
| `index_status()` | Whether anything is indexed, plus node/edge counts and per-language coverage + tier. |
| `search_symbol(query, …)` | Find symbols by name. |
| `find_callers(symbol)` | Every place that calls a function/method. |
| `find_callees(symbol)` | What a function/method calls. |
| `get_code_snippet(symbol)` | A symbol's verbatim source. |
| `explore(question)` *(planned)* | Relevant symbols, a relationship map, and blast radius in one call. |
| `impact_analysis(symbol)` *(planned)* | Transitive blast radius for change/test selection. |

## Quick start

> Requires **Node.js 24+**.

```bash
git clone https://github.com/mka-rainmaker/ama.git
cd ama
npm install
npm run build
npm test
```

Wire Ama into an MCP-capable client by pointing it at the built server (see `.mcp.json`):

```json
{
  "mcpServers": {
    "ama": { "command": "node", "args": ["dist/mcp/server.js"] }
  }
}
```

Then ask the agent to `index_repository(".")` and start querying.

## How Ama is built

Ama improves itself by **dogfooding**: each change is made by using Ama's own tools on Ama's own source, and is only considered done once Ama can **re-index itself cleanly** — that self-index is the project's built-in regression test. Lessons learned along the way are recorded in [`docs/insights/`](docs/insights/README.md) so they compound over time. See [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md) for the workflow and [`AGENTS.md`](AGENTS.md) for contributor and agent conventions.

## Development

```bash
npm run build       # compile TypeScript to dist/
npm test            # run the test suite (vitest)
npm run typecheck   # type-check without emitting
```

The backlog is tracked with [beads](https://github.com/steveyegge/beads) (`bd ready` to see what's actionable).

## License

[MIT](LICENSE) © 2026 Mykhaylo Katruk
