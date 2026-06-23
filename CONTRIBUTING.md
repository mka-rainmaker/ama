# Contributing to Ama

Thanks for your interest! **[`AGENTS.md`](AGENTS.md) is the canonical contributor guide — read it
first.** This is the short version.

## Setup

Requires **Node.js 24+**.

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run typecheck
npm run lint       # biome
```

## Workflow

1. Pick or file an issue (the backlog is tracked with [beads](https://github.com/steveyegge/beads): `bd ready`).
2. Branch off `main` (`git switch -c feat/<topic>`).
3. Work **test-first** — a failing test, then the minimal code to pass.
4. Keep the suite green **and** ensure Ama still re-indexes its own source cleanly (the self-index
   test is the built-in regression gate).
5. `npm run lint` clean; use [Conventional Commits](https://www.conventionalcommits.org/).
6. Open a PR — CI (build, typecheck, test, lint) must pass before merge.

## Project shape

`graph/` (language-agnostic model) → `analyzers/` (per-language, each declaring a `deep`/`baseline`
tier) → `store/` → `query/` → `mcp/` + `cli/`. Keep the layering clean; see `AGENTS.md` for the
non-obvious rules (stdout is sacred in `src/mcp`, honest capability tiers, …).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
