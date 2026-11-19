# task-registry 本机安装/更新/停用
#
# 作用：写本机配置、生成 runner、注册每 10 分钟一次的兜底扫描计划任务。
# 只读 vault 里的 SUMMARY_*；写 _registry/ 与任务表（publisher 角色）。
#
# 用法：
#   pwsh -File scripts/task-registry/install.ps1 -Vault C:\syncJIANGUO\1.logseq -WhatIf
#   pwsh -File scripts/task-registry/install.ps1 -Vault C:\syncJIANGUO\1.logseq
#   pwsh -File scripts/task-registry/install.ps1 -Uninstall
param(
  [string]$Vault,
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [ValidateSet('publisher', 'producer')][string]$Role = 'publisher',
  [string]$TaskName = 'TaskRegistry-Sync',
  [int]$IntervalMinutes = 10,
  [string]$Device = $env:COMPUTERNAME,
  [switch]$WhatIf,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$configDir = Join-Path $env:LOCALAPPDATA 'task-registry'
$configFile = Join-Path $configDir 'config.json'
$runner = Join-Path $configDir 'run.cmd'
$log = Join-Path $configDir 'sync.log'
$cli = Join-Path $Repo 'tools\task-registry\cli.mjs'

function Write-Step([string]$message) { Write-Host "[task-registry] $message" }

if ($Uninstall) {
  Write-Step "removing scheduled task $TaskName (records and config are kept)"
  if ($WhatIf) { Write-Step "WhatIf: would unregister $TaskName"; return }
  schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  Write-Step 'done; config kept at %LOCALAPPDATA%\task-registry (delete it manually if no longer needed)'
  return
}

if (-not $Vault) { throw 'missing -Vault (for example C:\syncJIANGUO\1.logseq)' }
$Vault = (Resolve-Path -LiteralPath $Vault).Path
if (-not (Test-Path -LiteralPath $cli)) { throw "cli not found: $cli" }
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node not found in PATH (DSH requires Node 22+)' }

$plan = [ordered]@{
  vault = $Vault
  repo = $Repo
  role = $Role
  device = $Device
  task = $TaskName
  intervalMinutes = $IntervalMinutes
  config = $configFile
  runner = $runner
}
Write-Step ($plan | ConvertTo-Json -Compress)

if ($WhatIf) {
  Write-Step 'WhatIf: no file or scheduled task was changed'
  return
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$config = [ordered]@{
  version = 1
  vault = $Vault
  repo = $Repo
  role = $Role
  device = $Device
  installedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8

$runnerBody = @"
@echo off
setlocal
set "TASK_REGISTRY_VAULT=$Vault"
echo [%DATE% %TIME%] scan >> "$log"
"$($node.Source)" "$cli" scan --vault "$Vault" --apply >> "$log" 2>&1
"$($node.Source)" "$cli" feishu export --vault "$Vault" --apply >> "$log" 2>&1
"@
Set-Content -LiteralPath $runner -Value $runnerBody -Encoding ASCII

if ($Role -eq 'producer') {
  Write-Step 'role=producer: no scheduled task registered (this device only labels its own new summaries)'
  Write-Step 'done'
  return
}

# Re-register idempotently: remove the old action, then create the current one.
schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
$action = New-ScheduledTaskAction -Execute $runner
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'task-registry: scan recent SUMMARY files and refresh the recent-task table' | Out-Null

Write-Step "scheduled task '$TaskName' registered every $IntervalMinutes minute(s)"
Write-Step 'verify: Get-ScheduledTask -TaskName TaskRegistry-Sync'
& $node.Source $cli doctor --vault $Vault | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning 'doctor reported issues; run: node tools/task-registry/cli.mjs doctor --vault <vault>' }
Write-Step 'done'
