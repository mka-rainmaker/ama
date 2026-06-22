// Build a self-contained, no-Node-required bundle (ama-py1r).
//
// Vendors a Node runtime next to the app so users need no Node installed. The bundle is:
//   node/   the vendored Node runtime
//   lib/    dist/ + prod node_modules — all pure JS/wasm (zero native addons: node:sqlite is
//           built into Node, tree-sitter is wasm), so it's portable file-copying, not compilation
//   bin/    a launcher that runs the vendored node with the CLI entry
//
// Usage: node scripts/build-bundle.mjs [target]
//   target defaults to the host (`<platform>-<arch>`). The official Node for the target is
//   downloaded and checksum-verified, so any of the six targets builds on any OS. Env knobs:
//     AMA_BUNDLE_HOST_NODE=1  copy the running node instead of downloading (host target only, fast dev)
//     AMA_NODE_VERSION=x.y.z  override the pinned Node version
//
// Verify (the whole point): with system Node OFF your PATH, `bundle/<target>/bin/ama --version`
// still works, because the launcher runs the vendored node by relative path.
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeArchiveInfo, parseShasum } from "./lib/node-dist.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = `${process.platform}-${process.arch}`;
const target = process.argv[2] ?? host;
const isWin = target.startsWith("win32");
const NODE_VERSION = process.env.AMA_NODE_VERSION ?? "24.12.0";
const out = path.join(repo, "bundle", target);
const lib = path.join(out, "lib");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
// npm is npm.cmd on Windows; Node won't spawn a .cmd without a shell. tar/unzip are real exes, so
// they stay on `run` (no shell). Args here are fixed literals → shell:true carries no injection risk.
const npm = (args, cwd) => execFileSync("npm", args, { cwd, stdio: "inherit", shell: true });

console.log(`[bundle] target ${target}`);
npm(["run", "build"], repo); // 1. compile dist/

// 2. stage lib/ = dist + manifests, then a prod-only install (pure JS/wasm deps)
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(lib, { recursive: true });
fs.cpSync(path.join(repo, "dist"), path.join(lib, "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(repo, f), path.join(lib, f));
}
npm(["ci", "--omit=dev", "--ignore-scripts"], lib);

// 3. vendor the Node runtime (official download + checksum, or opt-in host copy)
await vendorNode(target, path.join(out, "node"));

// 4. launcher → vendored node + the CLI entry (resolves its own dir, so PATH/symlink-safe)
const binDir = path.join(out, "bin");
fs.mkdirSync(binDir, { recursive: true });
if (isWin) {
  fs.writeFileSync(
    path.join(binDir, "ama.cmd"),
    '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\dist\\cli\\index.js" %*\r\n',
  );
} else {
  const launcher = path.join(binDir, "ama");
  fs.writeFileSync(
    launcher,
    '#!/bin/sh\nhere=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$here/../node/node" "$here/../lib/dist/cli/index.js" "$@"\n',
  );
  fs.chmodSync(launcher, 0o755);
}

console.log(`[bundle] ready: ${out}`);
console.log(
  `[bundle] verify (no system node needed): ${path.join(binDir, isWin ? "ama.cmd" : "ama")} --version`,
);

/** Put the target's Node runtime in `nodeDir` — official download (checksum-verified) by default. */
async function vendorNode(t, nodeDir) {
  fs.mkdirSync(nodeDir, { recursive: true });
  const winTarget = t.startsWith("win32");
  const dest = path.join(nodeDir, winTarget ? "node.exe" : "node");

  if (t === host && process.env.AMA_BUNDLE_HOST_NODE) {
    fs.copyFileSync(process.execPath, dest); // fast dev: the running node IS this host's official build
    if (!winTarget) fs.chmodSync(dest, 0o755);
    console.log(`[bundle] vendored host node (${process.version})`);
    return;
  }

  const info = nodeArchiveInfo(t, NODE_VERSION);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ama-node-"));
  try {
    console.log(`[bundle] downloading ${info.url}`);
    const bytes = Buffer.from(await (await fetchOk(info.url)).arrayBuffer());
    const want = parseShasum(await (await fetchOk(info.shasumsUrl)).text(), info.archive);
    const got = crypto.createHash("sha256").update(bytes).digest("hex");
    if (got !== want) {
      throw new Error(`checksum mismatch for ${info.archive}:\n  got  ${got}\n  want ${want}`);
    }
    console.log(`[bundle] checksum ok (${want.slice(0, 16)}…)`);
    const archivePath = path.join(tmp, info.archive);
    fs.writeFileSync(archivePath, bytes);
    if (winTarget) {
      // bsdtar (macOS + Windows runners) extracts .zip; GNU tar (Linux) can't, so fall back.
      try {
        run("tar", ["-xf", archivePath, "-C", tmp]);
      } catch {
        run("unzip", ["-q", archivePath, "-d", tmp]);
      }
    } else {
      run("tar", ["-xzf", archivePath, "-C", tmp]);
    }
    fs.copyFileSync(path.join(tmp, info.binPath), dest);
    if (!winTarget) fs.chmodSync(dest, 0o755);
    console.log(`[bundle] vendored Node v${NODE_VERSION} for ${t}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return res;
}
