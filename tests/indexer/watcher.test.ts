import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWatcher } from "../../src/indexer/watcher.js";

// fs.watch delivers events asynchronously and a touch laggily (FSEvents on
// macOS), so tests poll until an expected event arrives rather than asserting
// synchronously, and prove *absence* with a sentinel: an event created last
// that, once seen, means anything created earlier would already have arrived.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FileWatcher", () => {
  let dir: string;
  let watcher: FileWatcher | undefined;
  let seen: string[];

  const count = (rel: string) => seen.filter((r) => r === rel).length;
  const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (cond()) return;
      await delay(25);
    }
    throw new Error(`condition not met within ${ms}ms; saw ${JSON.stringify(seen)}`);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-watch-"));
    seen = [];
    watcher = new FileWatcher(dir, (rel) => seen.push(rel));
    watcher.start();
    await delay(100); // let the OS-level watch become active before mutating
  });

  afterEach(() => {
    watcher?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a created, modified, and then deleted source file", async () => {
    const file = path.join(dir, "foo.ts");

    fs.writeFileSync(file, "export const a = 1;\n");
    await until(() => count("foo.ts") >= 1);
    const created = count("foo.ts");

    await delay(100);
    fs.writeFileSync(file, "export const a = 2;\n");
    await until(() => count("foo.ts") > created);
    const modified = count("foo.ts");

    await delay(100);
    fs.rmSync(file);
    await until(() => count("foo.ts") > modified);
  });

  it("drives change events from an injected source, no real fs.watch", () => {
    let emit: ((rel: string) => void) | undefined;
    const events: string[] = [];
    const w = new FileWatcher(dir, (rel) => events.push(rel), {
      source: (_root, onEvent) => {
        emit = onEvent;
        return { close() {} };
      },
    });
    w.start();
    // The file must exist for the stat check, but the *event* is synthetic —
    // no OS latency, so the assertion is synchronous and flake-free.
    fs.writeFileSync(path.join(dir, "synthetic.ts"), "export const a = 1;\n");
    emit?.("synthetic.ts");
    w.close();
    expect(events).toEqual(["synthetic.ts"]);
  });

  it("ignores node_modules, dotfiles, and files over the size cap", () => {
    watcher?.close();
    seen = [];
    let emit: ((rel: string) => void) | undefined;
    watcher = new FileWatcher(dir, (rel) => seen.push(rel), {
      maxFileSizeBytes: 64,
      source: (_root, onEvent) => {
        emit = onEvent;
        return { close() {} };
      },
    });
    watcher.start();

    // Ignored paths are filtered by name before any stat; the size cap needs a
    // real file to stat. Events are fired synchronously — no OS latency.
    fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(128)); // over the 64-byte cap
    fs.writeFileSync(path.join(dir, "real.ts"), "export const z = 1;\n");
    emit?.("node_modules/dep.ts");
    emit?.(".hidden.ts");
    emit?.("big.ts");
    emit?.("real.ts");

    expect(seen).toEqual(["real.ts"]);
  });
});
