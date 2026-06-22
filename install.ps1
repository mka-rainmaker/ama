# Ama installer (Windows) — ama-py1r slice 4.
#
# Downloads the self-contained, no-Node bundle for this machine from the GitHub Release, unpacks it
# under %LOCALAPPDATA%\ama, and drops a launcher shim on PATH. No Node required.
#
#   irm https://raw.githubusercontent.com/mka-rainmaker/ama/main/install.ps1 | iex
#
# Env knobs: AMA_VERSION (tag, default "latest"), AMA_HOME, AMA_BIN_DIR,
# AMA_DIST_URL (override the download URL — used for testing).
$ErrorActionPreference = "Stop"

$repo    = "mka-rainmaker/ama"
$amaHome = if ($env:AMA_HOME)    { $env:AMA_HOME }    else { Join-Path $env:LOCALAPPDATA "ama" }
$binDir  = if ($env:AMA_BIN_DIR) { $env:AMA_BIN_DIR } else { Join-Path $amaHome "bin" }
$version = if ($env:AMA_VERSION) { $env:AMA_VERSION } else { "latest" }

# 1. detect target
$cpu     = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$target  = "win32-$cpu"
$archive = "ama-$target.zip"

# 2. resolve the download URL (AMA_DIST_URL overrides for testing)
$url =
  if ($env:AMA_DIST_URL)     { $env:AMA_DIST_URL }
  elseif ($version -eq "latest") { "https://github.com/$repo/releases/latest/download/$archive" }
  else                       { "https://github.com/$repo/releases/download/$version/$archive" }

# 3. download + unpack into amaHome\<target>\
$tmp = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp $archive
Write-Host "ama: downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
New-Item -ItemType Directory -Force -Path $amaHome | Out-Null
$dest = Join-Path $amaHome $target
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive -Path $zip -DestinationPath $amaHome -Force
Remove-Item -Recurse -Force $tmp

# 4. launcher shim on PATH — absolute path so the bundle launcher resolves its own dir correctly
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = "@echo off`r`n`"$dest\bin\ama.cmd`" %*`r`n"
Set-Content -Path (Join-Path $binDir "ama.cmd") -Value $shim -NoNewline -Encoding ASCII

# 5. verify + PATH hint
$version = & (Join-Path $binDir "ama.cmd") --version
Write-Host "ama: installed $version -> $binDir\ama.cmd"
if (($env:PATH -split ';') -notcontains $binDir) {
  Write-Host "ama: add $binDir to your PATH"
}
