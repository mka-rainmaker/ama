// Pure helpers for vendoring an official Node runtime into a bundle (ama-py1r slice 2).
// Kept side-effect-free so the target→archive naming + checksum parsing are unit-testable;
// the actual download/extract lives in build-bundle.mjs.

const PLATFORMS = { darwin: "darwin", linux: "linux", win32: "win" };
const ARCHES = new Set(["x64", "arm64"]);

/**
 * Resolve the official Node download for a bundle target.
 * @param {string} target  `<platform>-<arch>`, e.g. "linux-x64" or "win32-arm64"
 * @param {string} version Node version without the leading "v", e.g. "24.12.0"
 */
export function nodeArchiveInfo(target, version) {
  const [platform, arch] = target.split("-");
  const os = PLATFORMS[platform];
  if (!os) throw new Error(`unsupported platform: ${platform} (target ${target})`);
  if (!ARCHES.has(arch)) throw new Error(`unsupported arch: ${arch} (target ${target})`);
  const isWin = os === "win";
  const stem = `node-v${version}-${os}-${arch}`;
  const archive = `${stem}.${isWin ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${version}`;
  return {
    url: `${base}/${archive}`,
    shasumsUrl: `${base}/SHASUMS256.txt`,
    archive,
    binPath: isWin ? `${stem}/node.exe` : `${stem}/bin/node`, // path inside the extracted archive
    binName: isWin ? "node.exe" : "node",
  };
}

/** Find the SHA-256 of `archive` in a SHASUMS256.txt body. Throws if absent — never ship unverified. */
export function parseShasum(text, archive) {
  for (const line of text.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === archive) return hash;
  }
  throw new Error(`no checksum for ${archive} in SHASUMS256.txt`);
}
