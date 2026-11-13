<#
.SYNOPSIS
sa-local（本地 fork：dsh-superagent-local）的启停与状态，端口 3083。

.DESCRIPTION
和 dsh-superagent-service.ps1 同一套逻辑，额外做三件事：
1) 启动前注入 LARKSUITE_CLI_CONFIG_DIR（飞书机器人专用配置目录）；
2) 启动前检查 win32 CLI 探测补丁是否还在（重装 fork 后补丁会丢）；
3) 停止后清理 stateDir 的 proper-lockfile 锁（否则下次启动 dsh-superagent 报 Lock file is already being held）。

.PARAMETER Action
start | stop | status | url | logs
#>
[CmdletBinding()]
param(
  [ValidateSet('start','stop','status','url','logs')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\sa-local'
$art = Join-Path $dst '.artifacts'
$pidFile = Join-Path $art 'service.pid'
$stateDir = Join-Path $env:USERPROFILE '.dsh\state\sa-local'
$stateLock = $stateDir + '.lock'
$larkDir = Join-Path $env:USERPROFILE '.lark-cli-dsh-superagent-feishu2'
$port = 3083
$stateUrl = 'http://127.0.0.1:' + $port + '/orchestrator/api/state'
New-Item -ItemType Directory -Path $art -Force | Out-Null

function Get-ServicePid {
  if (-not (Test-Path $pidFile)) { return $null }
  $raw = (Get-Content $pidFile -Raw).Trim()
  if (-not $raw) { return $null }
  $proc = Get-Process -Id $raw -ErrorAction SilentlyContinue
  if ($proc) { return $proc.Id } else { return $null }
}
function Get-PortPid {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { return ($c | Select-Object -First 1).OwningProcess } else { return $null }
}
function Test-Port {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { return $false }
}
function Get-TokenUrl {
  $log = Get-ChildItem $art -Filter 'service-*.out.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $log) { return $null }
  $line = Select-String -Path $log.FullName -Pattern 'dsh web: (http://\S+)' | Select-Object -Last 1
  if ($line) { return $line.Matches[0].Groups[1].Value } else { return $null }
}
function Test-Win32Patch {
  $lib = Get-ChildItem (Join-Path $dst 'node_modules\dsh-superagent\lib') -Filter 'poll-*.js' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $lib) { return $false }
  $t = Get-Content $lib.FullName -Raw
  return ($t -match 'windows \? argv')
}

switch ($Action) {
  'start' {
    if (Test-Port) { Write-Host ('已在运行，端口 ' + $port + ' 已监听'); break }
    if (Test-Path $stateLock) { Remove-Item $stateLock -Recurse -Force; Write-Host 'CLEANED stale state lock' }
    if (-not (Test-Win32Patch)) { Write-Host 'WARN: win32 CLI 探测补丁缺失（重装后常见），请先运行 dsh-sa-local-feishu-patch.ps1' }
    if (-not (Test-Path $larkDir)) { Write-Host ('WARN: 飞书配置目录不存在: ' + $larkDir) }
    $env:LARKSUITE_CLI_CONFIG_DIR = $larkDir
    $node = (Get-Command node).Source
    $bin = Join-Path (Split-Path $node) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    $ts = Get-Date -Format 'yyyyMMddTHHmmss'
    $outLog = Join-Path $art ('service-' + $ts + '.out.log')
    $errLog = Join-Path $art ('service-' + $ts + '.err.log')
    $proc = Start-Process -FilePath $node -ArgumentList $bin,'--profile','sa-local' -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $pidFile -Encoding utf8
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      if (Test-Port) { break }
      if ($proc.HasExited) { Write-Host ('启动失败 退出码 ' + $proc.ExitCode); Get-Content $errLog -Raw; exit 1 }
    }
    if (-not (Test-Port)) { Write-Host '启动超时 180s'; Get-Content $outLog -Tail 30; exit 1 }
    Write-Host ('STARTED pid=' + $proc.Id + ' port=' + $port)
    Start-Sleep -Seconds 3
    $u = Get-TokenUrl
    if ($u) { Write-Host ('URL: ' + $u) }
    # 飞书 bot 目前归 HITL 使用；superagent 走自己的 bot 之前不自动拉起飞书推送器。
    # 需要时手动：pwsh -File dsh-sa-local-notify.ps1 start
    break
  }
  'stop' {
    $notify = Join-Path $PSScriptRoot 'dsh-sa-local-notify.ps1'
    if (Test-Path $notify) { & $notify stop }
    $p = Get-ServicePid
    if (-not $p) { $p = Get-PortPid }
    if (-not $p) { Write-Host '未在运行（无存活 pid）'; break }
    Stop-Process -Id $p -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Test-Port)) { Start-Sleep -Seconds 1 }
    if (Test-Path $stateLock) { Remove-Item $stateLock -Recurse -Force; Write-Host 'CLEANED state lock' }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'STOPPED'
    break
  }
  'status' {
    $p = Get-ServicePid
    if (-not $p) { $p = Get-PortPid }
    if ($p) { Write-Host ('pid      : ' + $p) } else { Write-Host 'pid      : none' }
    if (Test-Port) { Write-Host ('port ' + $port + ' : listening') } else { Write-Host ('port ' + $port + ' : closed') }
    Write-Host ('patch    : ' + $(if (Test-Win32Patch) { 'win32 probe patch present' } else { 'MISSING (run dsh-sa-local-feishu-patch.ps1)' }))
    $notifyPidFile = Join-Path $art 'notify.pid'
    $np = if (Test-Path $notifyPidFile) { (Get-Content $notifyPidFile -Raw).Trim() } else { '' }
    if ($np -and (Get-Process -Id $np -ErrorAction SilentlyContinue)) { Write-Host ('notify   : pid ' + $np) } else { Write-Host 'notify   : none' }
    $u = Get-TokenUrl
    if ($u) { Write-Host ('url      : ' + $u) }
    if (Test-Port) {
      try {
        $st = (Invoke-WebRequest $stateUrl -UseBasicParsing -TimeoutSec 10 -Headers @{'x-orchestrator-request'='1'}).Content | ConvertFrom-Json
        Write-Host ('setup    : ' + $(if ($st.setup.problem) { $st.setup.problem.code } else { 'ok' }) + ' / feishu ' + $(if ($st.setup.feishuProblem) { $st.setup.feishuProblem.code } else { 'ok' }))
        $src = (Invoke-WebRequest ('http://127.0.0.1:' + $port + '/orchestrator/api/sources') -UseBasicParsing -TimeoutSec 10 -Headers @{'x-orchestrator-request'='1'}).Content | ConvertFrom-Json
        Write-Host ('sources  : ' + (($src | ForEach-Object { $_.id + '=' + $_.state }) -join ' '))
      } catch { Write-Host ('state    : ERR ' + $_.Exception.Message) }
    }
    break
  }
  'url' { $u = Get-TokenUrl; if ($u) { $u } else { Write-Host '还没有 URL' }; break }
  'logs' {
    Get-ChildItem $art -Filter 'service-*.log' | Sort-Object LastWriteTime | Select-Object -Last 2 | ForEach-Object { Write-Host ('=== ' + $_.FullName); Get-Content $_.FullName -Tail 40 }
    break
  }
}
