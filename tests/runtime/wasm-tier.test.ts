import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const guardModule = path.join(repoRoot, "src/runtime/wasm-tier.ts");
const indexerModule = path.join(repoRoot, "src/indexer/indexer.ts");

/**
 * A standalone entry that calls the guard, then indexes the whole repo three
 * times — the exact workload that fatally OOMs when V8 compiles the tree-sitter
 * grammar WASM with its optimizing tier (ama-rgx). It is written to a temp file
 * OUTSIDE the repo so it is not itself indexed, and spawned WITHOUT the V8 flag:
 * the guard must supply it by re-exec, or the child balloons past the bound (and
 * usually OOM-crashes). The whole-repo index is the project's own regression
 * fixture — it exercises all 11 grammars.
 */
const entrySource = `
import { ensureBaselineWasmTier } from ${JSON.stringify(guardModule)};
if (ensureBaselineWasmTier()) {
  // Re-execed into a --liftoff-only child; this process is just the supervisor.
} else {
  const { createDefaultIndexer } = await import(${JSON.stringify(indexerModule)});
  const indexer = createDefaultIndexer();
  let peak = 0;
  for (let i = 0; i < 3; i++) {
    const { store } = await indexer.index(${JSON.stringify(repoRoot)});
    store.close();
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  console.log("ROUNDS=3 RSS_MB=" + Math.round(peak / 1048576));
}
`;

let tmpDir: string | undefined;
afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("indexing the whole repo stays under a peak-RSS bound (grammar WASM on the baseline tier)", () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-wasm-tier-"));
  const entryFile = path.join(tmpDir, "entry.mts");
  fs.writeFileSync(entryFile, entrySource);

  const res = spawnSync(process.execPath, ["--import", "tsx", entryFile], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });

  expect(res.status, `child did not exit cleanly:\n${res.stdout}\n${res.stderr}`).toBe(0);

  const match = res.stdout.match(/ROUNDS=3 RSS_MB=(\d+)/);
  expect(match, `missing completion marker; child stdout:\n${res.stdout}`).not.toBeNull();

  const rssMb = Number(match?.[1] ?? Number.NaN);
  // With --liftoff-only the whole-repo index peaks near ~0.6GB; the optimizing
  // tier balloons it past 2.5GB (and usually OOM-crashes). 1500MB sits squarely
  // in the ~1.8GB gap between the two regimes.
  expect(rssMb, `peak RSS ${rssMb}MB exceeds bound — WASM tier guard not active`).toBeLessThan(
    1500,
  );
}, 120_000);
