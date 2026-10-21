#Requires -Version 7.0
<#
.SYNOPSIS
  dsh web 卡死现场取证（只采集，不重启、不杀进程）。

.DESCRIPTION
  在 web 页面无响应时运行本脚本，它会把判定"到底是主线程被打死还是内存被打爆"
  所需的证据一次性落到一个目录里：

    - HTTP 探活结果与耗时（区分 timeout / refused / 401）
    - 3080 端口属主 PID、启动时间、CPU、私有内存、句柄、线程状态分布
    - CPU 采样（按单核百分比），用于区分"忙等"与"阻塞在非 CPU 路径"
    - 系统内存/提交量计数器
    - netstat 全量端口状态（连了多少 ESTABLISHED / TIME_WAIT）
    - 进程树（能取到 CIM 时）
    - 最近活动的 dsh 会话尾巴（哪个会话哪个回合在飞、最后一步做了什么）
    - 若进程以 --inspect 启动：V8 CPU profile + 主线程探活 + 热点函数 Top 30
    - 可选：进程 minidump（-WithDump，体积大）

  产出目录下 summary.md 是给人看的一页结论。

.PARAMETER Port
  dsh web 的监听端口，默认 3080。

.PARAMETER CdpPort
  Node inspector 端口，默认 9229（只有用 Start-DshWeb-Inspect.ps1 启动时才有）。

.PARAMETER Dest
  产物根目录，默认 $env:USERPROFILE\.dsh\logs（每次自动建 hang-<时间戳> 子目录）。

.EXAMPLE
  pwsh -File .\Capture-Hang.ps1

.EXAMPLE
  # 服务是带 inspector 启动的，连 JS 热点一起抓，并留一份 dump
  pwsh -File .\Capture-Hang.ps1 -WithDump
