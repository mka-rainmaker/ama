import { expect, it } from "vitest";

/**
 * The vitest workers index the whole repo in-process — self-index.test.ts, and
 * the CLI tests that call run() directly — which compiles the 11 tree-sitter
 * grammar WASM modules. On V8's optimizing tier that peaks ~2.7GB per worker and,
 * with several workers running in parallel, can OOM the whole run. The forks pool
 * must launch each worker with --liftoff-only so in-worker indexing stays on the
 * baseline tier (~0.6GB), the same invariant the server and CLI enforce by
 * re-exec. Asserting it from inside a worker is the regression guard: remove the
 * pool config and this fails. (ama-xs8; see ama-rgx for the root cause.)
 */
it("runs vitest workers on the WASM baseline tier (--liftoff-only)", () => {
  expect(process.execArgv).toContain("--liftoff-only");
});
