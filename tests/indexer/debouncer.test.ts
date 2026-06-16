import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Debouncer } from "../../src/indexer/debouncer.js";

// Debounce timing is asserted with fake timers so the tests are deterministic
// (no real sleeps): advance the clock exactly and observe what flushed.
describe("Debouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst of edits into one sync per path", async () => {
    const calls: string[] = [];
    const d = new Debouncer((rel) => {
      calls.push(rel);
      return Promise.resolve();
    }, 100);

    d.notify("a.ts");
    d.notify("a.ts");
    d.notify("b.ts");
    d.notify("a.ts");
    expect(calls).toEqual([]); // nothing fires before the window elapses

    await vi.advanceTimersByTimeAsync(120);
    expect([...calls].sort()).toEqual(["a.ts", "b.ts"]); // each path synced once
  });

  it("re-arms the window on each new edit (trailing debounce)", async () => {
    const calls: string[] = [];
    const d = new Debouncer((rel) => {
      calls.push(rel);
      return Promise.resolve();
    }, 100);

    d.notify("a.ts");
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toEqual([]); // not yet
    d.notify("a.ts"); // resets the window
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toEqual([]); // only 60ms since the last edit
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toEqual(["a.ts"]); // window finally elapsed
  });

  it("batches edits that arrive while a flush is in progress", async () => {
    const calls: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const d = new Debouncer((rel) => {
      calls.push(rel);
      if (rel === "a.ts") {
        return new Promise<void>((res) => {
          resolveFirst = res;
        });
      }
      return Promise.resolve();
    }, 100);

    d.notify("a.ts");
    await vi.advanceTimersByTimeAsync(120); // flush starts; sync("a.ts") is pending
    expect(calls).toEqual(["a.ts"]);

    d.notify("b.ts"); // arrives mid-flush — must not be lost
    resolveFirst?.(); // let the first sync finish
    await vi.advanceTimersByTimeAsync(120); // the follow-up window elapses
    expect(calls).toEqual(["a.ts", "b.ts"]);
  });

  it("isolates a failing sync so other paths still flush", async () => {
    const calls: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = new Debouncer((rel) => {
      calls.push(rel);
      if (rel === "boom.ts") return Promise.reject(new Error("nope"));
      return Promise.resolve();
    }, 100);

    d.notify("boom.ts");
    d.notify("ok.ts");
    await vi.advanceTimersByTimeAsync(120);
    expect([...calls].sort()).toEqual(["boom.ts", "ok.ts"]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("boom.ts"), expect.any(Error));
    logged.mockRestore();
  });
});
