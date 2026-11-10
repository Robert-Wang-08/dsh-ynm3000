<#
.SYNOPSIS
superagent 独立 DSH 服务的启停与状态（端口 3082，profile superagent）。

.DESCRIPTION
dsh-superagent 官方脚本依赖 tmux，Windows 上没有，因此本机用本脚本管理：
start 起一个脱离终端运行的 node 进程，日志写进 profile 的 .artifacts/，并打印带 token 的 Web URL；
stop 结束该进程（会中断正在跑的 Executor 回合）；status 同时看端口与 dsh-superagent 的 /orchestrator/api/state。

.PARAMETER Action
start | stop | status | url | logs

.EXAMPLE
pwsh -File dsh-superagent-service.ps1 status
#>
[CmdletBinding()]
param(
  [ValidateSet('start','stop','status','url','logs')]
  [string]$Action = 'status',
  # 飞书 bot 的 lark-cli 配置目录；留空则优先用 superagent 专用 bot，其次旧的（已被平台拦）
  [string]$LarkDir = ''
)

$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\superagent'
$art = Join-Path $dst '.artifacts'
$pidFile = Join-Path $art 'service.pid'
$port = 3082
$stateUrl = 'http://127.0.0.1:' + $port + '/orchestrator/api/state'
# dsh-superagent 用 proper-lockfile 锁 stateDir（同步锁、无重试）；硬停会留下 <stateDir>.lock，重启前必须清掉。
$stateDir = Join-Path $env:USERPROFILE '.dsh\state\superagent'
$stateLock = $stateDir + '.lock'
New-Item -ItemType Directory -Path $art -Force | Out-Null

function Get-ServicePid {
  if (-not (Test-Path $pidFile)) { return $null }
  $raw = (Get-Content $pidFile -Raw).Trim()
  if (-not $raw) { return $null }
  $proc = Get-Process -Id $raw -ErrorAction SilentlyContinue
  if ($proc) { return $proc.Id } else { return $null }
}

function Test-Port {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
}

function Get-TokenUrl {
  $log = Get-ChildItem $art -Filter 'service-*.out.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $log) { return $null }
  $line = Select-String -Path $log.FullName -Pattern 'dsh web: (http://\S+)' | Select-Object -Last 1
  if ($line) { return $line.Matches[0].Groups[1].Value } else { return $null }
}

