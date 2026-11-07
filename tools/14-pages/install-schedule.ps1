param(
  [switch]$Uninstall
)

# ASCII only. Registers a per-user logon task that keeps the page scheduler alive.
# No admin needed: Task Scheduler allows current-user logon triggers.

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Daemon = Join-Path $Here 'pages-daemon.ps1'
$TaskName = 'dsh-soul-pages'

if (-not (Test-Path $Daemon)) { Write-Output 'missing pages-daemon.ps1'; exit 1 }

if ($Uninstall) {
  schtasks /delete /tn $TaskName /f | Out-Null
  Write-Output ("removed task " + $TaskName)
  exit 0
}

$action = '"' + "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Daemon + '"'
schtasks /create /tn $TaskName /tr $action /sc onlogon /rl limited /f | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output 'schtasks failed'; exit 1 }

Write-Output ("registered " + $TaskName + " (trigger: on logon)")
Write-Output "running it once now..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Daemon
