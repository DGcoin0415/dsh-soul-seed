param([string]$Agents, [switch]$Check)

$Home2 = if ($env:DSH_SHARED_DIR) { $env:DSH_SHARED_DIR } elseif ($env:SOUL_HOME) { $env:SOUL_HOME } else { Join-Path $env:USERPROFILE ".dsh\im" }
$Shared = Join-Path $Home2 "SHARED-STATE.md"

$Config = Join-Path $Home2 "sync-workspaces.json"
$LogFile = Join-Path $Home2 "sync.log"
if (-not (Test-Path $Shared)) { exit 0 }

function Write-Log([string]$msg) {
  try { Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg) -Encoding utf8 } catch {}
}

# 要同步哪几个工作区：本机 + 配置里写的 + 各集成登记的
function Get-Roots {
  $roots = @($Home2)
  if (Test-Path $Config) {
    try {
      $j = Get-Content $Config -Raw -Encoding utf8 | ConvertFrom-Json
      foreach ($p in $j.workspaces) { if ($p) { $roots += $p } }
    } catch { Write-Log "sync-workspaces.json 读不了：$_" }
  }
  Get-ChildItem (Join-Path $env:USERPROFILE ".dsh\integrations") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $w = Join-Path $_.FullName "workspaces.json"
    if (Test-Path $w) {
      try {
        $j = Get-Content $w -Raw -Encoding utf8 | ConvertFrom-Json
        foreach ($k in $j.workspaces.PSObject.Properties.Name) { $roots += $j.workspaces.$k }
      } catch {}
    }
  }
  $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

# 同步前先把面板对话导出来，树状里的 chat.md 保持最新
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$exportScript = Join-Path $Home2 "export-chat.mjs"
if ((Test-Path $nodeExe) -and (Test-Path $exportScript)) { & $nodeExe $exportScript *> $null }

# 生成快照用的正文：实时心情区块不进 AGENTS（它每半小时变，属于动态状态，放 SHARED 就够了）
function Get-SnapshotText {
  $t = Get-Content $Shared -Raw -Encoding utf8
  $t = [regex]::Replace($t, '(?s)## MOOD-AUTO.*?(?=\r?\n## |\z)', '')
  return $t.Trim()
}

function Get-NewestStamp {
  $files = @($Shared)
  $dir = Join-Path (Split-Path $Shared -Parent) 'shared'
  if (Test-Path $dir) { $files += (Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue).FullName }
  $max = Get-Item $Shared
  foreach ($f in $files) { try { $i = Get-Item $f -ErrorAction Stop; if ($i.LastWriteTime -gt $max.LastWriteTime) { $max = $i } } catch {} }
  return $max.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
}

function Get-SyncState([string]$agentsPath) {
  $stamp = Join-Path (Split-Path $agentsPath -Parent) ".shared-sync.stamp"
  $agentsText = Get-Content $agentsPath -Raw -Encoding utf8
  $hashNow = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-SnapshotText) + "|" + (Get-NewestStamp)))))
  $prev = if (Test-Path $stamp) { (Get-Content $stamp -Raw -ErrorAction SilentlyContinue).Trim() } else { '' }
  [pscustomobject]@{
    Path = $agentsPath
    Exists = $true
    HasBlock = ($agentsText -match 'SHARED:BEGIN')
    StampTime = if (Test-Path $stamp) { (Get-Item $stamp).LastWriteTime.ToString('MM-dd HH:mm') } else { '无' }
    Dirty = ($prev -ne $hashNow)
  }
}

function Sync-One([string]$agentsPath) {
  if (-not (Test-Path $agentsPath)) { return $false }
  $stamp = Join-Path (Split-Path $agentsPath -Parent) ".shared-sync.stamp"
  $agentsText = Get-Content $agentsPath -Raw -Encoding utf8
  if ($agentsText -notmatch 'SHARED:BEGIN') {
    $agentsText = $agentsText.TrimEnd() + "`r`n`r`n<!-- SHARED:BEGIN -->`r`n<!-- SHARED:END -->`r`n"
    [System.IO.File]::WriteAllText($agentsPath, $agentsText, (New-Object System.Text.UTF8Encoding $false))
  }
  $sharedText = Get-SnapshotText
  # 只看过滤后的内容有没有变：变了说明是别的躯体写进来的，才同步
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stampText = Get-NewestStamp
  $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sharedText + "|" + $stampText)))
  if (Test-Path $stamp) { $prev = Get-Content $stamp -Raw -ErrorAction SilentlyContinue; if ($null -ne $prev -and $prev.Trim() -eq $hash) { return $false } }
  $block = "<!-- SHARED:BEGIN -->`r`n## 灵魂同步（每轮先读 SHARED-STATE.md）`r`n`r`n- 状态页：" + $Shared + "`r`n- 最后改动：" + $stampText + "`r`n- 细节在 shared\ 下按需读，别整本背。`r`n<!-- SHARED:END -->"
  $new = [regex]::Replace($agentsText, '(?s)<!-- SHARED:BEGIN -->.*?<!-- SHARED:END -->', $block)
  [System.IO.File]::WriteAllText($agentsPath, $new, (New-Object System.Text.UTF8Encoding $false))
  [System.IO.File]::WriteAllText($stamp, $hash, (New-Object System.Text.UTF8Encoding $false))
  return $true
}

# 体检：清单里有谁、同步到什么时候、有没有落后
if ($Check) {
  $rows = @()
  foreach ($r in (Get-Roots)) {
    $a = Join-Path $r "AGENTS.md"
    if (Test-Path $a) { $rows += Get-SyncState $a }
    else { $rows += [pscustomobject]@{ Path = $a; Exists = $false; HasBlock = $false; StampTime = '-'; Dirty = $false } }
  }
  $rows | Format-Table -AutoSize | Out-String -Width 220
  exit 0
}

if ($Agents) { $changed = Sync-One $Agents; Write-Log ("单点同步 " + $Agents + " 改动=" + $changed); exit 0 }

# 拿写锁：别人正在改共享页就跳过这一轮，免得撞车
$nodeExe2 = (Get-Command node -ErrorAction SilentlyContinue).Source
$lockScript = Join-Path $Home2 "shared-lock.mjs"
$locked = $false
if ((Test-Path $nodeExe2) -and (Test-Path $lockScript)) {
  & $nodeExe2 $lockScript acquire --tag sync-shared --wait 3 *> $null
  if ($LASTEXITCODE -eq 0) { $locked = $true } else { Write-Log "没拿到写锁，跳过这一轮"; exit 0 }
}
try {
  $roots = @(Get-Roots)
  $changedList = @()
  foreach ($r in $roots) {
    $a = Join-Path $r "AGENTS.md"
    if (-not (Test-Path $a)) { continue }
    if (Sync-One $a) { $changedList += $r }
  }
  $stampText = Get-NewestStamp
  if ($changedList.Count -gt 0) { Write-Log ("同步完成 " + $stampText + " → " + ($changedList -join " | ")) }
  else { Write-Log ("检查 " + $stampText + "，无变化（扫了 " + $roots.Count + " 个工作区）") }
} finally {
  if ($locked) { & $nodeExe2 $lockScript release --tag sync-shared *> $null }
}
