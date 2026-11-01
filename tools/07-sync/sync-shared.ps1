param(
  [string]$Source = "",
  [string]$Target = "",
  [switch]$DryRun
)

# sync-shared.ps1 -- copy the shared folder to a mirror (OneDrive / a network path).
# ASCII only: PowerShell 5.1 reads .ps1 as ANSI, so Chinese breaks the parser.

$ErrorActionPreference = "Stop"
$Home2 = $env:USERPROFILE
$Src = if ($Source) { $Source } else { Join-Path $Home2 ".bili-ai\shared" }

if (-not (Test-Path $Src)) { "NO_SOURCE: $Src"; exit 1 }
if (-not $Target) { "NO_TARGET: pass -Target <dir>"; exit 2 }

if (-not (Test-Path $Target)) {
  if ($DryRun) { "DRY: would create $Target" } else { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
}

$files = Get-ChildItem $Src -Recurse -File -ErrorAction SilentlyContinue
"source: $Src"
"target: $Target"
"files: $($files.Count)"

foreach ($f in $files) {
  $rel = $f.FullName.Substring($Src.Length).TrimStart('\')
  $dest = Join-Path $Target $rel
  $dir = Split-Path $dest -Parent
  if ($DryRun) {
    "  DRY $rel"
    continue
  }
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Copy-Item $f.FullName $dest -Force
  "  synced $rel"
}

"done"
