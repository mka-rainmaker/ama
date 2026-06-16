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
      this.byExtension.set(ext.toLowerCase(), analyzer);
    }
  }

  /** The analyzer for a file path, or undefined if no language handles it. */
  forFile(path: string): Analyzer | undefined {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return undefined;
    return this.byExtension.get(path.slice(dot).toLowerCase());
  }

  /** All registered analyzers, in registration order. */
  all(): Analyzer[] {
    return this.analyzers.slice();
  }
}
