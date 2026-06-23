import { describe, expect, it } from "vitest";
import { detectInstall, isNewer, upgradePlan } from "../../src/cli/commands/upgrade.js";

describe("detectInstall (ama-h522)", () => {
  const noVendoredNode = () => false;

  it("recognizes an npm global install", () => {
    const dir = "/usr/local/lib/node_modules/@mka-rainmaker/ama/dist/cli/commands";
    expect(detectInstall(dir, noVendoredNode)).toBe("npm");
  });

  it("recognizes an npx cache run (checked before npm — it's also under node_modules)", () => {
    const dir = "/Users/x/.npm/_npx/abc123/node_modules/@mka-rainmaker/ama/dist/cli/commands";
    expect(detectInstall(dir, noVendoredNode)).toBe("npx");
  });

  it("recognizes a source checkout (tsx)", () => {
    expect(detectInstall("/Users/x/code/ama/src/cli/commands", noVendoredNode)).toBe("source");
  });

  it("recognizes a self-contained bundle by its vendored node", () => {
    const dir = "/Users/x/.ama/darwin-arm64/lib/dist/cli/commands";
    const exists = (p: string) => p === "/Users/x/.ama/darwin-arm64/node/node";
    expect(detectInstall(dir, exists)).toBe("bundle");
  });

  it("recognizes a Windows bundle (backslashes, node.exe)", () => {
    const dir = "C:\\Users\\x\\AppData\\Local\\ama\\win32-x64\\lib\\dist\\cli\\commands";
    const exists = (p: string) => p.replace(/\\/g, "/").endsWith("win32-x64/node/node.exe");
    expect(detectInstall(dir, exists)).toBe("bundle");
  });

  it("a lib/dist path with no vendored node is not a bundle", () => {
    expect(detectInstall("/opt/thing/lib/dist/cli/commands", noVendoredNode)).toBe("unknown");
  });
});

describe("upgradePlan (ama-h522)", () => {
  it("npm → run `npm install -g` at the requested version", () => {
    expect(upgradePlan("npm", "latest")).toEqual({
      kind: "run",
      command: "npm",
      args: ["install", "-g", "@mka-rainmaker/ama@latest"],
      note: expect.any(String),
    });
    expect(
      upgradePlan("npm", "0.3.0").kind === "run" && upgradePlan("npm", "0.3.0").args,
    ).toContain("@mka-rainmaker/ama@0.3.0");
  });

  it("bundle (unix) → message with the install.sh one-liner", () => {
    const p = upgradePlan("bundle", "latest", { isWindows: false });
    expect(p.kind).toBe("message");
    expect(p.kind === "message" && p.text).toContain("install.sh");
    expect(p.kind === "message" && p.text).toContain("curl");
  });

  it("bundle (unix, pinned) → carries AMA_VERSION", () => {
    const p = upgradePlan("bundle", "0.3.0", { isWindows: false });
    expect(p.kind === "message" && p.text).toContain("AMA_VERSION=0.3.0");
  });

  it("bundle (windows) → install.ps1 one-liner", () => {
    const p = upgradePlan("bundle", "latest", { isWindows: true });
    expect(p.kind === "message" && p.text).toContain("install.ps1");
    expect(p.kind === "message" && p.text).toContain("irm");
  });

  it("npx → message (nothing to upgrade)", () => {
    expect(upgradePlan("npx", "latest").kind).toBe("message");
  });

  it("source → message about git", () => {
    const p = upgradePlan("source", "latest");
    expect(p.kind === "message" && p.text.toLowerCase()).toContain("git");
  });
});

describe("isNewer (ama-h522)", () => {
  it("compares semver numerically", () => {
    expect(isNewer("0.2.1", "0.2.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0", "0.3.0")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });
});
