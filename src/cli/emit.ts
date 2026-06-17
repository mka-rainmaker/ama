import type { CliContext } from "./index.js";

/**
 * Route a diagnostic (usage, "no index", not-found) to stderr when an error sink
 * is present, else fall back to stdout. Lives in its own leaf module — the type
 * import of {@link CliContext} is erased, so command modules can import this
 * value without forming a runtime cycle with the command registry in `index.ts`.
 */
export function emitError(ctx: CliContext, line: string): void {
  (ctx.error ?? ctx.write)(line);
}
