<#
.SYNOPSIS
sa-local 工单状态 → 飞书推送器（后台进程）的启停与状态。

.DESCRIPTION
包装 dsh-sa-local-feishu-notify.mjs：轮询 orchestrator.sqlite，把「工单完成 / 结束非完成 / 需要人处理」推到飞书私聊。
首次启动只记基线不推送。日志在 profile 的 .artifacts/notify-*.out.log。
#>
[CmdletBinding()]
param([ValidateSet('start','stop','status','logs')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\sa-local'
$art = Join-Path $dst '.artifacts'
$pidFile = Join-Path $art 'notify.pid'
$script = 'D:\src\dsh\dsh-sa-local-feishu-notify.mjs'
$chat = 'oc_3c60d05ec9fdcde385c6a54a9b465084'
$larkDir = Join-Path $env:USERPROFILE '.lark-cli-dsh-superagent-feishu2'
New-Item -ItemType Directory -Path $art -Force | Out-Null

function Get-NotifyPid {
  if (-not (Test-Path $pidFile)) { return $null }
  $raw = (Get-Content $pidFile -Raw).Trim()
  $proc = Get-Process -Id $raw -ErrorAction SilentlyContinue
  if ($proc) { return $proc.Id } else { return $null }
}

switch ($Action) {
  'start' {
    $p = Get-NotifyPid
    if ($p) { Write-Host ('already running pid=' + $p); break }
    $node = (Get-Command node).Source
    $ts = Get-Date -Format 'yyyyMMddTHHmmss'
    $out = Join-Path $art ('notify-' + $ts + '.out.log')
    $err = Join-Path $art ('notify-' + $ts + '.err.log')
    $proc = Start-Process -FilePath $node -ArgumentList $script,'--chat',$chat,'--lark-dir',$larkDir -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $pidFile -Encoding utf8
    Start-Sleep -Seconds 4
    if ($proc.HasExited) { Write-Host ('启动失败 退出码 ' + $proc.ExitCode); Get-Content $err -Raw; exit 1 }
    Write-Host ('STARTED pid=' + $proc.Id + ' log=' + $out)
    break
  }
  'stop' {
    $p = Get-NotifyPid
    if (-not $p) { Write-Host 'not running'; break }
    Stop-Process -Id $p -Force
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'STOPPED'
    break
  }
  'status' {
    $p = Get-NotifyPid
    if ($p) { Write-Host ('pid   : ' + $p) } else { Write-Host 'pid   : none' }
    $log = Get-ChildItem $art -Filter 'notify-*.out.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($log) { Write-Host ('log   : ' + $log.Name); Get-Content $log.FullName -Tail 3 | ForEach-Object { Write-Host ('        ' + $_) } }
    break
  }
  'logs' {
    Get-ChildItem $art -Filter 'notify-*.log' | Sort-Object LastWriteTime | Select-Object -Last 2 | ForEach-Object { Write-Host ('=== ' + $_.Name); Get-Content $_.FullName -Tail 30 }
    break
  }
}
