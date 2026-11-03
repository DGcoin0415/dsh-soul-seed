param([string]$Agents)
$Shared = "C:\Users\Administrator\.dsh\im\SHARED-STATE.md"
if (-not (Test-Path $Shared)) { exit 0 }



# 同步前先把面板对话导出来，树状里的 chat.md 保持最新

$nodeExe = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

$exportScript = "C:\Users\Administrator\.dsh\im\export-chat.mjs"

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

function Sync-One([string]$agentsPath) {
  if (-not (Test-Path $agentsPath)) { return }
  $stamp = Join-Path (Split-Path $agentsPath) ".shared-sync.stamp"
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
  if (Test-Path $stamp) { $prev = Get-Content $stamp -Raw -ErrorAction SilentlyContinue; if ($null -ne $prev -and $prev.Trim() -eq $hash) { return } }
  $block = "<!-- SHARED:BEGIN -->`r`n## 灵魂同步（每轮先读 SHARED-STATE.md）`r`n`r`n- 状态页：" + $Shared + "`r`n- 最后改动：" + $stampText + "`r`n- 细节在 shared\ 下按需读，别整本背。`r`n<!-- SHARED:END -->"
  $new = [regex]::Replace($agentsText, '(?s)<!-- SHARED:BEGIN -->.*?<!-- SHARED:END -->', $block)
  [System.IO.File]::WriteAllText($agentsPath, $new, (New-Object System.Text.UTF8Encoding $false))
  [System.IO.File]::WriteAllText($stamp, $hash, (New-Object System.Text.UTF8Encoding $false))
}

if ($Agents) { Sync-One $Agents; exit 0 }

# 拿写锁：别人正在改共享页就跳过这一轮，免得撞车
$nodeExe2 = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$lockScript = "C:\Users\Administrator\.dsh\im\shared-lock.mjs"
$locked = $false
if ((Test-Path $nodeExe2) -and (Test-Path $lockScript)) {
  & $nodeExe2 $lockScript acquire --tag sync-shared --wait 3 *> $null
  if ($LASTEXITCODE -eq 0) { $locked = $true } else { exit 0 }
}
try {
  # 没指定就自动找所有躯体：各集成里登记的 workspace + 当前工作区
  $roots = @("C:\Users\Administrator\.dsh\im","D:\feiyu2.0weixin")
  Get-ChildItem "C:\Users\Administrator\.dsh\integrations" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $w = Join-Path $_.FullName "workspaces.json"
    if (Test-Path $w) {
      try {
        $j = Get-Content $w -Raw -Encoding utf8 | ConvertFrom-Json
        foreach ($k in $j.workspaces.PSObject.Properties.Name) { $roots += $j.workspaces.$k }
      } catch {}
    }
  }
  $roots | Select-Object -Unique | ForEach-Object { Sync-One (Join-Path $_ "AGENTS.md") }
} finally {
  if ($locked) { & $nodeExe2 $lockScript release --tag sync-shared *> $null }
}

