/** Runs a sync for one changed path. */
export type SyncFn = (rel: string) => Promise<void>;

/**
 * Collapses bursts of file-change events into batched syncs. Each `notify(rel)`
 * adds the path to a pending set and (re)arms a trailing timer; when the window
 * elapses quietly, every pending path is synced once. A single flush runs at a
 * time — paths that arrive while one is in progress are batched into the next —
 * and a failing sync is isolated so the rest of the batch still runs.
 *
 * The debounce window collapses the several `fs.watch` events a single save can
 * emit into one re-index. Drives ama-gd5.3's auto-sync; reusable anywhere a
 * stream of keyed events should settle before acting.
 */
export class Debouncer {
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;

  constructor(
    private readonly sync: SyncFn,
    private readonly windowMs: number,
  ) {}

  /** Record a changed path and (re)start the trailing window. */
  notify(rel: string): void {
    this.pending.add(rel);
    this.arm();
  }

  /** Pending paths not yet synced — for surfacing sync status (ama-gd5.6). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel the pending window. Does not flush — stopping accepts staleness. */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.windowMs);
  }

  private async flush(): Promise<void> {
    // A flush is already running; let it pick up what arrived, or re-arm so the
    // next window drains anything it could not.
    if (this.flushing) {
      if (this.pending.size > 0) this.arm();
      return;
    }
    if (this.pending.size === 0) return;
    this.flushing = true;
    const batch = [...this.pending];
    this.pending.clear();
    try {
      for (const rel of batch) {
        try {
          await this.sync(rel);
        } catch (err) {
          console.error(`[ama] auto-sync failed for ${rel}:`, err);
        }
      }
    } finally {
      this.flushing = false;
      // Edits that landed during the flush get their own window.
      if (this.pending.size > 0) this.arm();
    }
  }
}
