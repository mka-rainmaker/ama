// Retrieval-efficiency benchmark (ama-foz): for a set of real code questions, compare the
// cost of OBTAINING the answer with Ama (one MCP tool call + its result) vs. the naive
// no-graph baseline an agent falls back to (grep for the symbol, then read every matching
// file). It measures tool-calls and tokens spent on RETRIEVAL — a proxy for the savings, not
// a full agent-loop cost (which would need an LLM harness). Deterministic + reproducible.
//
// Usage: node scripts/benchmark.mjs [repoPath]   (defaults to this repo)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const amaDir = path.resolve(here, "..");
const repo = path.resolve(process.argv[2] ?? amaDir);
const TOK = (bytes) => Math.round(bytes / 4); // ~4 chars/token, the usual rough rule

// Each question: an Ama tool call, and the symbol an agent would grep for without a graph.
const QUESTIONS = [
  {
    q: "who calls symbolId?",
    tool: "find_callers",
    args: { symbol: "symbolId" },
    grep: "symbolId",
  },
  { q: "who calls fileId?", tool: "find_callers", args: { symbol: "fileId" }, grep: "fileId" },
  {
    q: "what breaks if AmaSession changes?",
    tool: "impact_analysis",
    args: { symbol: "AmaSession" },
    grep: "AmaSession",
  },
  {
    q: "show createServer's source",
    tool: "get_code_snippet",
    args: { symbol: "createServer" },
    grep: "createServer",
  },
  {
    q: "who calls walkSymbols?",
    tool: "find_callers",
    args: { symbol: "walkSymbols" },
    grep: "walkSymbols",
  },
];

/** Baseline: an agent without a graph greps for the symbol (1 call) then reads each matching
 *  file in full (N calls) to find/confirm the answer. */
function baseline(symbol) {
  let files = [];
  try {
    files = execFileSync("git", ["grep", "-lI", "-e", symbol], { cwd: repo, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    files = []; // no matches (git grep exits non-zero)
  }
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(repo, f)).size;
    } catch {}
  }
  return { calls: 1 + files.length, tokens: TOK(bytes) };
}

const client = new Client({ name: "ama-benchmark", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: path.join(amaDir, "node_modules/.bin/tsx"),
    args: ["src/cli/index.ts", "mcp"],
    cwd: amaDir,
    env: { ...process.env, AMA_WASM_TIER_REEXEC: "1" },
  }),
);
await client.callTool({ name: "index_repository", arguments: { path: repo } }, undefined, {
  timeout: 540000,
});

const rows = [];
let amaCalls = 0;
let amaTokens = 0;
let baseCalls = 0;
let baseTokens = 0;
for (const { q, tool, args, grep } of QUESTIONS) {
  const res = await client.callTool({ name: tool, arguments: args });
  const amaTok = TOK((res.content ?? []).reduce((s, b) => s + (b.text?.length ?? 0), 0));
  const base = baseline(grep);
  rows.push({ q, amaCalls: 1, amaTok, baseCalls: base.calls, baseTok: base.tokens });
  amaCalls += 1;
  amaTokens += amaTok;
  baseCalls += base.calls;
  baseTokens += base.tokens;
}
await client.close();

const pct = (a, b) => (b > 0 ? Math.round((1 - a / b) * 100) : 0);
console.log(`Repo: ${repo}\n`);
console.log(
  "question                                  ama(calls/tok)  baseline(calls/tok)  fewer-tok",
);
for (const r of rows) {
  console.log(
    `${r.q.padEnd(42)} ${`1 / ${r.amaTok}`.padEnd(15)} ${`${r.baseCalls} / ${r.baseTok}`.padEnd(20)} ${pct(r.amaTok, r.baseTok)}%`,
  );
}
console.log(
  `\nTOTAL: ${amaCalls} calls / ${amaTokens} tok (Ama)  vs  ${baseCalls} calls / ${baseTokens} tok (baseline)`,
);
console.log(
  `=> ${pct(amaTokens, baseTokens)}% fewer tokens, ${pct(amaCalls, baseCalls)}% fewer tool calls`,
);
