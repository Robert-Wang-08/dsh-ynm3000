#Requires -Version 7.0
<#
.SYNOPSIS
    注册独立于 superagent 的 DSH Git 巡检计划任务。
.DESCRIPTION
    默认每小时运行；Interactive 保留当前用户网络凭据，仅用户登录时运行。
    -DryRun 只打印计划。移除用 -Remove（可配 -DryRun 查看移除计划）。
.EXAMPLE
    pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -DryRun
    pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -IntervalMinutes 60
    pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -Remove
#>
[CmdletBinding()]
param(
    [ValidateRange(1,525600)][int]$IntervalMinutes = 60,
    [ValidateNotNullOrEmpty()][string]$TaskName = 'DSH-Git-Watchdog',
    [switch]$Remove,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($Remove) {
    if ($DryRun) { Write-Output "[DryRun] 将移除任务：$TaskName（若存在），未做系统改动。"; exit 0 }
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Output "已移除：$TaskName" }
    else { Write-Output '任务不存在，无需移除。' }
    exit 0
}
$watchdogScript = Join-Path $PSScriptRoot 'dsh-git-watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdogScript)) { throw "找不到巡检脚本：$watchdogScript" }
# 应用执行别名不含版本号，Store 升级后计划任务不会引用已删除的旧目录。
$aliasPwsh = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe'
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwshPath = if (Test-Path -LiteralPath $aliasPwsh) { $aliasPwsh }
    elseif ($pwshCmd) { $pwshCmd.Source }
    else { Join-Path $PSHOME 'pwsh.exe' }
$now = Get-Date
$nextHour = $now.Date.AddHours($now.Hour + 1)
$argLine = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $watchdogScript + '"'
$userId = "$env:USERDOMAIN\$env:USERNAME"
Write-Output "== Git 巡检计划任务：$TaskName =="
Write-Output "首次运行：$nextHour；每 $IntervalMinutes 分钟；持续 8760 小时"
Write-Output "动作：$pwshPath $argLine"
Write-Output "工作目录：$PSScriptRoot"
Write-Output "身份：$userId（Interactive，仅登录时运行）"
Write-Output '设置：StartWhenAvailable；IgnoreNew；30 分钟执行上限；允许电池运行'
if ($DryRun) { Write-Output '[DryRun] 未做任何系统改动。去掉 -DryRun 即注册。'; exit 0 }
try {
    $action = New-ScheduledTaskAction -Execute $pwshPath -Argument $argLine -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -Once -At $nextHour -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Hours 8760)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Output "已注册：$TaskName"
    Write-Output ('下次运行：' + (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime)
    Write-Output "手动验证：Start-ScheduledTask -TaskName '$TaskName'"
    exit 0
}
catch { Write-Error ('注册失败：' + $_.Exception.Message); exit 1 }
