#!/usr/bin/env pwsh
<#
.SYNOPSIS
  DSH 运维菜单：5 个本地插件/补丁仓库的拉取、推送、应用，以及 dsh 版本升级。

.DESCRIPTION
  一个交互式数字选项程序。底层复用本目录（D:\src\dsh）里的单功能脚本
  （dsh-apply-patches.ps1 / dsh-upgrade.ps1）；新增 dsh 升级目标只需在
  $DshUpgrades 里加一行。

.PARAMETER Action
  非交互模式：直接执行对应编号后退出（配合自动化 / 自测）。
    1 = git 全拉取
    2 = git 全推送
    3 = 应用全最新插件或补丁
    >=4 = 对应的 dsh 升级目标（见菜单）
#>
[CmdletBinding()]
param(
	[int]$Action = 0
)

$ErrorActionPreference = 'Stop'
# Native 命令失败靠 $LASTEXITCODE 判断，别让 stderr 触发终止。
$PSNativeCommandUseErrorActionPreference = $false

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshDir = 'D:\src\dsh'

# ── 5 个本地仓库：目录名 → 默认分支 ───────────────────────────────────────────
# 新增插件仓库在这里追加一行即可。
$Repos = [ordered]@{
	'dsh-archived-sessions'         = 'main'
	'dsh-permission-compat'         = 'main'
	'dsh-plugin-provider-badge'     = 'master'
	'dsh-plugin-sidebar-visibility' = 'main'
	'dsh-provider-failover'         = 'master'
}

# ── 本地插件的重建命令（相对仓库目录）────────────────────────────────────────
# 只有需要从源码出产物（lib/）的插件才列出；纯 JS 插件无需重建。
# 注意：不要在这里跑 pnpm install —— 本机的 nvm4w 环境下它可能触发
# nvm-windows 的交互提问并挂起；依赖安装请手动执行一次。
$Builds = [ordered]@{
	'dsh-archived-sessions'         = @('pnpm', 'build')
	'dsh-plugin-sidebar-visibility' = @('pnpm', 'bundle')
}

# ── 可升级的 dsh 目标：版本 → 菜单文案 ──────────────────────────────────────
# 未来追加 dsh 其他升级：在此加一行即可（编号自动顺延）。
$DshUpgrades = [ordered]@{
	'0.2.0-rc.2' = '升级 dsh 到 0.2.0-rc.2 并重应用补丁'
}

