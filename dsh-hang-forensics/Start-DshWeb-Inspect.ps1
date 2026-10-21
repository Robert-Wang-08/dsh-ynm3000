#Requires -Version 7.0
<#
.SYNOPSIS
  以 --inspect 方式启动 dsh web，并把控制台输出同时落到日志文件。

.DESCRIPTION
  普通 `dsh web` 卡死后只剩一个空壳进程：Ctrl+C 不管用、控制台没留痕、
  拿不到 JS 调用栈。换成这个包装器启动后：

    1. Node inspector 开在 127.0.0.1:<CdpPort>；V8 的 inspector 线程独立于主线程，
       即使主线程被同步忙等打死，Capture-Hang.ps1 依然能抓到 CPU 热点函数与文件行。
    2. 控制台输出用 Tee 落到 $env:USERPROFILE\.dsh\logs\web-console-<时间戳>.log，
       卡死前的报错/告警不会随窗口一起消失。
    3. 端口默认只绑回环地址，不额外暴露。

  它不改变 dsh 的任何行为，只是换了启动入口 + 多一层留痕。

.PARAMETER Profile
  要启动的 profile 名，默认 web（等价于平时敲的 `dsh web`）。

.PARAMETER CdpPort
  inspector 端口，默认 9229。

.PARAMETER ExtraArgs
  追加给 profile 的参数（一般不需要）。

.PARAMETER DryRun
  只解析并打印将要执行的命令行，不真正启动。

.EXAMPLE
  pwsh -File .\Start-DshWeb-Inspect.ps1 -DryRun

.EXAMPLE
  pwsh -File .\Start-DshWeb-Inspect.ps1
#>
[CmdletBinding()]
param(
	[string]$Profile = 'web',
	[int]$Port = 3080,
	[int]$CdpPort = 9229,
	[string[]]$ExtraArgs = @(),
	[switch]$DryRun,
	[switch]$Force
)

$ErrorActionPreference = 'Stop'

# ── 1. 定位 dsh 的 bin.js ───────────────────────────────────────────────────
function Resolve-DshBin {
	$candidates = @()
	$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
	if ($nodeCmd) {
		$nodeDir = Split-Path -Parent $nodeCmd.Source
		$candidates += (Join-Path $nodeDir 'node_modules\@deepseek-ai\dsh\lib\bin.js')
	}
	$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
	if ($dshCmd -and $dshCmd.Source -like '*.js') { $candidates += $dshCmd.Source }
	$candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js')
	foreach ($c in $candidates) {
		if ($c -and (Test-Path -LiteralPath $c)) { return $c }
	}
	return $null
}

$bin = Resolve-DshBin
if (-not $bin) {
	Write-Host '[err] 找不到 @deepseek-ai/dsh 的 lib/bin.js，请改用：' -ForegroundColor Red
	Write-Host '      (Get-Command dsh).Source 查看 shim，或 node --inspect=127.0.0.1:9229 <bin.js> web' -ForegroundColor DarkGray
	exit 1
}

# ── 2. 端口占用检查（避免 EADDRINUSE 白启动）───────────────────────────────
$existing = @()
try {
	$existing = @(netstat -ano 2>$null | Select-String ":$Port\s" | Select-String 'LISTENING')
}
catch { }
if ($existing.Count -gt 0 -and ($DryRun -or $Force)) {
	$ownerPid = [int](($existing[0].ToString() -split '\s+')[-1])
	Write-Host "[warn] 端口 $Port 当前被 PID $ownerPid 占用（dry-run/force 下不阻断）。" -ForegroundColor Yellow
}
elseif ($existing.Count -gt 0) {
	$ownerPid = [int](($existing[0].ToString() -split '\s+')[-1])
	Write-Host "[err] 端口 $Port 已被 PID $ownerPid 占用。" -ForegroundColor Red
	Write-Host '      若是卡死的旧实例：先取证，再 Stop-Process 后重来：' -ForegroundColor DarkGray
	Write-Host "        pwsh -File .\Capture-Hang.ps1" -ForegroundColor DarkGray
	Write-Host "        Stop-Process -Id $ownerPid -Force" -ForegroundColor DarkGray
	exit 2
}

# ── 3. 组装命令行 ───────────────────────────────────────────────────────────
$nodeArgs = @("--inspect=127.0.0.1:$CdpPort", $bin, $Profile) + $ExtraArgs
$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
$logFile = Join-Path $logDir ("web-console-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Host '启动命令：' -ForegroundColor Cyan
Write-Host ("  node " + ($nodeArgs -join ' ')) -ForegroundColor DarkGray
Write-Host "控制台日志：$logFile" -ForegroundColor DarkGray
Write-Host "Inspector：http://127.0.0.1:$CdpPort/json/list" -ForegroundColor DarkGray
Write-Host ''

if ($DryRun) {
	Write-Host '[dry-run] 未真正启动。' -ForegroundColor Yellow
	exit 0
}

if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# 窗口与文件同时输出；落盘前把访问令牌脱敏（dsh web 会把 ?token=... 打到 stdout，
# 原样进日志等于把可操作你本机 GUI 的凭据留在磁盘上）。
# 进程仍在前台，窗口关掉等于停服务。
$writer = [System.IO.StreamWriter]::new($logFile, $false, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
	& node @nodeArgs 2>&1 | ForEach-Object {
		$line = [string]$_
		$safe = $line -replace '([?&]token=)[^&\s]+', '$1***REDACTED***'
		$writer.WriteLine($safe)
		Write-Host $safe
	}
}
finally {
	$writer.Dispose()
}
$code = $LASTEXITCODE
Write-Host "dsh web 已退出（exit $code）。日志：$logFile" -ForegroundColor $(if ($code -eq 0) { 'Green' } else { 'Yellow' })
exit $code
