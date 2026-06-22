# Ama 🐶

**Ama** is a local-first **code-intelligence server** that speaks the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It parses a codebase into a queryable knowledge graph of symbols and their relationships, then hands that graph to AI coding agents — so an agent can answer *"who calls this?"*, *"what breaks if I change this?"*, and *"show me this function and its callers"* in a **single tool call** instead of dozens of file reads.

Named after a puppy: small, eager, and a little smarter every day.

> Status: **0.1.** Deep TypeScript analysis plus syntactic baseline coverage for 13 more languages, 27 MCP tools, an `ama` CLI, and persistent incremental indexing — all able to index Ama's own source cleanly as the built-in regression test. Deep-tier .NET/Java analyzers (behind the sidecar protocol) are next.

## Why Ama

Most code-graph tools parse every language the same way: one fast, syntactic pass that sees *shapes* but not *meaning*. Ama takes a different bet — **use each language's real compiler when one exists.**

- **Deep tier — language-specific semantic analysis.** TypeScript via the TypeScript Compiler API today; .NET via Roslyn and Java via its native tooling next. This resolves types, overloads, generics, imports/re-exports, interface dispatch, and cross-file symbol binding that a purely syntactic parser cannot.
- **Baseline tier — universal syntactic analysis for breadth.** Every other language still gets parsed for structure, so the whole repo is navigable from day one.

Every answer reports **which tier produced it**, so partial coverage never quietly masquerades as complete.

And because it's built for agents:

- **100% local.** No external APIs, no API keys, no telemetry. Your code never leaves your machine.
- **Cheaper and faster.** Fewer tool calls and fewer tokens per question, because one graph query replaces a pile of file reads.

## Install

> Requires **Node.js 24+**.

Ama runs as a local MCP server your coding agent launches over stdio. Install it once, then point your agent at `ama mcp`:

```bash
npm install -g @mka-rainmaker/ama
```

(Or skip the global install and use `npx -y @mka-rainmaker/ama mcp` as the command below.)

### Configure your coding agent

Every MCP client spawns the same stdio command — `ama mcp` — only the config location differs.

**Claude Code** — add it with one command:

```bash
claude mcp add ama -- ama mcp
```

…or add it to a project `.mcp.json`:

```json
{ "mcpServers": { "ama": { "command": "ama", "args": ["mcp"] } } }
```

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{ "mcpServers": { "ama": { "command": "ama", "args": ["mcp"] } } }
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "ama": { "command": "ama", "args": ["mcp"] } } }
```

**Any other MCP client** — spawn `ama mcp` over stdio. If you didn't install globally, run it via `npx`:

```json
{ "mcpServers": { "ama": { "command": "npx", "args": ["-y", "@mka-rainmaker/ama", "mcp"] } } }
```

### Quick start

Once connected, point Ama at a repo and start asking graph questions:

1. **`index_repository("/path/to/your/project")`** — builds the graph (run this first).
2. **`search_symbol`**, **`find_callers`**, **`find_callees`**, **`get_code_snippet`**, **`impact_analysis`**, … — query it.

Ama re-indexes changed files automatically while connected. Call `index_status()` to see what's indexed and the per-language coverage + tier.

### CLI

The same package ships an `ama` CLI mirroring the query surface, for one-shot use and scripting (e.g. `git diff --name-only | ama affected`):

```bash
ama --help     # list commands
ama mcp        # run the MCP server over stdio (what coding agents spawn)
```

## What's in 0.1

- **Deep TypeScript analysis** via the TypeScript Compiler API — types, overloads, generics, imports/re-exports, inheritance, interface dispatch, cross-file binding, and call graphs.
- **Baseline breadth** for 13 more languages via tree-sitter: C, C++, C#, Go, Java, JavaScript, Kotlin, PHP, Python, Rust, Swift, and Vue/Svelte single-file components.
- **27 MCP tools** — search, call graph, references, type usage, inheritance/overrides, imports/importers, routes → handlers, code snippets, plus higher-order `explore`, `impact_analysis`, and `search_code` — each tagging the tier that produced it.
- **Persistent indexing** (SQLite + full-text search) with **incremental re-indexing**: edits are picked up automatically while connected.
- **Cross-project queries** — index several repos in one session and target any of them by path.
- **An `ama` CLI** for one-shot queries and scripting.

## Next

- **Deep-tier .NET (Roslyn) and Java analyzers** behind the sidecar protocol (the protocol + harness ship in 0.1; the analyzers need their language toolchains).
- More baseline languages and richer framework awareness.

## How it works

```
 source files ──▶ analyzer (deep | baseline) ──▶ graph (nodes + edges) ──▶ store ──▶ query ──▶ MCP tools
```

- **Graph model** — language-agnostic `nodes` (File, Module, Class, Interface, Enum, Function, Method, …) and `edges` (Defines, Calls, Inherits, Implements, UsesType, Imports, References, …). Each symbol gets a stable, location-independent id.
- **Analyzers** — pluggable per language, each declaring its tier (`deep` or `baseline`). The TypeScript deep analyzer is the reference implementation.
- **Store** — in-memory, or SQLite with full-text search for persistence.
- **Query service** — search, call-graph traversal, code snippets, and impact analysis.
- **MCP server** — exposes the query surface over stdio.

## MCP tools

| Tool | What it does |
|---|---|
| `index_repository(path)` | Build the graph for a directory or project. Run first. |
| `index_status()` | What's indexed: node/edge counts, per-language coverage + tier. |
| `search_symbol(query)` / `search_code(query)` | Find symbols by name, or search snippet text. |
| `find_callers` / `find_callees` | Who calls a function/method, and what it calls. |
| `find_referrers` / `find_imports` / `find_importers` | Where a symbol is used / what a file imports / who imports it. |
| `impact_analysis(symbol)` | Transitive blast radius for change/test selection. |
| `explore(question)` | Relevant symbols, a relationship map, and blast radius in one call. |
| `get_code_snippet(symbol)` / `file_skeleton(file)` | A symbol's source, or a file's symbol outline. |

…and more (overrides, interfaces, type users, routes → handlers, circular imports). Call `get_graph_schema()` for the full node/edge model, or `ama --help` for the CLI.

## How Ama is built

Ama improves itself by **dogfooding**: each change is made by using Ama's own tools on Ama's own source, and is only considered done once Ama can **re-index itself cleanly** — that self-index is the project's built-in regression test. Lessons learned along the way are recorded in [`docs/insights/`](docs/insights/README.md) so they compound over time. See [`docs/SELF_IMPROVEMENT_LOOP.md`](docs/SELF_IMPROVEMENT_LOOP.md) for the workflow and [`AGENTS.md`](AGENTS.md) for contributor and agent conventions.

## Development

> Requires **Node.js 24+**.

```bash
git clone https://github.com/mka-rainmaker/ama.git
cd ama
npm install
npm run build       # compile TypeScript to dist/
npm test            # run the test suite (vitest)
npm run typecheck   # type-check without emitting
```

The backlog is tracked with [beads](https://github.com/steveyegge/beads) (`bd ready` to see what's actionable).

## License

[MIT](LICENSE) © 2026 Mykhaylo Katruk
