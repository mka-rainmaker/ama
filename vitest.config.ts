import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Fixtures are analyzer input, not tests — never run them (some are named
    // `*.test.ts` deliberately, e.g. to exercise test-file detection).
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    environment: "node",
    // Workers index the whole repo in-process (self-index + CLI tests), compiling
    // the tree-sitter grammar WASM. Pin them to V8's baseline compiler so a worker
    // can't balloon to ~2.7GB and OOM the run (ama-xs8/ama-rgx). The flag is only
    // valid on a child process, so force the forks pool: worker_threads rejects it.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--liftoff-only"],
      },
    },
  },
});