#>
[CmdletBinding()]
param(
	[int]$Port = 3080,
	[int]$CdpPort = 9229,
	[int]$ProbeTimeoutMs = 4000,
	[int]$CpuSampleSeconds = 3,
	[int]$ActiveSessionMinutes = 30,
	[switch]$WithDump,
	[string]$Dest = (Join-Path $env:USERPROFILE '.dsh\logs')
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = Join-Path $Dest "hang-$stamp"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$libDir = Join-Path $PSScriptRoot 'lib'

function Save-Json {
	param([string]$Name, $Object)
	$path = Join-Path $dir $Name
	try {
		$Object | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
	}
	catch {
		"序列化失败: $($_.Exception.Message)" | Set-Content -LiteralPath $path -Encoding utf8
	}
	return $path
}

function Write-Step {
	param([string]$Text)
	Write-Host "  · $Text" -ForegroundColor DarkGray
}

Write-Host "dsh 卡死取证 → $dir" -ForegroundColor Cyan

# ── 1. HTTP 探活 ─────────────────────────────────────────────────────────────
function Invoke-Probe {
	param([int]$TargetPort, [int]$TimeoutMs)
	$sw = [System.Diagnostics.Stopwatch]::StartNew()
	$out = [ordered]@{
		url     = "http://127.0.0.1:$TargetPort/"
		timeout = $TimeoutMs
		ok      = $false
		kind    = $null
		status  = $null
		ms      = $null
		error   = $null
	}
	try {
		$handler = [System.Net.Http.HttpClientHandler]::new()
		$handler.UseProxy = $false
		$client = [System.Net.Http.HttpClient]::new($handler)
		$client.Timeout = [TimeSpan]::FromMilliseconds($TimeoutMs)
		$task = $client.GetAsync($out.url)
		$resp = $task.GetAwaiter().GetResult()
		$out.ok = $true
		$out.kind = 'http'
		$out.status = [int]$resp.StatusCode
		$client.Dispose()
	}
	catch {
		$msg = $_.Exception.GetBaseException().Message
		$out.error = $msg
		if ($msg -match 'canceled|cancelled|timeout|超时') { $out.kind = 'timeout' }
		elseif ($msg -match 'refused|拒绝|actively refused') { $out.kind = 'refused' }
		else { $out.kind = 'error' }
	}
	$sw.Stop()
	$out.ms = $sw.ElapsedMilliseconds
	return [pscustomobject]$out
}

Write-Step "HTTP 探活 127.0.0.1:$Port"
$probe = Invoke-Probe -TargetPort $Port -TimeoutMs $ProbeTimeoutMs
Save-Json 'probe.json' $probe | Out-Null
$probeLine = if ($probe.ok) { "HTTP $($probe.status)（$($probe.ms)ms）" } else { "无响应：$($probe.kind)（$($probe.ms)ms）$($probe.error)" }
Write-Host "    探活结果：$probeLine" -ForegroundColor $(if ($probe.ok) { 'Green' } else { 'Red' })

# ── 2. 端口属主 ─────────────────────────────────────────────────────────────
Write-Step '解析端口属主'
$netstatRaw = @()
$ownerPid = $null
try {
	$netstatRaw = netstat -ano 2>$null
	$listen = $netstatRaw | Select-String ":$Port\s" | Select-String 'LISTENING' | Select-Object -First 1
	if ($listen) {
		$ownerPid = [int](($listen.ToString() -split '\s+')[-1])
	}
}
catch {
	Write-Host "    netstat 失败: $($_.Exception.Message)" -ForegroundColor Yellow
}
"端口 $Port 属主 PID: $ownerPid" | Write-Host
$netstatRaw | Set-Content -LiteralPath (Join-Path $dir 'netstat.txt') -Encoding utf8

# ── 3. 进程指标 + CPU 采样 ──────────────────────────────────────────────────
$procInfo = $null
$cpuSample = $null
if ($ownerPid) {
	Write-Step "进程指标（PID $ownerPid，CPU 采样 ${CpuSampleSeconds}s）"
	try {
		$p1 = Get-Process -Id $ownerPid -ErrorAction Stop
		$c1 = $p1.CPU
		$sw = [System.Diagnostics.Stopwatch]::StartNew()
		Start-Sleep -Seconds $CpuSampleSeconds
		$p2 = Get-Process -Id $ownerPid -ErrorAction Stop
		$c2 = $p2.CPU
		$sw.Stop()
		$elapsed = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
		$deltaCpu = [Math]::Max(($c2 - $c1), 0)
		$cores = [Environment]::ProcessorCount
		$threadStates = @()
		try {
			$threadStates = @($p2.Threads | Group-Object { $_.ThreadState } | ForEach-Object { [pscustomobject]@{ state = "$($_.Name)"; count = $_.Count } })
		}
		catch { }
		$procInfo = [pscustomobject]@{
			pid              = $ownerPid
			name             = $p2.ProcessName
			startTime        = $p2.StartTime
			uptimeMinutes    = [Math]::Round(((Get-Date) - $p2.StartTime).TotalMinutes, 1)
			cpuSecondsTotal  = $c2
			workingSetMB     = [Math]::Round($p2.WorkingSet64 / 1MB, 1)
			privateMB        = [Math]::Round($p2.PrivateMemorySize64 / 1MB, 1)
			handleCount      = $p2.HandleCount
			threadCount      = $p2.Threads.Count
			threadStates     = $threadStates
		}
		$cpuSample = [pscustomobject]@{
			windowSeconds      = [Math]::Round($elapsed, 2)
			cpuSecondsConsumed = [Math]::Round($deltaCpu, 2)
			percentOfOneCore   = [Math]::Round(($deltaCpu / $elapsed) * 100, 1)
			percentOfAllCores  = [Math]::Round((($deltaCpu / $elapsed) * 100) / $cores, 1)
			coreCount          = $cores
		}
		Write-Host "    CPU：单核 $($cpuSample.percentOfOneCore)% / 全机 $($cpuSample.percentOfAllCores)%   私有内存 $($procInfo.privateMB)MB   线程 $($procInfo.threadCount)   句柄 $($procInfo.handleCount)" -ForegroundColor $(if ($cpuSample.percentOfOneCore -ge 60) { 'Yellow' } else { 'DarkGray' })
	}
	catch {
		Write-Host "    进程指标失败: $($_.Exception.Message)" -ForegroundColor Yellow
		$procInfo = [pscustomobject]@{ pid = $ownerPid; error = $_.Exception.Message }
	}
	Save-Json 'process.json' $procInfo | Out-Null
	Save-Json 'cpu-sample.json' $cpuSample | Out-Null
}
else {
	Write-Host '    未找到监听该端口的进程（服务可能已经退出）' -ForegroundColor Yellow
}

# ── 4. 系统内存 ─────────────────────────────────────────────────────────────
Write-Step '系统内存计数器'
$mem = [ordered]@{}
foreach ($c in @('\Memory\Available MBytes', '\Memory\Committed Bytes', '\Memory\Commit Limit', '\Memory\% Committed Bytes In Use')) {
	try {
		$v = (Get-Counter $c -ErrorAction Stop).CounterSamples[0].CookedValue
		$mem[$c] = [Math]::Round($v, 1)
	}
	catch {
		$mem[$c] = "不可用：$($_.Exception.Message)"
	}
}
Save-Json 'memory.json' $mem | Out-Null
$commitPct = $mem['\Memory\% Committed Bytes In Use']
if ($commitPct -is [double]) {
	Write-Host "    可用 $($mem['\Memory\Available MBytes'])MB   提交占用 $commitPct%" -ForegroundColor $(if ($commitPct -ge 85) { 'Yellow' } else { 'DarkGray' })
}

# ── 5. 进程树 ───────────────────────────────────────────────────────────────
Write-Step '进程树'
try {
	$all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name, @{n = 'WS_MB'; e = { [Math]::Round($_.WorkingSetSize / 1MB, 1) } }, CreationDate)
	$all | Export-Csv -LiteralPath (Join-Path $dir 'process-tree.csv') -NoTypeInformation -Encoding utf8
	$nodeProcs = @($all | Where-Object { $_.Name -like 'node*' })
	$nodeProcs | Format-Table -AutoSize | Out-String -Width 200 | Set-Content -LiteralPath (Join-Path $dir 'node-processes.txt') -Encoding utf8
	Write-Host "    node 进程 $($nodeProcs.Count) 个（含日志残留的旧实例即可判断是否重复常驻）"
}
catch {
	"进程树不可用（沙箱/权限）：$($_.Exception.Message)" | Set-Content -LiteralPath (Join-Path $dir 'process-tree.txt') -Encoding utf8
	Write-Host '    进程树不可用（权限/沙箱），已记录原因' -ForegroundColor DarkYellow
}

