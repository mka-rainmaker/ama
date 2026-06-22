import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntrypoint } from "../../src/runtime/entrypoint.js";

/**
 * `isEntrypoint` must survive a symlinked launcher — npm installs the `ama` bin as a
 * symlink, so `process.argv[1]` (the symlink) differs from `import.meta.url` (the real
 * file). A raw equality check there makes the installed CLI a silent no-op. (ama-8fa)
 */
describe("isEntrypoint — symlink-robust entry detection (ama-8fa)", () => {
  let dir: string;
  let real: string;
  let link: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-entry-"));
    real = path.join(dir, "real.js");
    link = path.join(dir, "link.js");
    fs.writeFileSync(real, "// entry\n");
    fs.symlinkSync(real, link); // the npm `.bin/ama -> dist/cli/index.js` shape
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is true when argv[1] is a symlink to the module (the installed-bin case)", () => {
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });

  it("is true for a direct (non-symlink) invocation", () => {
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it("is false for an unrelated launcher path, or none", () => {
    expect(isEntrypoint(pathToFileURL(real).href, path.join(dir, "other.js"))).toBe(false);
    expect(isEntrypoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
