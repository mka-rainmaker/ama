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

  it("ignores node_modules, dotfiles, and files over the size cap", async () => {
    watcher?.close();
    seen = [];
    watcher = new FileWatcher(dir, (rel) => seen.push(rel), { maxFileSizeBytes: 64 });
    watcher.start();
    await delay(100);

    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "dep.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, ".hidden.ts"), "export const y = 1;\n");
    fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(128)); // over the 64-byte cap
    fs.writeFileSync(path.join(dir, "real.ts"), "export const z = 1;\n"); // sentinel

    await until(() => seen.includes("real.ts"));
    expect(seen.some((r) => r.includes("node_modules"))).toBe(false);
    expect(seen.some((r) => r.includes(".hidden"))).toBe(false);
    expect(seen).not.toContain("big.ts");
  });
});