# ── 6. 活动会话尾巴 ─────────────────────────────────────────────────────────
Write-Step "活动会话尾巴（最近 $ActiveSessionMinutes 分钟）"
$sessionReport = Join-Path $dir 'active-sessions.txt'
if (Test-Path -LiteralPath (Join-Path $libDir 'session-tails.mjs')) {
	try {
		& node (Join-Path $libDir 'session-tails.mjs') $ActiveSessionMinutes 8 2>&1 | Set-Content -LiteralPath $sessionReport -Encoding utf8
		$openTurns = @(Select-String -LiteralPath $sessionReport -Pattern '回合未闭合' -ErrorAction SilentlyContinue).Count
		Write-Host "    已记录（含未闭合回合的会话 $openTurns 个）"
	}
	catch {
		"会话解析失败: $($_.Exception.Message)" | Set-Content -LiteralPath $sessionReport -Encoding utf8
	}
}
else {
	"缺少 $libDir\session-tails.mjs" | Set-Content -LiteralPath $sessionReport -Encoding utf8
}

# ── 7. 控制台日志（若用 Start-DshWeb-Inspect.ps1 启动）────────────────────
$consoleLog = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.dsh\logs') -Filter 'web-console-*.log' -ErrorAction SilentlyContinue |
	Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($consoleLog) {
	$tailPath = Join-Path $dir 'web-console-tail.txt'
	try {
		Get-Content -LiteralPath $consoleLog.FullName -Tail 300 -ErrorAction Stop | Set-Content -LiteralPath $tailPath -Encoding utf8
		Write-Host "    控制台日志尾 300 行 ← $($consoleLog.Name)"
	}
	catch {
		Write-Host "    控制台日志读取失败: $($_.Exception.Message)" -ForegroundColor Yellow
	}
}

