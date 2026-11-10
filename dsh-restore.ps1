#!/usr/bin/env pwsh
<#
.SYNOPSIS
  DSH 一键恢复 v1.0.0 —— 从「DSH 收口备份」的 bundle 恢复全部 profile（默认只出计划）。

.DESCRIPTION
  「DSH 收口备份」在 %USERPROFILE%\.dsh\backups 下产出 dsh-backup-<时间戳>\（bundle = 多 profile）。
  本脚本是它在目标机上的对称入口：

    pwsh -NoProfile -File .\dsh-restore.ps1
      自动选最新 bundle，只打印恢复计划（不写 profile）。

    pwsh -NoProfile -File .\dsh-restore.ps1 -Snapshot <bundle 目录> -Apply -AllowPartial
      先逐 profile 写 pre-restore 安全快照，再写回。

  底层仍调用 dsh-config-pack/scripts/dsh-backup.ps1（verify → pre-restore → 逐 profile 写回），
  本脚本只补三件事：自动定位最新 bundle；写回前做跨机路径体检（link: 依赖指向的目录是否存在）；
  写回后打印验收步骤。不重复实现快照引擎，也不接受单 profile 快照（那走配置包入口）。

.PARAMETER Snapshot
  bundle 目录（含 bundle.json）。省略时取 <DSH_HOME>\backups 下最新的 dsh-backup-*。

.PARAMETER Apply
  真正写回。省略时只打印计划。

.PARAMETER AllowPartial
  备份默认不请求隔离安装演练，bundle 内 profile 是 partial；写回必须显式带上本开关。

.PARAMETER AcceptEngineDrift
  引擎预检为 drift 时的人工确认，透传给配置包入口。conflict 一律拒绝恢复（无豁免）。

.PARAMETER List
  只列出本机可用的 bundle（时间、profile 数、默认 profile），不执行恢复。

.PARAMETER BackupScript
  dsh-config-pack 的 dsh-backup.ps1 路径。省略时依次读 $env:DSH_BACKUP_SCRIPT、
  本仓库 dsh-config-pack\scripts\dsh-backup.ps1、已安装的 dsh-backup-restore skill。

.PARAMETER DshHome
  目标 DSH 根，透传 -DshHome。省略时用 $env:DSH_HOME，再回落到 %USERPROFILE%\.dsh。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-restore.ps1
  选最新 bundle，打印计划。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-restore.ps1 -List
  看看有哪些 bundle 可用。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-restore.ps1 -Snapshot D:\backup\dsh-backup-20261109-014007 -Apply -AllowPartial
  另一台机器上的一键恢复（先停掉目标机 dsh web）。

.NOTES
  与「DSH 收口备份」成对：备份在 docs/ops/一键提交与备份.md 第 2 节，跨机安装在
  docs/bootstrap/PROMPT-新设备装机-引导.md 第 5b 步。
