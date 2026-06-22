// Build a self-contained, no-Node-required bundle (ama-py1r).
//
// Vendors a Node runtime next to the app so users need no Node installed. The bundle is:
//   node/   the vendored Node runtime
//   lib/    dist/ + prod node_modules — all pure JS/wasm (zero native addons: node:sqlite is
//           built into Node, tree-sitter is wasm), so it's portable file-copying, not compilation
//   bin/    a launcher that runs the vendored node with the CLI entry
//
// Usage: node scripts/build-bundle.mjs [target]
//   target defaults to the host (`<platform>-<arch>`). Host target copies the running node;
//   cross-target bundles must download the official Node for that target — not wired yet (slice 2).
//
// Verify (the whole point): with system Node OFF your PATH, `bundle/<target>/bin/ama --version`
// still works, because the launcher runs the vendored node by relative path.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = `${process.platform}-${process.arch}`;
const target = process.argv[2] ?? host;
const isWin = target.startsWith("win32");
const out = path.join(repo, "bundle", target);
const lib = path.join(out, "lib");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

console.log(`[bundle] target ${target}`);
run("npm", ["run", "build"], repo); // 1. compile dist/

// 2. stage lib/ = dist + manifests, then a prod-only install (pure JS/wasm deps)
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(lib, { recursive: true });
fs.cpSync(path.join(repo, "dist"), path.join(lib, "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(repo, f), path.join(lib, f));
}
run("npm", ["ci", "--omit=dev", "--ignore-scripts"], lib);

// 3. vendor the Node runtime
const nodeDir = path.join(out, "node");
fs.mkdirSync(nodeDir, { recursive: true });
const nodeBin = path.join(nodeDir, isWin ? "node.exe" : "node");
if (target === host) {
  fs.copyFileSync(process.execPath, nodeBin); // the running node IS the official Node for this host
  if (!isWin) fs.chmodSync(nodeBin, 0o755);
} else {
  throw new Error(
    `cross-target bundling (${target}) must download the official Node — not wired yet (slice 2)`,
  );
}

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