# ── 8. Node Inspector（--inspect 启动时才有）────────────────────────────────
$inspectorDir = Join-Path $dir 'inspector'
$inspectorAvailable = $false
try {
	$tcp = [System.Net.Sockets.TcpClient]::new()
	$connect = $tcp.ConnectAsync('127.0.0.1', $CdpPort)
	$inspectorAvailable = $connect.Wait(800) -and $tcp.Connected
	$tcp.Dispose()
}
catch { $inspectorAvailable = $false }

if ($inspectorAvailable) {
	Write-Step "Node Inspector 取证（端口 $CdpPort）"
	New-Item -ItemType Directory -Path $inspectorDir -Force | Out-Null
	try {
		$heap = if ($WithDump) { @('--heap') } else { @() }
		& node (Join-Path $libDir 'cdp-profile.mjs') --port $CdpPort --out $inspectorDir --seconds 5 @heap 2>&1 |
			Set-Content -LiteralPath (Join-Path $inspectorDir 'cdp.log') -Encoding utf8
		$topFile = Join-Path $inspectorDir 'cpu-profile-top.txt'
		if (Test-Path -LiteralPath $topFile) {
			Write-Host '    CPU 热点（前 5）:' -ForegroundColor Yellow
			Get-Content -LiteralPath $topFile -TotalCount 7 | Select-Object -Skip 2 | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
		}
	}
	catch {
		"inspector 取证失败: $($_.Exception.Message)" | Set-Content -LiteralPath (Join-Path $inspectorDir 'error.txt') -Encoding utf8
	}
}
else {
	Write-Host "    inspector 端口 $CdpPort 未开放 → 拿不到 JS 侧证据（需要用 Start-DshWeb-Inspect.ps1 启动）" -ForegroundColor DarkYellow
}

# ── 9. 可选 minidump ───────────────────────────────────────────────────────
if ($WithDump -and $ownerPid) {
	Write-Step '进程 minidump'
	$dump = Join-Path $dir "dsh-$ownerPid.dmp"
	try {
		$r = Start-Process -FilePath 'rundll32.exe' -ArgumentList "comsvcs.dll, MiniDump $ownerPid $dump full" -Wait -PassThru -WindowStyle Hidden
		if (Test-Path -LiteralPath $dump) {
			Write-Host "    dump: $dump ($([Math]::Round((Get-Item $dump).Length / 1MB, 1))MB)"
		}
		else {
			"minidump 未能生成（exit $($r.ExitCode)），通常需要管理员权限" | Set-Content -LiteralPath (Join-Path $dir 'dump-error.txt') -Encoding utf8
			Write-Host '    dump 失败（多半需要管理员权限）' -ForegroundColor Yellow
		}
	}
	catch {
		Write-Host "    dump 失败: $($_.Exception.Message)" -ForegroundColor Yellow
	}
}

