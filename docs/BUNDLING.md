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
  so the matrix can be verified before a tag is cut. (Verified green: a `workflow_dispatch` run built
  *and ran* all six legs on real hardware — incl. `darwin-x64` on `macos-14` + Rosetta 2, since Intel
  `macos-13` runners are scarce.)
- **Slice 4 (done):** `install.sh` (macOS/Linux) + `install.ps1` (Windows) — detect the platform,
  download the bundle from the Release, unpack under `~/.ama`, and drop a launcher *shim* on PATH
  (absolute-path shim, so the relative-path launcher still resolves its own dir). `install.sh` is
  verified end-to-end against a local bundle (only the GitHub fetch is stubbed via `file://`);
  `install.ps1` is verified on Windows/CI.
- **Slice 5 — npm shim: intentionally skipped.** A bundle-pulling npm package's only unique value —
  an install that ignores the user's Node version — is *already* covered by the `curl | sh` bundle
  (which needs no Node at all). Shipping it would cost ~1 GB across six ~150–340 MB platform packages
  (vendored Node + the `typescript` runtime dep), or a fragile postinstall-download. The two channels
  below are the complete distribution: **lean npm** for Node ≥24, **the bundle installer** for the rest.
- **`ama upgrade` (ama-h522, done):** detects the install method (bundle / npm / npx / source) and
  updates in place — `npm i -g` for npm installs, the installer one-liner for bundles; `--check`
  reports the latest GitHub release, `--dry-run` previews, `[version]` pins.

Two distribution channels, complete: **lean npm** (`npm i -g @mka-rainmaker/ama`, Node 24+ — pure JS,
deps via npm) for Node-having users, and the **`curl … | sh` / PowerShell bundle installers** (no
Node) for everyone else. The installers go live with the first tagged release on a public repo. The
README badge says `Node.js 24+`, not "bundled," on purpose — it flips when distribution ships.
