#Requires -Version 7.0
<#
  DSH 运维台：健康检查 + 只补起缺失服务的统一入口。
  只启动「确实没在监听」的组件；绝不重启已健康的服务，不碰正在跑的会话。
    pwsh -NoProfile -File dsh-ops-gate.ps1            # 检查并按需补起（桌面默认）
    pwsh -NoProfile -File dsh-ops-gate.ps1 -CheckOnly # 只看不改
#>
[CmdletBinding()]
param([switch]$CheckOnly,[switch]$NoPause,[switch]$NoOpen)
$ErrorActionPreference='Continue'
$root = $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ('dsh-ops-gate-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$rows = [System.Collections.Generic.List[object]]::new()
function Note([string]$line){ Add-Content -LiteralPath $log -Value $line -Encoding utf8 }
function Add-Row([string]$name,[string]$state,[string]$detail){ $rows.Add([pscustomobject]@{Component=$name;State=$state;Detail=$detail}); Note ($name + [char]9 + $state + [char]9 + $detail) }
function Test-Port([int]$port){ try { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } catch { return $false } }
$mutex = [Threading.Mutex]::new($false,"Global\DSH-OpsGate")
$held = $false
try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
if (-not $held) { Write-Host "已有运维台在运行，本窗口不再重复操作。"; if(-not $NoPause){Read-Host "按回车关闭" | Out-Null}; exit 0 }
try {
  Write-Host ""
  Write-Host ("  DSH 运维台  " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -ForegroundColor Cyan
  Write-Host ("  日志：" + $log) -ForegroundColor DarkGray
  Write-Host ""
  $maint = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -match "/dsh/lib/bin\.js plugin" -or $_.CommandLine -match "pnpm (add|install|remove)") })
  if ($maint.Count -gt 0) { Add-Row "维护守卫" "BLOCKED" ("检测到 profile 维护进程 pid=" + (($maint | ForEach-Object ProcessId) -join ",")) }
  if (Test-Port 3080) { Add-Row "DSH web (3080)" "OK" "已在监听" }
  else {
    Add-Row "DSH web (3080)" "DOWN" "未监听"
    if (-not $CheckOnly -and $maint.Count -eq 0) {
      $bash = "C:\Program Files\Git\bin\bash.exe"
      if (Test-Path $bash) {
        $posix = ($root -replace "\\","/") -replace "^([A-Za-z]):","/$1"
        Start-Process -FilePath $bash -ArgumentList @("-lc", ("exec " + $posix + "/webprofile.sh")) -WindowStyle Hidden
        Add-Row "DSH web (3080)" "STARTING" "已通过 webprofile.sh 拉起"
      } else { Add-Row "DSH web (3080)" "MANUAL" "缺少 Git Bash，请手动启动" }
    }
  }
  if (Test-Port 3082) { Add-Row "superagent (3082)" "OK" "已在监听" }
  else {
    Add-Row "superagent (3082)" "DOWN" "未监听"
    if (-not $CheckOnly -and $maint.Count -eq 0) {
      $r = & pwsh -NoProfile -File (Join-Path $root "dsh-superagent-service.ps1") start 2>&1 | Out-String
      $last = ($r.Trim() -split "\r?\n" | Select-Object -Last 1)
      if (Test-Port 3082) { Add-Row "superagent (3082)" "STARTED" $last } else { Add-Row "superagent (3082)" "FAILED" $last }
    }
  }
  if (Test-Port 3083) { Add-Row "sa-local (3083)" "OK" "已在监听" }
  else {
    Add-Row "sa-local (3083)" "DOWN" "未监听"
    if (-not $CheckOnly -and $maint.Count -eq 0) {
      $r = & pwsh -NoProfile -File (Join-Path $root "dsh-sa-local-service.ps1") start 2>&1 | Out-String
      $last = ($r.Trim() -split "\r?\n" | Select-Object -Last 1)
      if (Test-Port 3083) { Add-Row "sa-local (3083)" "STARTED" $last } else { Add-Row "sa-local (3083)" "FAILED" $last }
    }
  }
  $beatFile = Join-Path $root "dsh-wechat-hitl\state\feishu-daemon.json"
  $beat = $null
  if (Test-Path $beatFile) { try { $beat = Get-Content $beatFile -Raw | ConvertFrom-Json } catch {} }
  if ($beat) {
    $age = ((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$beat.tickAt).LocalDateTime).TotalSeconds
    $alive = [bool](Get-Process -Id $beat.pid -ErrorAction SilentlyContinue)
    if ($alive -and $age -le 30 -and $beat.inbound -eq "running") { Add-Row "飞书 daemon" "OK" ("pid=" + $beat.pid + " inbound=running age=" + [math]::Round($age) + "s") }
    else { Add-Row "飞书 daemon" "DEGRADED" ("pid=" + $beat.pid + " alive=" + $alive + " inbound=" + $beat.inbound + " age=" + [math]::Round($age) + "s；由 5 分钟监督任务处置，本入口不重启") }
  } else { Add-Row "飞书 daemon" "UNKNOWN" "心跳文件缺失（不在此处盲启）" }
  foreach ($t in "DSH-Feishu-Supervisor","DSH-Superagent-Health","DSH-Git-Watchdog") {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) { $info = Get-ScheduledTaskInfo -TaskName $t -ErrorAction SilentlyContinue; $label = "OK"; if ([string]$task.State -notin @("Ready","Running")) { $label = [string]$task.State }; Add-Row ("任务 " + $t) $label ("state=" + [string]$task.State + " last=" + $info.LastRunTime + " result=" + $info.LastTaskResult) }
    else { Add-Row ("任务 " + $t) "MISSING" "未注册" }
  }
  Write-Host ""
  $rows | Format-Table -AutoSize -Wrap | Out-String -Width 150 | Write-Host
  $bad = @($rows | Where-Object { $_.State -ne "OK" })
  if ($bad.Count -eq 0) { Write-Host "  全部正常。" -ForegroundColor Green } else { Write-Host ("  需关注 " + $bad.Count + " 项（见上表与日志）。") -ForegroundColor Yellow }
  if (-not $NoOpen -and (Test-Port 3080)) { Start-Process "http://127.0.0.1:3080/" }
}
finally {
  Note "---"
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if (-not $NoPause) { Read-Host "按回车关闭" | Out-Null }
}