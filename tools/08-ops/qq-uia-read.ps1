param(
  [string]$ProcName = "QQ",
  [int]$Max = 20,
  [switch]$Json
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { if ($Json) { '{"ok":false,"error":"NO_WINDOW"}' } else { "NO_WINDOW" }; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)

$hc = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'chat-header__contact-name')
$head = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $hc)
$chat = if ($head) { $head.Current.Name } else { '?' }

$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$rows = @()
foreach ($el in $all) {
  $c = $el.Current.ClassName
  if ([string]::IsNullOrEmpty($c)) { continue }
  if (-not $c.StartsWith('message-container')) { continue }
  $mine = $c -match '--self'
  $texts = New-Object System.Collections.Generic.List[string]
  if ($el.Current.Name -and $el.Current.Name.Trim()) { $texts.Add($el.Current.Name.Trim()) }
  $tc = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  foreach ($t in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
    $v = $t.Current.Name
    if ([string]::IsNullOrWhiteSpace($v)) { continue }
    $v = $v.Trim()
    if ($texts.Contains($v)) { continue }
    $texts.Add($v)
  }
  $joined = ($texts -join ' | ')
  if ([string]::IsNullOrWhiteSpace($joined)) { continue }
  $rows += [pscustomobject]@{ self = $mine; text = $joined }
}

$take = @($rows | Select-Object -Last $Max)

if ($Json) {
  $out = [pscustomobject]@{
    ok = $true
    chat = $chat
    count = $rows.Count
    messages = @($take | ForEach-Object { [pscustomobject]@{ self = $_.self; text = $_.text } })
  }
  $out | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

"chat: $chat   messages: $($rows.Count)"
foreach ($r in $take) {
  $who = if ($r.self) { 'ME' } else { 'THEM' }
  "[$who] $($r.text)"
}
