param(
  [switch]$Force
)

# ASCII only: PowerShell 5.1 reads .ps1 as ANSI, any non-ASCII breaks the parser.
# Single-instance daemon launcher for tools/14-pages/pages-schedule.mjs

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Here 'pages-schedule.mjs'
if (-not (Test-Path $Script)) { Write-Output 'missing pages-schedule.mjs'; exit 1 }

# already running?
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('pages-schedule.mjs') }
if ($running -and -not $Force) {
  Write-Output ("already running, pid=" + ($running | Select-Object -First 1).ProcessId)
  exit 0
}

# find node: DSH_NODE -> scan dsh-runtimes -> self with ELECTRON_RUN_AS_NODE
function Resolve-Node {
  if ($env:DSH_NODE -and (Test-Path $env:DSH_NODE)) { return @{ exe = $env:DSH_NODE; env = $null } }
  $root = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $root) {
    $hit = Get-ChildItem $root -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\node\\bin\\node\.exe$' } | Select-Object -First 1
    if ($hit) { return @{ exe = $hit.FullName; env = $null } }
  }
  return @{ exe = (Get-Command node -ErrorAction SilentlyContinue).Source; env = $null }
}

$n = Resolve-Node
if (-not $n.exe) { Write-Output 'no node found'; exit 2 }

Write-Output ("starting with " + $n.exe)
$p = Start-Process -FilePath $n.exe -ArgumentList @($Script) -WindowStyle Hidden -PassThru
Write-Output ("started pid=" + $p.Id)
