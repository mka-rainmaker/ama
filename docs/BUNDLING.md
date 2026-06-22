# Self-contained bundles (no Node required)

Ama can ship as a **self-contained bundle** that carries its own Node runtime, so users don't need
Node installed. This works because Ama has **zero native addons**:

- `node:sqlite` is built into Node 24 (no `better-sqlite3`-style native build),
- tree-sitter grammars are `.wasm` (architecture-independent),
- everything else (`typescript`, `@modelcontextprotocol/sdk`, `web-tree-sitter`, `zod`) is pure JS.

So a bundle is just **file-copying**, not cross-compilation — a `linux-arm64` bundle can be
assembled on a Mac, because nothing links against the target's C toolchain.

## Layout

```
bundle/<target>/
  node/                vendored Node runtime (node or node.exe)
  lib/
    dist/              compiled app
    node_modules/      prod dependencies only (pure JS/wasm)
    package.json
  bin/
    ama (or ama.cmd)   launcher → runs ./node with ./lib/dist/cli/index.js
```

The launcher resolves its own directory and execs the vendored node by **relative path**, so the
bundle runs no matter where it's unpacked and never touches a system `node`.

## Build

```bash
npm run bundle            # host platform (<platform>-<arch>)
npm run bundle linux-x64  # a specific target  (cross-target = slice 2, see below)
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`.

## Verify (the whole point)

With system Node **off** your PATH, the bundle still works:

```bash
PATH=/usr/bin:/bin bundle/<target>/bin/ama --version
```

End-to-end, a bundled `ama mcp` indexes and serves a repo with no system node anywhere — wasm
parsing and `node:sqlite` run entirely on the vendored runtime.

## Status & roadmap (ama-py1r)

- **Slice 1 (done):** the `build-bundle` script + launcher, proven on the host target (copies the
  running node, since the running Node *is* the official build for this platform).
- **Slice 2 — cross-target Node download:** fetch the official Node tarball/zip for any target
  (`https://nodejs.org/dist/v<ver>/...`) instead of copying the host's, so all six targets build on
  any OS.
- **Slice 3 — release pipeline:** a GitHub Actions workflow that builds all six bundles and attaches
  them to a GitHub Release.
- **Slice 4 — installers:** `curl … | sh` (macOS/Linux) and PowerShell (Windows) one-liners.
- **Slice 5 — npm shim:** a thin npm package that pulls the right bundle via platform-specific
  `optionalDependencies`, so `npm i -g`/`npx` keep working without requiring a local Node.
- **`ama upgrade` (ama-h522):** detect the install method and update in place.

Until slices 2–5 land, the published install path remains `npm i -g @mka-rainmaker/ama` (Node 24+).
The README badge says `Node.js 24+`, not "bundled," on purpose — it flips when distribution ships.
