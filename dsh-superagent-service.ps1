#Requires -Version 7.0
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
  [ValidateSet('start','stop','restart','status','url','logs')]
  [string]$Action = 'status',
  # 仅对 start/restart 生效：手动 stop 过则保持停止（供每小时自愈检查使用）
  [switch]$RespectStop,
  # stop/restart 会硬中断正在跑的 Executor 回合；有存活回合时必须显式 -Force
  [switch]$Force,
  # 飞书 bot 的 lark-cli 配置目录；留空则优先用 superagent 专用 bot，其次旧的（已被平台拦）
  [string]$LarkDir = ''
)

$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\superagent'
$art = Join-Path $dst '.artifacts'
$pidFile = Join-Path $art 'service.pid'
$control = Join-Path $art 'control\profiles\superagent'
$stopMarker = Join-Path $control 'manual-stop'
$port = 3082
$stateUrl = 'http://127.0.0.1:' + $port + '/orchestrator/api/state'
# dsh-superagent 用 proper-lockfile 锁 stateDir（同步锁、无重试）；硬停会留下 <stateDir>.lock，重启前必须清掉。
$stateDir = Join-Path $env:USERPROFILE '.dsh\state\superagent'
$stateLock = $stateDir + '.lock'
# 目录已存在时 New-Item 无写入；不存在且沙箱禁止工作区外写入时不得终止脚本，故全部降级为静默。
New-Item -ItemType Directory -Path $art -Force -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Path $control -Force -ErrorAction SilentlyContinue | Out-Null

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

function Test-ManuallyStopped { return (Test-Path $stopMarker) }

function Get-RunningTurns {
  $s = Get-State
  if ($s) { return [int]$s.load.running } else { return 0 }
}

function Test-Idle($action) {
  if ($Force) { return $true }
  $run = Get-RunningTurns
  if ($run -gt 0) { Write-Host ('REFUSED ' + $action + ': ' + $run + ' 个 Executor 回合正在运行，硬停会中断；确认要中断请加 -Force'); return $false }
  return $true
}

function Get-State {
  if (-not (Test-Port)) { return $null }
  try {
    $resp = Invoke-WebRequest $stateUrl -UseBasicParsing -TimeoutSec 8 -Headers @{ 'x-orchestrator-request' = '1' }
    return ($resp.Content | ConvertFrom-Json)
  } catch { return $null }
}

function Prune-Logs {
  $logs = Get-ChildItem $art -Filter 'service-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if ($logs.Count -gt 20) { $logs | Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue }
}

# 0 正常 / 1 没运行·不可达·运行期错误 / 2 运行中但组件报错 / 3 等待 setup
function Get-StatusCode {
  $p = Get-ServicePid
  if (-not $p -or -not (Test-Port)) { return 1 }
  $state = Get-State
  if (-not $state) { return 1 }
  if ($state.setup.problem) { return 3 }
  $bad = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' })
  if ($bad.Count -gt 0) { return 2 }
  return 0
}

