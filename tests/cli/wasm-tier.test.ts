import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const cliEntry = path.join(repoRoot, "src/cli/index.ts");

let tmpDir: string | undefined;
afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * `ama index` compiles the 11 tree-sitter grammar WASM modules. Without the entry
 * guard it indexes in-process on V8's optimizing tier and the entry balloons past
 * 2.5GB (and can OOM); with the guard it re-execs into a --liftoff-only child, so
 * the entry delegates the heavy work and never optimizing-tier-compiles in-process.
 * macOS-only: `/usr/bin/time -l` reports peak RSS ("maximum resident set size", in
 * bytes) of its direct child — the entry process. DB redirected via AMA_DB so the
 * test never touches the real index. (ama-xs8; root cause ama-rgx.)
 */
it.skipIf(process.platform !== "darwin")(
  "the CLI entry doesn't optimizing-tier-compile grammar WASM in-process",
  () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-wasm-"));
    const res = spawnSync(
      "/usr/bin/time",
      ["-l", process.execPath, "--import", "tsx", cliEntry, "index", repoRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, AMA_DB: path.join(tmpDir, "index.db") },
        timeout: 180_000,
      },
    );

    expect(res.status, `ama index failed:\n${res.stdout}\n${res.stderr}`).toBe(0);

    const match = res.stderr.match(/(\d+)\s+maximum resident set size/);
    expect(match, `no peak-RSS line from /usr/bin/time:\n${res.stderr}`).not.toBeNull();

    const peakMb = Number(match?.[1] ?? Number.NaN) / 1048576;
    expect(
      peakMb,
      `CLI entry peaked at ${Math.round(peakMb)}MB — the WASM baseline-tier guard isn't active`,
    ).toBeLessThan(1500);
  },
  180_000,
);
