<#
.SYNOPSIS
给 sa-local 的 dsh-superagent fork 打 Windows CLI 探测补丁（幂等）。

.DESCRIPTION
上游用 POSIX `env` 前缀探测 gh/lark-cli 账号（`env PATH=... env VAR=... cli`），Windows 上必然失败。
本脚本把安装产物里的两处改成 win32 分支：
  1) workerProbe：win32 直接 runAsWorker(subprocess, argv, ...)，不加 env 前缀；
  2) resolveFeishuBot 的 run：win32 直接 probe([cli, ...args])，变量写进 process.env。
重装 fork（换 tgz）会覆盖补丁，重跑本脚本即可。执行前会备份原文件。
#>
[CmdletBinding()]
param([string]$Profile = 'sa-local')

$ErrorActionPreference = 'Stop'
$lib = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile + '\node_modules\dsh-superagent\lib')
$file = Get-ChildItem $lib -Filter 'poll-*.js' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $file) { throw ('找不到 fork 的 lib: ' + $lib) }
$text = Get-Content $file.FullName -Raw
if ($text -match 'windows \? argv') { Write-Host ('ALREADY PATCHED: ' + $file.Name); exit 0 }

$oldProbe = @'
function workerProbe(subprocess, stateDir, cwd, signal) {
	const path = withoutDirectory(process.env.PATH ?? "", workerBin(stateDir));
	return (argv) => runAsWorker(subprocess, [
		"env",
		`PATH=${path}`,
		...argv
	], cwd, AbortSignal.any([signal, AbortSignal.timeout(6e4)]));
}
'@
$newProbe = @'
function workerProbe(subprocess, stateDir, cwd, signal) {
	const path = withoutDirectory(process.env.PATH ?? "", workerBin(stateDir));
	const windows = process.platform === "win32";
	return (argv) => runAsWorker(subprocess, windows ? argv : [
		"env",
		`PATH=${path}`,
		...argv
	], cwd, AbortSignal.any([signal, AbortSignal.timeout(6e4)]));
}
'@
if (-not $text.Contains($oldProbe)) { throw '未匹配到 workerProbe 原文（fork 版本可能变了），请人工核对 lib' }
$text = $text.Replace($oldProbe, $newProbe)

$oldRun = @'
	const run = (...args) => probe([
		"env",
		"LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1",
		"LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1",
		cli,
		...args
	]).catch(fail);
'@
$newRun = @'
	const windows = process.platform === "win32";
	if (windows) {
		process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = "1";
		process.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
	}
	const run = (...args) => probe(windows ? [
		cli,
		...args
	] : [
		"env",
		"LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1",
		"LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1",
		cli,
		...args
	]).catch(fail);
'@
if (-not $text.Contains($oldRun)) { throw '未匹配到 resolveFeishuBot run 原文，请人工核对 lib' }
$text = $text.Replace($oldRun, $newRun)

$bak = $file.FullName + '.bak-before-win32probe-' + (Get-Date -Format 'yyyyMMddTHHmmssZ')
Copy-Item $file.FullName $bak -Force
[System.IO.File]::WriteAllText($file.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('PATCHED: ' + $file.FullName)
Write-Host ('BACKUP : ' + $bak)
Write-Host 'NEXT   : pwsh -File dsh-sa-local-service.ps1 stop; pwsh -File dsh-sa-local-service.ps1 start'
