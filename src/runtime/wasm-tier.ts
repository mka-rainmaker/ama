/**
 * Pin WASM to V8's baseline (Liftoff) compiler instead of the optimizing tier.
 *
 * Indexing loads the 11 bundled tree-sitter grammar WASM modules (the C++, Swift,
 * and Kotlin grammars are huge). V8 compiles their enormous generated parse
 * functions with its optimizing tier (turboshaft) on background threads, which
 * balloons native Zone/code memory to ~2.7GB and fatally OOMs the long-running
 * server ("Fatal process out of memory: Zone") — even though the JS heap stays
 * tiny, so it is invisible to --max-old-space-size. `--liftoff-only` caps the
 * whole-repo index at ~0.6GB, flat across re-indexes. (ama-rgx; see ama-5o1 for
 * the orthogonal parser/tree leak this is NOT.)
 *
 * The flag is honored only at V8 startup: `v8.setFlagsFromString` runs too late,
 * `--no-wasm-tier-up` is insufficient, and Node rejects the flag in NODE_OPTIONS.
 * So the only launcher-agnostic guarantee — covering `tsx watch`, plain `node`,
 * and the `.mcp.json` spawn alike — is to re-exec the process once with it.
 */
import { spawn } from "node:child_process";

/** The V8 startup flag that pins WASM to the baseline (Liftoff) compiler. */
const FLAG = "--liftoff-only";
/** Set on the re-execed child so the guard is idempotent even if a launcher
 *  reports `process.execArgv` without the flag (belt-and-suspenders with the
 *  execArgv check below). */
const REEXEC_ENV = "AMA_WASM_TIER_REEXEC";

export function ensureBaselineWasmTier(): boolean {
  // Already running with the flag (a prior re-exec, or a launcher that set it) —
  // nothing to do; the caller proceeds normally.
  if (process.env[REEXEC_ENV] === "1" || process.execArgv.includes(FLAG)) return false;

  // Re-exec this exact process with the flag prepended to the node options,
  // preserving the loader args (e.g. tsx's `--import`) and the script + argv.
  const child = spawn(process.execPath, [FLAG, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit", // share fds so HTTP logs and the stdio JSON-RPC channel pass through
    env: { ...process.env, [REEXEC_ENV]: "1" },
  });

  // Forward termination so a watcher (tsx) or Ctrl-C cleanly stops the child —
  // no orphaned server holding the port.
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);

  child.on("error", (err) => {
    console.error(`[ama] failed to re-exec with ${FLAG}: ${err.message}`);
    process.exit(1);
  });
  // Mirror the child's fate: its exit code, or a non-zero code if it died by signal.
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  return true; // the caller is now just a supervisor — it must not continue.
}
