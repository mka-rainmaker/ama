/**
 * Silence node's "SQLite is an experimental feature" notice — and *only* that one.
 *
 * Ama uses `node:sqlite` (DatabaseSync) as its persistent store backend by deliberate
 * choice, so the per-run `ExperimentalWarning` it prints to stderr is pure noise for our
 * users — it fires on every `ama` invocation and every MCP server start. We intercept
 * `process.emitWarning` and drop just this notice, leaving all other warnings (deprecations,
 * other experimental features) intact. This module is imported from `store/sqlite.ts`
 * *before* its `import "node:sqlite"`, so the filter is in place when the load-time warning
 * fires. (ama-hee)
 */

/** True for node:sqlite's experimental-feature notice; false for every other warning. */
export function isSqliteExperimentalWarning(type: unknown, message: unknown): boolean {
  return (
    type === "ExperimentalWarning" && typeof message === "string" && message.includes("SQLite")
  );
}

// Install once (ESM modules evaluate a single time per process). Wrap emitWarning so the
// node:sqlite notice is dropped and everything else passes through unchanged.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, arg1?: unknown, ...rest: unknown[]) => {
  const type = typeof arg1 === "string" ? arg1 : (arg1 as { type?: string } | undefined)?.type;
  const message =
    typeof warning === "string" ? warning : (warning as { message?: string } | undefined)?.message;
  if (isSqliteExperimentalWarning(type, message)) return;
  return (original as (...args: unknown[]) => void)(warning, arg1, ...rest);
}) as typeof process.emitWarning;
