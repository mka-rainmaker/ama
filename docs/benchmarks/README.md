# Benchmarks

A **reproducible, deterministic** measure of Ama's *retrieval efficiency*: how many tool
calls and tokens it takes to **obtain** the answer to a code question — one Ama MCP call
versus the grep-then-read an agent falls back to without a code graph.

Run it yourself (no LLM, no API key):

```bash
node scripts/benchmark.mjs [repoPath]   # defaults to this repo
```

## Results — Ama's own repo (~317 files)

| Question | Ama (calls / tokens) | Baseline (calls / tokens) | Fewer tokens |
|---|---|---|---|
| who calls `symbolId`? | 1 / 6,177 | 66 / 298,920 | 98% |
| who calls `fileId`? | 1 / 930 | 24 / 295,439 | ~100% |
| what breaks if `AmaSession` changes? | 1 / 1,082 | 21 / 270,948 | ~100% |
| show `createServer`'s source | 1 / 4,679 | 10 / 264,251 | 98% |
| who calls `walkSymbols`? | 1 / 344 | 8 / 254,489 | ~100% |
| **Total** | **5 / 13,212** | **129 / 1,384,047** | **99%** |

**→ ~99% fewer tokens and ~96% fewer tool calls** to retrieve these answers.

## Methodology

- **With Ama:** one MCP tool call (`find_callers` / `impact_analysis` / `get_code_snippet`).
  Cost = the result's size in tokens.
- **Baseline (no graph):** an agent greps for the symbol (1 call), then reads each matching
  file **in full** (N calls) to find and confirm the answer. Cost = those files' tokens.
- Tokens ≈ bytes ÷ 4 (the usual rough rule). File set = `git grep -lI`.

## What this does and doesn't measure

- ✅ **Retrieval cost** — tool calls + tokens to *get* the answer. This is the mechanism behind
  the savings: one focused, structured result instead of pulling whole files into context.
- ⚠️ **The baseline is an upper bound.** It reads *every* grep-matching file in full — a
  thorough agent confirming each reference. A leaner agent reads fewer files, so real-world
  savings are **lower than the headline**; treat 99% as the ceiling, not a promise.
- ❌ **Not a full agent-loop benchmark.** It excludes the LLM's reasoning tokens and multi-turn
  overhead. Some code-graph tools publish whole-agent "% cheaper" figures; a comparable number
  for Ama would need an LLM harness (future work).
- The deeper win is **qualitative**: Ama returns the *precise, structured* answer — real
  callers, transitive blast radius, exact snippet — with no grep false positives and no
  call-vs-mention guesswork, which grep can't give at any token budget.
