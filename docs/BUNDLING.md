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
npm run bundle linux-x64  # any target — downloads + checksum-verifies the official Node
```

The official Node for the target is downloaded and verified against `SHASUMS256.txt`, so any target
builds on any OS. Env knobs: `AMA_BUNDLE_HOST_NODE=1` copies the running node instead (host only,
fast dev); `AMA_NODE_VERSION=x.y.z` overrides the pinned version.

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`.

## Verify (the whole point)

With system Node **off** your PATH, the bundle still works:

```bash
PATH=/usr/bin:/bin bundle/<target>/bin/ama --version
```

End-to-end, a bundled `ama mcp` indexes and serves a repo with no system node anywhere — wasm
parsing and `node:sqlite` run entirely on the vendored runtime.

## Install (end users)

Once the repo is public and a release is published, the bundle installs with no Node:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/mka-rainmaker/ama/main/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/mka-rainmaker/ama/main/install.ps1 | iex
```

`install.sh` / `install.ps1` detect the platform, download the matching bundle from the Release,
unpack it under `~/.ama` (or `%LOCALAPPDATA%\ama`), and put a launcher shim on PATH. Env knobs:
`AMA_VERSION` (tag, default `latest`), `AMA_HOME`, `AMA_BIN_DIR`, and `AMA_DIST_URL` (override the
download — used for testing against a local `file://` archive).

## Status & roadmap (ama-py1r)

- **Slice 1 (done):** the `build-bundle` script + launcher, proven on the host target.
- **Slice 2 (done):** downloads + checksum-verifies the official Node for any target, so all six
  targets build on any OS (verified: a `linux-x64` bundle cross-built on macOS yields an ELF binary).
- **Slice 3 (done):** `.github/workflows/release.yml` — a matrix builds all six bundles on **native
  runners** (so each is built *and* run on its own OS/arch), packages them, and attaches them to a
  GitHub Release on a `v*` tag. `workflow_dispatch` runs the build+smoke matrix *without* releasing,
  so the matrix can be verified before a tag is cut. (Verified locally per target by `file`-checking
  the vendored binary; the native run/smoke is verified by the CI matrix.)
- **Slice 4 (done):** `install.sh` (macOS/Linux) + `install.ps1` (Windows) — detect the platform,
  download the bundle from the Release, unpack under `~/.ama`, and drop a launcher *shim* on PATH
  (absolute-path shim, so the relative-path launcher still resolves its own dir). `install.sh` is
  verified end-to-end against a local bundle (only the GitHub fetch is stubbed via `file://`);
  `install.ps1` is verified on Windows/CI.
- **Slice 5 — npm shim:** a thin npm package that pulls the right bundle via platform-specific
  `optionalDependencies`, so `npm i -g`/`npx` keep working without requiring a local Node.
- **`ama upgrade` (ama-h522):** detect the install method and update in place.

Until the first public release, the install path remains `npm i -g @mka-rainmaker/ama` (Node 24+);
the `curl … | sh` / PowerShell installers go live with the first tagged release on a public repo,
and the npm shim (slice 5) is what keeps `npm i -g`/`npx` working with no local Node. The README
badge says `Node.js 24+`, not "bundled," on purpose — it flips when distribution ships.