# ── 10. 结论 ───────────────────────────────────────────────────────────────
$verdict = [System.Collections.Generic.List[string]]::new()
if (-not $probe.ok) {
	$verdict.Add("服务 HTTP 层无响应（$($probe.kind)）——后端主线程已被打死，不是前端问题。")
	if ($cpuSample) {
		if ($cpuSample.percentOfOneCore -ge 60) {
			$verdict.Add("同时 CPU 单核占用 $($cpuSample.percentOfOneCore)% → 主线程在**同步忙等**（JS 死循环 / 大循环 / 同步解析大对象）。这也是「Ctrl+C 杀不掉」的典型指纹：SIGINT 处理要回到主线程才跑得起来。")
		}
		elseif ($cpuSample.percentOfOneCore -lt 20) {
			$verdict.Add("同时 CPU 单核占用仅 $($cpuSample.percentOfOneCore)% → 主线程阻塞在**非 CPU 路径**（同步 I/O、锁、GC、await 悬挂）。")
		}
		else {
			$verdict.Add("CPU 单核占用 $($cpuSample.percentOfOneCore)% 属中间态 → 可能是 GC 抖动或大量微任务排队，结合 inspector 热点判断。")
		}
	}
	if (-not $inspectorAvailable) {
		$verdict.Add('进程未以 --inspect 启动，本次拿不到 JS 调用栈/热点；下次请用 Start-DshWeb-Inspect.ps1 启动，卡死时可精确定位到函数与文件行。')
	}
}
else {
	$verdict.Add("探活正常（HTTP $($probe.status)）——此刻未捕获到卡死；本快照可作为基线对比。")
}
if ($commitPct -is [double] -and $commitPct -ge 85) {
	$verdict.Add("系统提交内存已到 $commitPct%，内存/交换压力会放大主线程停顿，需要检查是否同时开了多个重会话。")
}

$summary = @(
	"# dsh web 卡死取证报告"
	''
	"- 采集时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
	"- 探活：$probeLine"
	"- PID：$ownerPid"
	if ($procInfo -and $procInfo.startTime) { "- 进程启动：$($procInfo.startTime)（已运行 $($procInfo.uptimeMinutes) 分钟）" }
	if ($procInfo -and $procInfo.privateMB) { "- 私有内存：$($procInfo.privateMB) MB；工作集：$($procInfo.workingSetMB) MB；线程：$($procInfo.threadCount)；句柄：$($procInfo.handleCount)" }
	if ($cpuSample) { "- CPU：单核 $($cpuSample.percentOfOneCore)% / 全机 $($cpuSample.percentOfAllCores)%（$($cpuSample.coreCount) 核）" }
	if ($commitPct -is [double]) { "- 系统提交占用：$commitPct% ；可用内存：$($mem['\Memory\Available MBytes']) MB" }
	"- Inspector：$(if ($inspectorAvailable) { "已取证（端口 $CdpPort）" } else { "不可用（未以 --inspect 启动）" })"
	''
	'## 判读'
	''
	($verdict | ForEach-Object { "- $_" })
	''
	'## 产物'
	''
	'| 文件 | 内容 |'
	'| --- | --- |'
	'| probe.json | HTTP 探活结果 |'
	'| process.json / cpu-sample.json | 进程指标与 CPU 采样 |'
	'| memory.json | 系统内存计数器 |'
	'| netstat.txt | 全量端口状态 |'
	'| active-sessions.txt | 最近活动会话尾巴 |'
	'| inspector/ | 存在时含 cpu-profile.json 与 hotspots |'
	''
	'## 下一步'
	''
	'1. 若确认主线程忙等：把 inspector/ 里的热点函数作为嫌疑插件，回滚或禁用后重启验证。'
	'2. 若 CPU 很低：怀疑同步 I/O 或锁，检查 web profile 中 `patchReload: live` 与文件监视类插件。'
	"3. 止血：Stop-Process -Id $ownerPid -Force（Ctrl+C 无效时这是唯一路径），再用 Start-DshWeb-Inspect.ps1 重启。"
) -join "`n"
$summary | Set-Content -LiteralPath (Join-Path $dir 'summary.md') -Encoding utf8

Write-Host ''
Write-Host "结论：" -ForegroundColor Cyan
$verdict | ForEach-Object { Write-Host "  - $_" -ForegroundColor $(if ($probe.ok) { 'Green' } else { 'Yellow' }) }
Write-Host ''
Write-Host "产物目录：$dir" -ForegroundColor Cyan
Write-Host "摘要：$(Join-Path $dir 'summary.md')" -ForegroundColor DarkGray
