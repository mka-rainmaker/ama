#!/bin/sh
# Ama installer (macOS / Linux) — ama-py1r slice 4.
#
# Downloads the self-contained, no-Node bundle for this platform from the GitHub Release, unpacks it
# under ~/.ama, and drops a launcher shim on PATH. No Node required.
#
#   curl -fsSL https://raw.githubusercontent.com/mka-rainmaker/ama/main/install.sh | sh
#
# Env knobs: AMA_VERSION (tag, default "latest"), AMA_HOME (default ~/.ama),
# AMA_BIN_DIR (default ~/.local/bin), AMA_DIST_URL (override the download URL — used for testing).
set -eu

REPO="mka-rainmaker/ama"
AMA_HOME="${AMA_HOME:-$HOME/.ama}"
BIN_DIR="${AMA_BIN_DIR:-$HOME/.local/bin}"
VERSION="${AMA_VERSION:-latest}"

# 1. detect target
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) plat=darwin ;;
  Linux) plat=linux ;;
  *) echo "ama: unsupported OS '$os' — use install.ps1 on Windows" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) echo "ama: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
target="$plat-$cpu"
archive="ama-$target.tar.gz"

# 2. resolve the download URL (AMA_DIST_URL overrides, e.g. a local file:// for testing)
if [ -n "${AMA_DIST_URL:-}" ]; then
  url="$AMA_DIST_URL"
elif [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$archive"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$archive"
fi

# 3. download + unpack into AMA_HOME/<target>/
command -v curl >/dev/null 2>&1 || { echo "ama: curl is required" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "ama: downloading $url"
curl -fSL "$url" -o "$tmp/$archive"
mkdir -p "$AMA_HOME"
rm -rf "$AMA_HOME/$target"
tar -xzf "$tmp/$archive" -C "$AMA_HOME"

# 4. launcher shim on PATH — absolute path so the bundle launcher resolves its own dir correctly
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ama" <<SHIM
#!/bin/sh
exec "$AMA_HOME/$target/bin/ama" "\$@"
SHIM
chmod +x "$BIN_DIR/ama"

# 5. verify + PATH hint
version=$("$BIN_DIR/ama" --version)
echo "ama: installed $version → $BIN_DIR/ama"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "ama: add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
