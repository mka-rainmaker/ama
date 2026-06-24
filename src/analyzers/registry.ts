import type { Analyzer } from "./types.js";

/**
 * Selects an analyzer for a file by its extension. The indexer asks the registry
 * "who handles this file?" so adding a language is just registering an analyzer.
 */
export class AnalyzerRegistry {
  private readonly byExtension = new Map<string, Analyzer>();
  private readonly analyzers: Analyzer[] = [];

  register(analyzer: Analyzer): void {
    this.analyzers.push(analyzer);
    for (const ext of analyzer.extensions) {
      const key = ext.toLowerCase();
      const existing = this.byExtension.get(key);
      // Deep beats baseline for the same extension, regardless of registration order —
      // so a deep sidecar takes over a language the baseline also claims. Same tier keeps
      // the first registered. This is the "deep-if-available" routing rule; availability
      // is gated upstream by {@link registerIfAvailable}. (ama-3bb.4)
      if (!existing || (analyzer.tier === "deep" && existing.tier === "baseline")) {
        this.byExtension.set(key, analyzer);
      }
    }
  }

  /** Register an analyzer only if it reports itself available — for sidecars whose
   *  subprocess may be absent. Returns whether it was registered. An analyzer without
   *  an {@link Analyzer.isAvailable} probe (every in-process one) always registers. */
  async registerIfAvailable(analyzer: Analyzer): Promise<boolean> {
    const available = (await analyzer.isAvailable?.()) ?? true;
    if (available) this.register(analyzer);
    return available;
  }

  /** The analyzer for a file path, or undefined if no language handles it. Extension first (the
   *  fast, common path); then a filename-pattern fallback for analyzers like dotenv whose files
   *  (`.env.example`) aren't keyed by their trailing extension. (#53) */
  forFile(path: string): Analyzer | undefined {
    const dot = path.lastIndexOf(".");
    if (dot >= 0) {
      const byExt = this.byExtension.get(path.slice(dot).toLowerCase());
      if (byExt) return byExt;
    }
    return this.analyzers.find((a) => a.matchesFile?.(path));
  }

  /** All registered analyzers, in registration order. */
  all(): Analyzer[] {
    return this.analyzers.slice();
  }
}
