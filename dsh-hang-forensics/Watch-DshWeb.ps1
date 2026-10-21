#Requires -Version 7.0
<#
.SYNOPSIS
  dsh web 只观察看门狗：发现卡死自动取证，**不重启、不杀进程**。

.DESCRIPTION
  每 IntervalSeconds 秒探活一次 http://127.0.0.1:<Port>/。连续
  FailuresBeforeCapture 次拿不到任何 HTTP 响应，判定为卡死，立刻调用
  Capture-Hang.ps1 落一份现场快照，并打印醒目告警。

  健康后计数器自动归零（一次卡死只取一份证据，不会刷屏）。
  本脚本永不停止服务：止血动作仍由你用手册里的命令执行。

.PARAMETER Once
  只探一次就退出。返回值：0=健康，2=无响应。

.EXAMPLE
  # 常驻观察（另开一个 Windows Terminal 窗口）
  pwsh -File .\Watch-DshWeb.ps1

.EXAMPLE
  pwsh -File .\Watch-DshWeb.ps1 -Once
#>
[CmdletBinding()]
param(
	[int]$Port = 3080,
	[int]$IntervalSeconds = 15,
	[int]$FailuresBeforeCapture = 3,
	[int]$ProbeTimeoutMs = 6000,
	[switch]$Once,
	[string]$Dest = (Join-Path $env:USERPROFILE '.dsh\logs')
)

$ErrorActionPreference = 'Continue'
$captureScript = Join-Path $PSScriptRoot 'Capture-Hang.ps1'
$failures = 0
$capturedThisEpisode = $false

function Test-Probe {
	param([int]$TargetPort, [int]$TimeoutMs)
	$sw = [System.Diagnostics.Stopwatch]::StartNew()
	try {
		$handler = [System.Net.Http.HttpClientHandler]::new()
		$handler.UseProxy = $false
		$client = [System.Net.Http.HttpClient]::new($handler)
		$client.Timeout = [TimeSpan]::FromMilliseconds($TimeoutMs)
		$resp = $client.GetAsync("http://127.0.0.1:$TargetPort/").GetAwaiter().GetResult()
		$sw.Stop()
		$client.Dispose()
		return [pscustomobject]@{ ok = $true; status = [int]$resp.StatusCode; ms = $sw.ElapsedMilliseconds; error = $null }
	}
	catch {
		$sw.Stop()
		return [pscustomobject]@{ ok = $false; status = $null; ms = $sw.ElapsedMilliseconds; error = $_.Exception.GetBaseException().Message }
	}
}

function Write-Stamp {
	param([string]$Level, [string]$Text)
	$color = switch ($Level) { 'ok' { 'Green' } 'warn' { 'Yellow' } 'alert' { 'Red' } default { 'Gray' } }
	Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Text) -ForegroundColor $color
}

Write-Stamp 'info' "看门狗启动：探 127.0.0.1:$Port 每 ${IntervalSeconds}s，连续 $FailuresBeforeCapture 次失败即取证（不重启）"

while ($true) {
	$probe = Test-Probe -TargetPort $Port -TimeoutMs $ProbeTimeoutMs
	if ($probe.ok) {
		if ($failures -gt 0) { Write-Stamp 'ok' "服务恢复响应（HTTP $($probe.status)），失败计数归零" }
		elseif ($Once) { Write-Stamp 'ok' "健康：HTTP $($probe.status)，$($probe.ms)ms" }
		$failures = 0
		$capturedThisEpisode = $false
	}
	else {
		$failures += 1
		Write-Stamp 'warn' "探活失败 $failures/$FailuresBeforeCapture：$($probe.error)"
		if ($failures -ge $FailuresBeforeCapture -and -not $capturedThisEpisode) {
			Write-Stamp 'alert' '判定卡死 → 开始取证（不重启服务）'
			if (Test-Path -LiteralPath $captureScript) {
				try {
					& $captureScript -Port $Port -ProbeTimeoutMs $ProbeTimeoutMs -Dest $Dest
					$capturedThisEpisode = $true
					Write-Stamp 'alert' "取证完成。止血：Stop-Process -Id <PID> -Force，然后 Start-DshWeb-Inspect.ps1 重启。"
				}
				catch {
					Write-Stamp 'alert' "取证脚本失败: $($_.Exception.Message)"
				}
			}
			else {
				Write-Stamp 'alert' "找不到取证脚本：$captureScript"
			}
			$failures = 0
		}
	}

	if ($Once) {
		if ($probe.ok) { exit 0 } else { exit 2 }
	}
	Start-Sleep -Seconds $IntervalSeconds
}