#>
[CmdletBinding()]
param(
	[string]$Snapshot = '',
	[switch]$Apply,
	[switch]$AllowPartial,
	[switch]$AcceptEngineDrift,
	[switch]$List,
	[string]$BackupScript = '',
	[string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$ScriptVersion = '1.0.0'

function Write-Head { param([string]$Text) Write-Host ''; Write-Host "──── $Text ────" -ForegroundColor Cyan }
function Write-Info { param([string]$Text) Write-Host "  $Text" }
function Write-Ok   { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Err  { param([string]$Text) Write-Host "  [err] $Text" -ForegroundColor Red }

# DSH 根：-DshHome → DSH_HOME → %USERPROFILE%\.dsh（与配置包入口同源）
$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath('UserProfile') }
$DshRoot = if (-not [string]::IsNullOrWhiteSpace($DshHome)) { [IO.Path]::GetFullPath($DshHome) }
	elseif ($env:DSH_HOME) { [IO.Path]::GetFullPath($env:DSH_HOME) }
	else { Join-Path $UserHome '.dsh' }
$BackupRoot = Join-Path $DshRoot 'backups'

function Resolve-BackupScript {
	if (-not [string]::IsNullOrWhiteSpace($BackupScript)) { return $BackupScript }
	if (-not [string]::IsNullOrWhiteSpace($env:DSH_BACKUP_SCRIPT)) { return $env:DSH_BACKUP_SCRIPT }
	# 配置包入口排第一：自带 snapshot.mjs，本机没把 config-pack 装进 profile 时也能恢复。
	$pack = Join-Path $PSScriptRoot 'dsh-config-pack\scripts\dsh-backup.ps1'
	if (Test-Path -LiteralPath $pack) { return $pack }
	$skill = Join-Path $UserHome '.agents\skills\dsh-backup-restore\scripts\dsh-backup.ps1'
	if (Test-Path -LiteralPath $skill) { return $skill }
	return $pack
}

function Get-Bundles {
	if (-not (Test-Path -LiteralPath $BackupRoot)) { return @() }
	return @(Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'dsh-backup-*' -ErrorAction SilentlyContinue |
		Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bundle.json') } |
		Sort-Object LastWriteTime -Descending)
}

function Read-Bundle {
	param([string]$Dir)
	$p = Join-Path $Dir 'bundle.json'
	if (-not (Test-Path -LiteralPath $p)) {
		throw "不是多 profile bundle（缺 bundle.json）：$Dir`n单 profile 快照请直接用 dsh-config-pack\scripts\dsh-backup.ps1 restore -Snapshot <目录>。"
	}
	$b = Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json
	if ([string]$b.schema -ne 'dsh-backup-bundle/v1') { throw "bundle schema 不兼容：$([string]$b.schema)" }
	return $b
}

# ── -List ───────────────────────────────────────────────────────────────────
if ($List) {
	$bundles = Get-Bundles
	if ($bundles.Count -eq 0) { Write-Warn2 "没有可用 bundle：$BackupRoot"; exit 0 }
	Write-Head '可用 bundle（新 → 旧）'
	$rows = foreach ($b in $bundles) {
		$info = $null
		try { $info = Read-Bundle -Dir $b.FullName } catch { }
		[pscustomobject]@{
			'目录'        = $b.Name
			'创建时间'    = $(if ($info) { ([datetime]$info.created_at).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } else { $b.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') })
			'profile 数'  = $(if ($info) { @($info.profiles | Where-Object { $_.status -eq 'ok' }).Count } else { '?' })
			'默认 profile' = $(if ($info) { [string]$info.default_profile } else { '?' })
		}
	}
	$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
	exit 0
}

# ── 定位 bundle ─────────────────────────────────────────────────────────────
$bundles = Get-Bundles
if ([string]::IsNullOrWhiteSpace($Snapshot)) {
	if ($bundles.Count -eq 0) {
		Write-Err "没有可用 bundle：$BackupRoot"
		Write-Info '先在源设备跑「DSH 收口备份」，再把 dsh-backup-<时间戳> 目录拷到本机；或用 -Snapshot 指定目录。'
		exit 2
	}
	$Snapshot = $bundles[0].FullName
	if ($bundles.Count -gt 1) { Write-Info "共 $($bundles.Count) 个 bundle，取最新：$($bundles[0].Name)" }
}
$Snapshot = [IO.Path]::GetFullPath($Snapshot)
if (-not (Test-Path -LiteralPath $Snapshot)) { Write-Err "bundle 目录不存在：$Snapshot"; exit 2 }

$bundle = Read-Bundle -Dir $Snapshot
$okEntries = @($bundle.profiles | Where-Object { [string]$_.status -eq 'ok' })
$badEntries = @($bundle.profiles | Where-Object { [string]$_.status -ne 'ok' })
$partialIds = @($okEntries | Where-Object { [string]$_.completeness -ne 'complete' } | ForEach-Object { [string]$_.profile })

# ── 恢复源摘要 ──────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "DSH 一键恢复 v$ScriptVersion" -ForegroundColor Cyan
Write-Head '恢复源'
Write-Info "bundle：$Snapshot"
Write-Info "创建时间：$(([datetime]$bundle.created_at).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Info "工具版本：$([string]$bundle.tool.name) $([string]$bundle.tool.version)"
Write-Info "默认 profile：$([string]$bundle.default_profile)（恢复后启动命令不变）"
Write-Info "profile：$($okEntries.Count) 个 ok$(if ($badEntries.Count -gt 0) { "，$($badEntries.Count) 个异常" })：$(($okEntries | ForEach-Object { [string]$_.profile }) -join ', ')"
if ($badEntries.Count -gt 0) { Write-Warn2 "异常 profile 不会被恢复：$(($badEntries | ForEach-Object { "$($_.profile)=$($_.status)" }) -join ', ')" }
if ($partialIds.Count -gt 0) { Write-Warn2 "partial（未做隔离安装演练）：$($partialIds.Count) 个 —— 写回需 -AllowPartial" }

if ($okEntries.Count -eq 0) {
	Write-Host ''
	Write-Err "bundle 里没有任何 ok 的 profile，无法恢复：$Snapshot"
	Write-Info '先在源设备重跑备份；异常 profile 的 status 见 bundle.json 的 profiles[].status。'
	exit 2
}

# ── 跨机路径体检：link: 依赖指向的目录是否存在 ─────────────────────────────
Write-Head '跨机路径体检（link: 依赖）'
$missingLinks = New-Object System.Collections.Generic.List[object]
foreach ($entry in $okEntries) {
	$pkgPath = Join-Path (Join-Path (Join-Path $Snapshot 'profiles') ([string]$entry.profile)) 'package.json'
	if (-not (Test-Path -LiteralPath $pkgPath)) { continue }
	$pkg = $null
	try { $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
	if (-not $pkg.dependencies) { continue }
	foreach ($dep in $pkg.dependencies.PSObject.Properties) {
		if ([string]$dep.Value -notlike 'link:*') { continue }
		$target = ([string]$dep.Value).Substring(5)
		if (-not (Test-Path -LiteralPath $target)) {
			$missingLinks.Add([pscustomobject]@{ Profile = [string]$entry.profile; Dependency = $dep.Name; Target = $target })
		}
	}
}
if ($missingLinks.Count -eq 0) {
	Write-Ok '快照里的 link: 依赖路径在本机都存在。'
} else {
	Write-Warn2 "$($missingLinks.Count) 个 link: 依赖路径在本机不存在（目标机仓库克隆路径与源设备不同）："
	$missingLinks | Select-Object -First 12 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
	if ($missingLinks.Count -gt 12) { Write-Info "… 另有 $($missingLinks.Count - 12) 个未显示（可按 bundle 内 profiles/<profile>/package.json 逐项核对）" }
	Write-Info '处置：把本机仓库克隆到与源设备相同的路径，或恢复后按 docs/bootstrap/PROMPT-新设备装机-引导.md 第 5 步重新 dsh plugin add。'
}

# ── 引擎一致性门槛（只读展示；真正判决由配置包入口执行）──────────────────
$preflight = Join-Path $DshRoot 'device\engine-preflight.json'
if (Test-Path -LiteralPath $preflight) {
	try {
		$pf = Get-Content -LiteralPath $preflight -Raw -Encoding utf8 | ConvertFrom-Json
		$note = $(if ([string]$pf.state -eq 'conflict') { 'conflict：恢复会被硬阻断（无豁免）' } elseif ([string]$pf.state -eq 'drift') { 'drift：写回需 -AcceptEngineDrift' } else { '可继续' })
		Write-Head '引擎预检'
		Write-Info "state=$([string]$pf.state)  checkedAt=$([string]$pf.checkedAt)  → $note"
	} catch { Write-Warn2 "engine-preflight.json 无法解析，按无判决处理：$preflight" }
} else {
	Write-Info "未找到引擎预检记录（$preflight）：按无判决继续。"
}

if ($Apply -and $partialIds.Count -gt 0 -and -not $AllowPartial) {
	Write-Host ''
	Write-Err '拒绝写回：bundle 内 profile 是 partial，必须显式加 -AllowPartial。'
	Write-Info '命令：pwsh -NoProfile -File .\dsh-restore.ps1 -Snapshot <bundle> -Apply -AllowPartial'
	exit 2
}

# ── 委托配置包入口 ──────────────────────────────────────────────────────────
$scriptPath = Resolve-BackupScript
if (-not (Test-Path -LiteralPath $scriptPath)) { Write-Err "找不到 dsh-backup.ps1：$scriptPath"; exit 2 }

$cliArgs = @('restore', '-AllProfiles', '-Snapshot', $Snapshot)
if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $cliArgs += @('-DshHome', $DshHome) }
if ($Apply) { $cliArgs += '-Apply' }
if ($AllowPartial) { $cliArgs += '-AllowPartial' }
if ($AcceptEngineDrift) { $cliArgs += '-AcceptEngineDrift' }

Write-Head $(if ($Apply) { '写回（先逐 profile 写 pre-restore）' } else { '恢复计划（不写 profile）' })
& pwsh -NoProfile -File $scriptPath @cliArgs
$code = $LASTEXITCODE

if ($Apply -and $code -eq 0) {
	Write-Head '恢复后必做'
	Write-Info '1) 启动或重启 DSH，并新开一个会话（旧会话的工具表不会更新）。'
	Write-Info '2) 每个 profile 跑一次依赖安装（配置包已在快照里生成 reinstall-plugins.ps1）：'
	Write-Info "   Get-ChildItem $BackupRoot\pre-restore-*\profiles\*\reinstall-plugins.ps1 | ForEach-Object { pwsh -NoProfile -File `$_.FullName }"
	Write-Info '3) 按 docs/bootstrap/PROMPT-新设备装机-引导.md 第 5 步补本地插件登记、第 6 步跑 verify-install 验收。'
	Write-Info '4) 本机若与源设备仓库路径不同，先统一 link: 路径（见上方跨机路径体检）。'
}

if ($code -eq 0 -and -not $Apply) { Write-Info '以上为计划；确认后加 -Apply -AllowPartial 真正写回。' }
exit $code
