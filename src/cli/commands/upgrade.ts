import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serverStamp } from "../../mcp/build-info.js";
import type { CliCommand } from "../index.js";

const REPO = "mka-rainmaker/ama";
const PKG = "@mka-rainmaker/ama";

/** How the running `ama` was installed — determines how (and whether) we can self-update. */
export type InstallMethod = "bundle" | "npm" | "npx" | "source" | "unknown";

/**
 * Classify the install from the running CLI module's directory. `exists` probes for the bundle's
 * vendored node (injectable for tests). Order matters: an npx run lives under `node_modules` too,
 * so it's checked first; a bundle's `dist` lives under `lib/`, never under `node_modules`.
 */
export function detectInstall(
  moduleDir: string,
  exists: (p: string) => boolean = existsSync,
): InstallMethod {
  const norm = moduleDir.replace(/\\/g, "/"); // normalize Windows backslashes on any host (1:1 → indices align)
  if (norm.includes("/_npx/")) return "npx";
  if (norm.includes("/node_modules/")) return "npm";
  if (norm.includes("/src/cli")) return "source";
  const i = norm.indexOf("/lib/dist/");
  if (i !== -1) {
    const root = moduleDir.slice(0, i); // single-char sep replace preserves indices
    if (exists(path.join(root, "node", "node")) || exists(path.join(root, "node", "node.exe"))) {
      return "bundle";
    }
  }
  return "unknown";
}

/** The action to take for a given install method — either a command to run or a message to print. */
export type UpgradePlan =
  | { kind: "run"; command: string; args: string[]; note: string }
  | { kind: "message"; text: string };

/** Decide how to update `version` ("latest" or a pinned tag) for the detected method. Pure. */
export function upgradePlan(
  method: InstallMethod,
  version: string,
  opts: { isWindows?: boolean } = {},
): UpgradePlan {
  switch (method) {
    case "npm":
      return {
        kind: "run",
        command: "npm",
        args: ["install", "-g", `${PKG}@${version}`],
        note: `npm global install of ${PKG}@${version}`,
      };
    case "bundle": {
      const url = `https://raw.githubusercontent.com/${REPO}/main/install.${opts.isWindows ? "ps1" : "sh"}`;
      const cmd = opts.isWindows ? `irm ${url} | iex` : `curl -fsSL ${url} | sh`;
      const pin =
        version === "latest"
          ? ""
          : opts.isWindows
            ? `$env:AMA_VERSION="${version}"; `
            : `AMA_VERSION=${version} `;
      return { kind: "message", text: `Re-run the installer to update in place:\n  ${pin}${cmd}` };
    }
    case "npx":
      return {
        kind: "message",
        text: `npx runs the latest published version each time — nothing to upgrade. Pin a run with: npx ${PKG}@${version}`,
      };
    case "source":
      return {
        kind: "message",
        text: "Running from a source checkout — update with git (e.g. `git pull`).",
      };
    default:
      return {
        kind: "message",
        text: `Couldn't determine how ama was installed. Reinstall with \`npm i -g ${PKG}\` or the bundle installer (see the README).`,
      };
  }
}

/** Numeric semver "greater than" — `a` newer than `b`. Ignores any leading `v` (strip before call). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Latest released version (tag without the leading `v`), or null if unreachable / none yet. */
async function latestRelease(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "ama-cli", accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ? data.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

export const upgradeCommand: CliCommand = {
  name: "upgrade",
  summary: "Update ama in place (auto-detects how it was installed); --check to see the latest",
  usage: "ama upgrade [<version>] [--check] [--dry-run]",
  async run(args, ctx) {
    const check = args.includes("--check");
    const dryRun = args.includes("--dry-run");
    const version = args.find((a) => !a.startsWith("-")) ?? "latest";
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const method = detectInstall(moduleDir);
    const current = serverStamp.version;
    ctx.write(`ama ${current} — installed via: ${method}`);

    if (check) {
      const latest = await latestRelease();
      if (!latest) {
        ctx.write("Couldn't reach the release feed (or no releases are published yet).");
        return 0;
      }
      ctx.write(
        isNewer(latest, current)
          ? `Update available: ${latest} (run \`ama upgrade\`).`
          : `Up to date — ${latest} is the latest release.`,
      );
      return 0;
    }

    const plan = upgradePlan(method, version, { isWindows: process.platform === "win32" });
    if (plan.kind === "message") {
      ctx.write(plan.text);
      return 0;
    }
    ctx.write(`${dryRun ? "would run" : "running"}: ${plan.command} ${plan.args.join(" ")}`);
    if (dryRun) return 0;
    try {
      // shell:true so `npm` resolves to npm.cmd on Windows; args are fixed literals (no injection).
      execFileSync(plan.command, plan.args, { stdio: "inherit", shell: true });
      return 0;
    } catch (err) {
      ctx.error?.(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  },
};
