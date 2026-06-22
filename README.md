# Ama 🐶

<p align="center">
  <a href="https://www.npmjs.com/package/@mka-rainmaker/ama"><img alt="npm" src="https://img.shields.io/npm/v/@mka-rainmaker/ama?label=npm&color=007ec6"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-e0a100"></a>
  <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-44883e">
</p>
<p align="center">
  <img alt="macOS supported" src="https://img.shields.io/badge/macOS-supported-4c8eda">
  <img alt="Linux supported" src="https://img.shields.io/badge/Linux-supported-4c8eda">
  <img alt="Windows supported" src="https://img.shields.io/badge/Windows-supported-4c8eda">
</p>
<p align="center">
  <img alt="Claude Code supported" src="https://img.shields.io/badge/Claude_Code-supported-8a3ffc">
  <img alt="Cursor supported" src="https://img.shields.io/badge/Cursor-supported-8a3ffc">
  <img alt="Windsurf supported" src="https://img.shields.io/badge/Windsurf-supported-8a3ffc">
  <img alt="Codex supported" src="https://img.shields.io/badge/Codex-supported-8a3ffc">
  <img alt="any MCP client" src="https://img.shields.io/badge/+_any_MCP_client-via_config-9f9f9f">
</p>

**Ama** is a local-first **code-intelligence server** that speaks the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It parses a codebase into a queryable knowledge graph of symbols and their relationships, then hands that graph to AI coding agents — so an agent answers *"who calls this?"*, *"what breaks if I change this?"*, and *"which tests cover this route?"* in a **single tool call** instead of dozens of file reads.

Named after a puppy: small, eager, and a little smarter every day.

> Status: **0.2** — deep TypeScript analysis; a baseline call graph for Python (incl. FastAPI route→handler→test impact); framework-route detection across TypeScript, Python, Go, PHP, Java, and Rust; syntactic breadth for 13 more languages; an embeddable library API; 27 MCP tools; an `ama` CLI; and persistent, auto-syncing incremental indexing — all able to index Ama's own source cleanly as the built-in regression test.

## Get started

> Requires **Node.js 24+**.

```bash
npm install -g @mka-rainmaker/ama   # 1. install
ama install                          # 2. wire it into your agent (Claude Code / Cursor / Windsurf / Codex)
```

3. Point your agent at a repo and ask structural questions — *"who calls `createServer`?"*, *"what breaks if I change `AmaSession`?"* Your agent runs `index_repository` once, then queries the graph; Ama re-indexes automatically as you edit.