# 端口就绪不等于运行时就绪：start/restart 对齐官方脚本，最多等 60s 拿到管理 API 的第一份状态。
function Wait-Ready {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $s = Get-State
    if ($s) { return $s }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Get-TokenUrl {
  $log = Get-ChildItem $art -Filter 'service-*.out.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $log) { return $null }
  $line = Select-String -Path $log.FullName -Pattern 'dsh web: (http://\S+)' | Select-Object -Last 1
  if ($line) { return $line.Matches[0].Groups[1].Value } else { return $null }
}

switch ($Action) {
  'start' {
    if (Test-Port) { Write-Host ('已在运行，端口 ' + $port + ' 已监听'); exit 0 }
    if ($RespectStop -and (Test-ManuallyStopped)) { Write-Host 'manually_stopped: true 按 -RespectStop 保持停止'; exit 1 }
    Prune-Logs
    if (Test-Path $stateLock) { try { Remove-Item $stateLock -Recurse -Force -ErrorAction Stop; Write-Host 'CLEANED stale state lock: ' } catch { Write-Host ('WARN 无法清除 stale state lock（启动可能失败）: ' + $_.Exception.Message) } }
    $node = (Get-Command node).Source
    $bin = Join-Path (Split-Path $node) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $bin)) { $bin = Join-Path (& npm root -g) '@deepseek-ai/dsh/lib/bin.js' }
    $ts = Get-Date -Format 'yyyyMMddTHHmmss'
    $outLog = Join-Path $art ('service-' + $ts + '.out.log')
    $errLog = Join-Path $art ('service-' + $ts + '.err.log')
    # 飞书/GitHub 的 setup 探测用 POSIX `env` 前缀；Windows 上由 Git for Windows 提供 env.exe，必须进 PATH。
    $gitEnv = 'C:\Program Files\Git\usr\bin'
    if (Test-Path $gitEnv) { $env:PATH = $gitEnv + ';' + $env:PATH }
    # 飞书 bot 的 lark-cli 配置目录是「设备相关」，不在共享脚本里写死优先级（AGENTS.md §8）。
    # 解析顺序：-LarkDir > 设备层 ~/.dsh/device/superagent-lark.json > 候选探测（含 appId 自检）。
    # 换机时用 dsh-superagent-lark-bot.ps1 -Action pin -Dir <目录> 固定本机 bot；不改本文件。
    # 注意：dot-source 会执行 helper 的 param() 绑定，把本脚本的 $Action/$Dir 覆写成默认值。
    # 这里保存再恢复，避免以后在 start 分支之后新增逻辑时读到错误值。
    $svcAction = $Action
    . (Join-Path $PSScriptRoot 'dsh-superagent-lark-bot.ps1')
    $Action = $svcAction
    try {
      $resolved = Resolve-DshLarkDir $LarkDir
    } catch {
      # 显式 -LarkDir 不可用：不因此让服务起不来，改为告警后回落设备层/探测。
      Write-Host ('WARN 显式 -LarkDir 不可用：' + $_.Exception.Message + '；回落到设备层/探测')
      $resolved = Resolve-DshLarkDir ''
      $resolved.reason = ('显式 -LarkDir 被忽略；' + $resolved.reason)
    }
    $larkDir = $resolved.chosen
    if ($larkDir) {
      $env:LARKSUITE_CLI_CONFIG_DIR = $larkDir
      Write-Host ('lark-cli config dir = ' + $larkDir + '  [appId=' + $resolved.appId + ' via ' + $resolved.source + ']')
      if ($resolved.reason) { Write-Host ('  why: ' + $resolved.reason) }
      foreach ($c in $resolved.candidates) {
        if ($c.status -ne 'usable' -and $c.status -ne 'missing') { Write-Host ('  WARN 候选被跳过(' + $c.status + ')：' + $c.dir) }
        if ($c.dir -eq $larkDir -and -not $c.verified -and $c.warn) { Write-Host ('  WARN 选中的目录未经 appId 自检：' + $c.warn) }
      }
    } else {
      Write-Host ('WARN 没有可用的 lark-cli bot 配置目录：' + $resolved.reason)
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
    Remove-Item $stopMarker -Force -ErrorAction SilentlyContinue
    Write-Host ('STARTED pid=' + $proc.Id + ' port=' + $port)
    $u = Get-TokenUrl
    if ($u) { Write-Host ('URL: ' + $u) }
    $state = Wait-Ready
    if (-not $state) { Write-Host 'WARN 端口已监听，但管理 API 60s 内未就绪'; exit 1 }
    if ($state.setup.problem) { Write-Host ('setup    : ' + $state.setup.problem.place + '/' + $state.setup.problem.code); exit 3 }
    $bad = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' })
    if ($bad.Count -gt 0) { Write-Host ('health   : ' + (($bad | ForEach-Object { $_.Name }) -join ', ') + ' 报错（重启不修，需人处理）'); exit 2 }
    Write-Host 'ready    : setup ok, 无组件报错'
    exit 0
  }
  'stop' {
    if (-not (Test-Idle 'stop')) { exit 1 }
    # 手动停止标记：把人工 stop 与崩溃区分开，供 -RespectStop 的每小时检查遵守
    try {
      New-Item -ItemType File -Path $stopMarker -Force -ErrorAction Stop | Out-Null
      Set-Content -Path $stopMarker -Value (Get-Date).ToString('o') -Encoding utf8 -ErrorAction Stop
    } catch { Write-Host ('WARN 手动停止标记写入失败（不影响停止）: ' + $_.Exception.Message) }
    $p = Get-ServicePid
    if (-not $p) { Write-Host '未在运行 无存活 pid'; break }
    Write-Host ('STOPPING pid=' + $p + ' 会中断正在运行的 Executor 回合')
    Stop-Process -Id $p -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Test-Port)) { Start-Sleep -Seconds 1 }
    if (Test-Port) { Write-Host '端口仍在监听 请检查残留进程'; exit 1 }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $stateLock) { try { Remove-Item $stateLock -Recurse -Force -ErrorAction Stop; Write-Host 'CLEANED state lock' } catch { Write-Host ('WARN 无法清除 state lock（启动可能失败）: ' + $_.Exception.Message) } }
    Write-Host 'STOPPED'
    exit 0
  }
  'restart' {
    if ($RespectStop -and (Test-ManuallyStopped)) { Write-Host 'manually_stopped: true 按 -RespectStop 保持停止'; exit 1 }
    if (-not (Test-Idle 'restart')) { exit 1 }
    $p = Get-ServicePid
    if ($p) {
      Write-Host ('STOPPING pid=' + $p + ' (restart 不写手动停止标记)')
      Stop-Process -Id $p -Force
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline -and (Test-Port)) { Start-Sleep -Seconds 1 }
      if (Test-Port) { Write-Host '端口仍在监听 请检查残留进程'; exit 1 }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
      if (Test-Path $stateLock) { try { Remove-Item $stateLock -Recurse -Force -ErrorAction Stop; Write-Host 'CLEANED state lock' } catch { Write-Host ('WARN 无法清除 state lock（启动可能失败）: ' + $_.Exception.Message) } }
    } else { Write-Host '未在运行 直接启动' }
    Start-Sleep -Seconds 2
    & $PSCommandPath -Action start
    exit $LASTEXITCODE
  }
  'status' {
    $p = Get-ServicePid
    if ($p) { Write-Host ('pid      : ' + $p) } else { Write-Host 'pid      : none' }
    if (Test-Port) { Write-Host ('port ' + $port + ' : listening') } else { Write-Host ('port ' + $port + ' : closed') }
    if (Test-ManuallyStopped) { Write-Host 'stopped  : manually (start 会清除标记)' }
    $u = Get-TokenUrl
    if ($u) { Write-Host ('url      : ' + $u) }
    $state = Get-State
    if ($state) {
      if ($state.setup.problem) { Write-Host ('setup    : ' + $state.setup.problem.place + '/' + $state.setup.problem.code) } else { Write-Host 'setup    : ok' }
      $bad = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' })
      $warn = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'paused' })
      if ($bad.Count -eq 0) { Write-Host 'health   : no error entries' } else { Write-Host ('health   : ' + (($bad | ForEach-Object { $_.Name + '=' + $_.Value.detail }) -join '; ')) }
      if ($warn.Count -gt 0) { Write-Host ('paused   : ' + (($warn | ForEach-Object { $_.Name + '=' + $_.Value.detail }) -join '; ')) }
      Write-Host ('load     : running=' + $state.load.running + ' queued=' + $state.load.queued + ' maxWorkers=' + $state.load.maxWorkers + ' paused=' + $state.paused)
    } elseif (Test-Port) { Write-Host 'state    : ERR 管理 API 不可达' }
    $code = Get-StatusCode
    Write-Host ('exit     : ' + $code + ' (0 正常 / 1 未运行·不可达 / 2 组件报错 / 3 等 setup)')
    exit $code
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