function Write-Head { param([string]$Text) Write-Host ''; Write-Host "──── $Text ────" -ForegroundColor Cyan }
function Write-Info { param([string]$Text) Write-Host "  $Text" }
function Write-Ok   { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Err  { param([string]$Text) Write-Host "  [err] $Text" -ForegroundColor Red }

function Test-RepoPath { param([string]$Name) Test-Path -LiteralPath (Join-Path $dshDir $Name) }

function Invoke-GitPullAll {
	Write-Head 'git 全拉取'
	foreach ($entry in $Repos.GetEnumerator()) {
		$name = $entry.Key; $branch = $entry.Value
		if (-not (Test-RepoPath $name)) { Write-Warn "$name : 目录不存在，跳过"; continue }
		Write-Info "$name ($branch)"
		git -C (Join-Path $dshDir $name) fetch --prune origin 2>&1 | ForEach-Object { "    $_" }
		if ($LASTEXITCODE -ne 0) { Write-Err "$name : fetch 失败（网络/权限）"; continue }
		$repo = Join-Path $dshDir $name
		$behind = [int](git -C $repo rev-list --count "HEAD..origin/$branch")
		$ahead = [int](git -C $repo rev-list --count "origin/$branch..HEAD")
		if ($behind -eq 0) { Write-Ok "$name : 已是最新（本地领先 $ahead）"; continue }
		$dirty = git -C $repo status --porcelain
		if (-not [string]::IsNullOrWhiteSpace($dirty)) { Write-Warn "$name : 有未提交改动，跳过 ff 合并"; continue }
		git -C $repo merge --ff-only "origin/$branch" 2>&1 | ForEach-Object { "    $_" }
		if ($LASTEXITCODE -eq 0) { Write-Ok "$name : 快进 $behind 个提交" }
		else { Write-Warn "$name : 非快进（本地与远端分叉），需手动处理" }
	}
}

function Invoke-GitPushAll {
	Write-Head 'git 全推送'
	foreach ($entry in $Repos.GetEnumerator()) {
		$name = $entry.Key; $branch = $entry.Value
		if (-not (Test-RepoPath $name)) { Write-Warn "$name : 目录不存在，跳过"; continue }
		$repo = Join-Path $dshDir $name
		git -C $repo fetch --prune origin 2>&1 | Out-Null
		$ahead = [int](git -C $repo rev-list --count "origin/$branch..HEAD" 2>$null)
		if ($ahead -le 0) { Write-Ok "$name : 无待推送提交"; continue }
		$dirty = git -C $repo status --porcelain
		if (-not [string]::IsNullOrWhiteSpace($dirty)) {
			Write-Warn "$name : 有未提交改动（推送不会包含它们）"
		}
		Write-Info "$name → origin/$branch（$ahead 个提交）"
		git -C $repo push origin $branch 2>&1 | ForEach-Object { "    $_" }
		if ($LASTEXITCODE -eq 0) { Write-Ok "$name : 已推送" }
		else { Write-Err "$name : 推送失败（需先拉取/解决冲突，或凭据问题）" }
	}
}

function Invoke-ApplyAll {
	Write-Head '重建本地插件'
	# 直接调用原生命令（不把输出管道给 cmdlet），并置 CI=true 保持非交互。
	$previousCi = $env:CI
	$env:CI = 'true'
	try {
		foreach ($entry in $Builds.GetEnumerator()) {
			$name = $entry.Key
			if (-not (Test-RepoPath $name)) { Write-Warn "$name : 目录不存在，跳过"; continue }
			$build = $entry.Value
			$repo = Join-Path $dshDir $name
			$exe = $build[0]
			$rest = @($build | Select-Object -Skip 1)
			Write-Info "$name : $($build -join ' ')"
			Push-Location -LiteralPath $repo
			try {
				& $exe @rest
				if ($LASTEXITCODE -ne 0) { Write-Err "$name : 构建失败" } else { Write-Ok "$name : 已重建" }
			}
			finally { Pop-Location }
		}
	}
	finally {
		if ($null -eq $previousCi) { Remove-Item Env:CI -ErrorAction SilentlyContinue } else { $env:CI = $previousCi }
	}

	Write-Head '重应用 dsh 补丁'
	$apply = Join-Path $rootDir 'dsh-apply-patches.ps1'
	if (-not (Test-Path -LiteralPath $apply)) { Write-Err "缺少脚本：$apply"; return }
	& $apply
	if ($LASTEXITCODE -eq 0) { Write-Ok '补丁已应用并校验通过' } else { Write-Err "补丁应用失败（exit $LASTEXITCODE）" }
}

function Invoke-DshUpgrade {
	param([string]$Version)
	Write-Head "dsh 升级 → $Version"
	$upgrade = Join-Path $rootDir 'dsh-upgrade.ps1'
	if (-not (Test-Path -LiteralPath $upgrade)) { Write-Err "缺少脚本：$upgrade"; return }
	& $upgrade -Version $Version
	if ($LASTEXITCODE -eq 0) { Write-Ok "dsh 已升级到 $Version 并重应用补丁" } else { Write-Err "升级失败（exit $LASTEXITCODE）" }
}

function Get-MenuActions {
	# 数组下标 0 对应菜单编号 1；dsh 升级目标顺延。
	$actions = @(
		'git 全拉取（5 个仓库）',
		'git 全推送（5 个仓库）',
		'应用全最新插件或补丁（重建本地插件 + 重应用 dsh 补丁）'
	)
	foreach ($version in $DshUpgrades.Keys) {
		$actions += "[dsh] $($DshUpgrades[$version])"
	}
	return , $actions
}

function Invoke-Action {
	param([int]$Choice)
	if ($Choice -eq 0) { return $false }
	if ($Choice -eq 1) { Invoke-GitPullAll; return $true }
	if ($Choice -eq 2) { Invoke-GitPushAll; return $true }
	if ($Choice -eq 3) { Invoke-ApplyAll; return $true }
	$index = $Choice - 4
	$versions = @($DshUpgrades.Keys)
	if ($index -ge 0 -and $index -lt $versions.Count) {
		Invoke-DshUpgrade -Version $versions[$index]
		return $true
	}
	Write-Err "无效选项：$Choice"
	return $true
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
if ($Action -ne 0) {
	Invoke-Action -Choice $Action | Out-Null
	exit $LASTEXITCODE
}

while ($true) {
	Write-Host ''
	Write-Host '================= DSH 运维菜单 =================' -ForegroundColor Cyan
	$actions = Get-MenuActions
	for ($i = 0; $i -lt $actions.Count; $i++) {
		Write-Host ("  {0}) {1}" -f ($i + 1), $actions[$i])
	}
	Write-Host '  0) 退出'
	Write-Host '===============================================' -ForegroundColor Cyan
	$raw = Read-Host '请选择'
	$choice = 0
	if (-not [int]::TryParse($raw, [ref]$choice)) { Write-Err '请输入数字编号'; continue }
	if ($choice -eq 0) { break }
	Invoke-Action -Choice $choice | Out-Null
}

exit 0