No global install? Use `npx -y @mka-rainmaker/ama mcp` as the command — see [Configure your coding agent](#configure-your-coding-agent).

## Why Ama

Most code-graph tools parse every language the same way: one fast, syntactic pass that sees *shapes* but not *meaning*. Ama takes a different bet — **use each language's real compiler when one exists.**

- **Deep tier — language-specific semantic analysis.** TypeScript via the TypeScript Compiler API today; .NET via Roslyn and Java via its native tooling next. This resolves types, overloads, generics, imports/re-exports, interface dispatch, and cross-file symbol binding that a purely syntactic parser cannot.
- **Baseline tier — universal syntactic analysis for breadth.** Every other language gets parsed for structure (and, where it pays off, a heuristic call graph), so the whole repo is navigable from day one.

Every answer reports **which tier produced it**, so partial coverage never quietly masquerades as complete. And because it's built for agents:

- **100% local.** No external APIs, no API keys, no telemetry. Your code never leaves your machine.
- **Cheaper and faster.** Fewer tool calls and fewer tokens per question — one graph query replaces a pile of file reads.

## Benchmarks

On Ama's own repo (5 representative questions): **~99% fewer tokens and ~96% fewer tool calls** to *obtain* an answer than the grep-then-read an agent falls back to without a graph — one focused, structured result instead of pulling whole files into context. That headline is a **ceiling** (the baseline reads every grep-matching file in full); [`docs/benchmarks`](docs/benchmarks/README.md) has the methodology and honest caveats, and `node scripts/benchmark.mjs` reproduces it.

## How auto-sync works

Ama keeps the graph current while connected, so you never run a manual sync:

- A native **file watcher** debounces bursts of edits, then re-indexes each changed file **in place** (no full rebuild).
- On reconnect, Ama **reconciles** anything that changed while it was away (size/mtime + content-hash diff).
- `index_status()` reports what's indexed, per-language coverage + tier, and how many edits are pending.

## Framework-aware routes

Ama maps HTTP routes to their handlers across stacks, so *"who handles `POST /reports`?"* is one query:

- **TypeScript** — Express, NestJS, Fastify, Hapi, Koa, Hono, tRPC, GraphQL, plus filename routers (Next.js Pages & App, Nuxt, Astro, SvelteKit).
- **Python** — Flask, FastAPI, Django (`urls.py`); FastAPI `TestClient` calls link **test → route → handler**, so `impact_analysis` / `affected` reach route tests.
- **Go** (Gin/chi), **PHP** (Laravel), **Java** (Spring `@GetMapping`), **Rust** (actix attribute macros).

## Configure your coding agent

**Fastest — let Ama wire itself in:**

```bash
ama install        # detects Claude Code / Cursor / Windsurf / Codex and writes their MCP config
ama install --dry-run   # preview what it would change, writing nothing
ama uninstall      # remove it again
```

Or configure manually — every MCP client spawns the same stdio command (`ama mcp`), only the config location differs.

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

### Fewer tools, lower token cost

Ama exposes 27 tools by default. To trade that for a small high-signal set, set `AMA_MCP_TOOLS` on the server — `minimal` (just `explore` + indexing), or a comma-separated list of tool names (the indexing tools are always included):

```json
{ "mcpServers": { "ama": { "command": "ama", "args": ["mcp"], "env": { "AMA_MCP_TOOLS": "minimal" } } } }
```

## MCP tools

| Tool | What it does |
|---|---|
| `index_repository(path)` | Build the graph for a directory or project. Run first. |
| `index_status()` | What's indexed: node/edge counts, per-language coverage + tier, pending edits. |
| `search_symbol(query)` / `search_code(query)` | Find symbols by name (add `exact: true` for a precise dotted match), or search snippet text. |
| `find_callers` / `find_callees` | Who calls a function/method, and what it calls. |
| `find_referrers` / `find_imports` / `find_importers` | Where a symbol is used / what a file imports / who imports it. |
| `impact_analysis(symbol)` | Transitive blast radius for change/test selection. |
| `explore(question)` | Relevant symbols, a relationship map, and blast radius in one call. |
| `get_code_snippet(symbol)` / `file_skeleton(file)` | A symbol's source, or a file's symbol outline. |

…and more (overrides, interfaces, type users, routes → handlers, circular imports). Call `get_graph_schema()` for the full node/edge model, or `ama --help` for the CLI.

## CLI

The same package ships an `ama` CLI mirroring the query surface, for one-shot use and scripting (e.g. `git diff --name-only | ama affected`):

```bash
ama --help     # list commands
ama mcp        # run the MCP server over stdio (what coding agents spawn)
```

## Programmatic API

Embed Ama as a library — index a repo and query its graph from your own code (the same surface the MCP server and CLI use):

```ts
import { index } from "@mka-rainmaker/ama";

const ama = await index("/path/to/repo");
ama.searchSymbol("createServer"); // GraphNode[]
ama.findCallers("createServer"); // who calls it
ama.impactAnalysis("AmaSession"); // transitive blast radius
ama.close(); // release resources when done
```

`index(root)` returns a transport-free `AmaSession` (aliased `Ama`) with the full query surface; `open(root)` reuses a persisted index. See [`src/api.ts`](src/api.ts) for the exported types.

## How it works

```
 source files ──▶ analyzer (deep | baseline) ──▶ graph (nodes + edges) ──▶ store ──▶ query ──▶ MCP tools
```

- **Graph model** — language-agnostic `nodes` (File, Module, Class, Interface, Enum, Function, Method, Route, …) and `edges` (Defines, Calls, Inherits, Implements, UsesType, Imports, References, …). Each symbol gets a stable, location-independent id.
- **Analyzers** — pluggable per language, each declaring its tier (`deep` or `baseline`). The TypeScript deep analyzer is the reference implementation.
- **Store** — in-memory, or SQLite with full-text search (FTS5) for persistence.
- **Query service** — search, call-graph traversal, code snippets, and impact analysis.
- **MCP server** — exposes the query surface over stdio.

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
