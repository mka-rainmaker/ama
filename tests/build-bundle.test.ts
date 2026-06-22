import { describe, expect, it } from "vitest";
// Build-tooling logic (ama-py1r slice 2). Pure functions that map a bundle target to the official
// Node download + verify its checksum — the error-prone naming is worth testing in isolation.
import { nodeArchiveInfo, parseShasum } from "../scripts/lib/node-dist.mjs";

describe("nodeArchiveInfo (ama-py1r slice 2)", () => {
  const V = "24.12.0";

  it("maps darwin-arm64 to a .tar.gz whose node lives at bin/node", () => {
    const i = nodeArchiveInfo("darwin-arm64", V);
    expect(i.archive).toBe("node-v24.12.0-darwin-arm64.tar.gz");
    expect(i.url).toBe("https://nodejs.org/dist/v24.12.0/node-v24.12.0-darwin-arm64.tar.gz");
    expect(i.binPath).toBe("node-v24.12.0-darwin-arm64/bin/node");
    expect(i.binName).toBe("node");
    expect(i.shasumsUrl).toBe("https://nodejs.org/dist/v24.12.0/SHASUMS256.txt");
  });

  it("maps win32-x64 to a .zip with node.exe (platform token becomes 'win')", () => {
    const i = nodeArchiveInfo("win32-x64", V);
    expect(i.archive).toBe("node-v24.12.0-win-x64.zip");
    expect(i.binPath).toBe("node-v24.12.0-win-x64/node.exe");
    expect(i.binName).toBe("node.exe");
  });

  it("maps linux-arm64 to a linux .tar.gz", () => {
    const i = nodeArchiveInfo("linux-arm64", V);
    expect(i.archive).toBe("node-v24.12.0-linux-arm64.tar.gz");
    expect(i.binPath).toBe("node-v24.12.0-linux-arm64/bin/node");
  });

  it("rejects unsupported platforms/arches rather than build a bad URL", () => {
    expect(() => nodeArchiveInfo("freebsd-x64", V)).toThrow();
    expect(() => nodeArchiveInfo("linux-mips", V)).toThrow();
  });
});

describe("parseShasum", () => {
  const sums = [
    "aaaa1111  node-v24.12.0-darwin-arm64.tar.gz",
    "bbbb2222  node-v24.12.0-linux-x64.tar.gz",
  ].join("\n");

  it("returns the hash for the matching archive", () => {
    expect(parseShasum(sums, "node-v24.12.0-linux-x64.tar.gz")).toBe("bbbb2222");
  });

  it("throws when the archive is absent (never ship an unverified binary)", () => {
    expect(() => parseShasum(sums, "node-v24.12.0-win-x64.zip")).toThrow();
  });
});