switch ($Action) {
  'start' {
    if (Test-Port) { Write-Host ('已在运行，端口 ' + $port + ' 已监听'); break }
    if (Test-Path $stateLock) { Remove-Item $stateLock -Recurse -Force; Write-Host 'CLEANED stale state lock: ' }
    $node = (Get-Command node).Source
    $bin = Join-Path (Split-Path $node) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $bin)) { $bin = Join-Path (& npm root -g) '@deepseek-ai/dsh/lib/bin.js' }
    $ts = Get-Date -Format 'yyyyMMddTHHmmss'
    $outLog = Join-Path $art ('service-' + $ts + '.out.log')
    $errLog = Join-Path $art ('service-' + $ts + '.err.log')
    # 飞书/GitHub 的 setup 探测用 POSIX `env` 前缀；Windows 上由 Git for Windows 提供 env.exe，必须进 PATH。
    $gitEnv = 'C:\Program Files\Git\usr\bin'
    if (Test-Path $gitEnv) { $env:PATH = $gitEnv + ';' + $env:PATH }
    # 飞书机器人的 lark-cli 专用配置目录（strict-mode bot），子进程继承。
    # 2026-11-06：默认改用 superagent 专用 bot（cli_aa67e4041a381c02，「superagent-飞书bot」），
    # 旧的 .lark-cli-dsh-superagent（cli_aa6697691db89c00）已被飞书 21001 数据安全策略拦，
    # 只作兜底保留。可用 -LarkDir 覆盖。
    $larkDir = $LarkDir
    if (-not $larkDir) {
      # 2026-11-10：新 bot cli_aa79ee689678dd03（旧 cli_aa67e4041a381c02 已弃用，保留兜底）。
      $preferred = Join-Path $env:USERPROFILE '.lark-cli-superagent-aa79ee689678dd03'
      $old = Join-Path $env:USERPROFILE '.lark-cli-hitl-aa67e4041a381c02'
      $legacy = Join-Path $env:USERPROFILE '.lark-cli-dsh-superagent'
      if (Test-Path $preferred) { $larkDir = $preferred } elseif (Test-Path $old) { $larkDir = $old } elseif (Test-Path $legacy) { $larkDir = $legacy }
    }
    if ($larkDir -and (Test-Path $larkDir)) {
      $env:LARKSUITE_CLI_CONFIG_DIR = $larkDir
      Write-Host ('lark-cli config dir = ' + $larkDir)
    }
    $proc = Start-Process -FilePath $node -ArgumentList $bin,'--profile','superagent' -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $pidFile -Encoding utf8
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      if (Test-Port) { break }
      if ($proc.HasExited) { Write-Host ('启动失败 退出码 ' + $proc.ExitCode); Get-Content $errLog -Raw; exit 1 }
    }
    if (-not (Test-Port)) { Write-Host '启动超时 120s'; Get-Content $outLog -Tail 30; exit 1 }
    Write-Host ('STARTED pid=' + $proc.Id + ' port=' + $port)
    $u = Get-TokenUrl
    if ($u) { Write-Host ('URL: ' + $u) }
    break
  }
  'stop' {
    $p = Get-ServicePid
    if (-not $p) { Write-Host '未在运行 无存活 pid'; break }
    Write-Host ('STOPPING pid=' + $p + ' 会中断正在运行的 Executor 回合')
    Stop-Process -Id $p -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Test-Port)) { Start-Sleep -Seconds 1 }
    if (Test-Port) { Write-Host '端口仍在监听 请检查残留进程'; exit 1 }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $stateLock) { Remove-Item $stateLock -Recurse -Force; Write-Host 'CLEANED state lock' }
    Write-Host 'STOPPED'
    break
  }
  'status' {
    $p = Get-ServicePid
    if ($p) { Write-Host ('pid      : ' + $p) } else { Write-Host 'pid      : none' }
    if (Test-Port) { Write-Host ('port ' + $port + ' : listening') } else { Write-Host ('port ' + $port + ' : closed') }
    $u = Get-TokenUrl
    if ($u) { Write-Host ('url      : ' + $u) }
    if (Test-Port) {
      try {
        $resp = Invoke-WebRequest $stateUrl -UseBasicParsing -TimeoutSec 8 -Headers @{ 'x-orchestrator-request' = '1' }
        $state = $resp.Content | ConvertFrom-Json
        if ($state.setup.problem) { Write-Host ('setup    : ' + $state.setup.problem.place + '/' + $state.setup.problem.code) } else { Write-Host 'setup    : ok' }
        $bad = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' })
        if ($bad.Count -eq 0) { Write-Host 'health   : no error entries' } else { Write-Host ('health   : ' + (($bad | ForEach-Object { $_.Name + '=' + $_.Value.detail }) -join '; ')) }
        Write-Host ('load     : running=' + $state.load.running + ' queued=' + $state.load.queued + ' maxWorkers=' + $state.load.maxWorkers + ' paused=' + $state.paused)
      } catch { Write-Host ('state    : ERR ' + $_.Exception.Message) }
    }
    break
  }
  'url' {
    $u = Get-TokenUrl
    if ($u) { $u } else { Write-Host '日志里还没有 URL 服务未启动过' }
    break
  }
  'logs' {
    Get-ChildItem $art -Filter 'service-*.log' | Sort-Object LastWriteTime | Select-Object -Last 2 | ForEach-Object { Write-Host ('=== ' + $_.FullName); Get-Content $_.FullName -Tail 40 }
    break
  }
}
