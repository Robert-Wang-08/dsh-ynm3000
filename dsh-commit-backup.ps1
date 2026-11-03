#!/usr/bin/env pwsh
<#
.SYNOPSIS
  DSH 一键提交与备份 v1.1.0（盘点 → 备份 → 提交 → 可选推送）

.DESCRIPTION
  在脚本所在工作区里把「有哪些要提交 / 先备份 / 逐个仓库提交 / 可选推送」四步合成一条命令。

  设计约束（来自 DSH-插件-补丁与配置一键同步.md 第 8 节）：
    - 不用 git add . / git add -A，只按 git status 解析出的显式路径暂存；
    - 不提交 .ptc/、profile 本地状态、凭据文件和临时产物；
    - 从不 force push，从不改写已有历史。

  仓库顺序：先子仓库（子模块 / 同级仓库），最后根仓库 dsh，
  这样根仓库提交时子模块指针已是新值。

.PARAMETER Message
  提交信息主干。多仓库有改动时会自动追加 " [<仓库名>]"。
  省略时生成 "chore(auto): 一键提交 <仓库> (<N> 个文件)"。

.PARAMETER DryRun
  只打印计划：不备份、不暂存、不提交、不推送。

.PARAMETER Status
  DryRun 的同义词，只为读起来顺。

.PARAMETER Push
  提交成功后逐个推送当前分支到 origin（有上游且非分叉时）。

.PARAMETER NoBackup
  跳过 DSH 配置备份（默认会在提交前备份一次）。

.PARAMETER IncludeUntracked
  把未被 .gitignore 忽略的未跟踪文件一并提交（仍会过滤凭据与临时产物）。

.PARAMETER IncludeFocusHub
  把 D:\src\dsh\focus-hub（独立应用仓库，根仓库 .gitignore 已排除）纳入本次范围。

.PARAMETER RepairDetached
  子仓库处于游离 HEAD 时，自动切回 origin/HEAD 指向的分支。默认只报告不处理。

.PARAMETER Only
  只处理指定仓库名（如 -Only dsh-config-pack,dsh）。

.PARAMETER BackupDest
  备份根目录，透传给 dsh-backup 的 -Dest。省略则用默认 %USERPROFILE%\.dsh\backups。

.PARAMETER BackupScript
  dsh-backup.ps1 的路径。省略时依次读 $env:DSH_BACKUP_SCRIPT、
  已安装的 dsh-backup-restore skill，再回落到本仓库
  dsh-config-pack\scripts\dsh-backup.ps1。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Status
  只看盘点，不动任何东西。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Message "chore: 修 PTC 路由档位"
  备份 + 在全部有改动的仓库里提交（不推送）。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Message "chore: 收口" -Push
  备份 + 提交 + 推送。

.NOTES
  版本历史见 docs/ops/一键提交与备份.md。
  在 DSH 会话内执行时，若文件策略为只读或沙箱拦写 .git，会在此脚本第一次写操作处报
  Permission denied —— 这不是脚本缺陷，请改在本机终端（沙箱外）运行。
#>
[CmdletBinding()]
param(
	[string]$Message = '',
	[switch]$DryRun,
	[switch]$Status,
	[switch]$Push,
	[switch]$NoBackup,
	[switch]$IncludeUntracked,
	[switch]$IncludeFocusHub,
	[switch]$RepairDetached,
	[string[]]$Only = @(),
	[string]$BackupDest = '',
	[string]$BackupScript = '',
	[string]$RootDir = ''
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$ScriptVersion = '1.1.0'
if ([string]::IsNullOrWhiteSpace($RootDir)) { $RootDir = $PSScriptRoot }
$Root = $RootDir
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$PlanOnly = ($DryRun -or $Status)

function Write-Head { param([string]$Text) Write-Host ''; Write-Host "──── $Text ────" -ForegroundColor Cyan }
function Write-Info { param([string]$Text) Write-Host "  $Text" }
function Write-Ok   { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Err  { param([string]$Text) Write-Host "  [err] $Text" -ForegroundColor Red }

# ── 过滤规则 ────────────────────────────────────────────────────────────────
# 凭据：任何匹配都永不进 Git，且整次运行记为风险。
$DenyPatterns = @(
	'.credentials.yaml', '*.credentials.yaml', '*.credentials.yml',
	'.env', '.env.*', '*.pem', '*.key', '*.pfx', 'id_rsa*', '*secret*.json', '*secrets*.yaml'
)
# 临时/本机产物：即使加了 -IncludeUntracked 也不提交。
$JunkPatterns = @(
	'.ptc/*', '.ptc', 'node_modules/*', '__pycache__/*',
	'*.bak', '*.bak-*', '*.log', '*.tmp', '.tmp-*', '.tmp-*/*',
	'tmp/*', 'temp/*', 'downloads/*', '.wip-backup-*/*', '.wip-backup-*',
	'*.tsbuildinfo', '.DS_Store'
)

function Test-AnyPattern {
	param([string]$Path, [string[]]$Patterns)
	foreach ($p in $Patterns) {
		if ($Path -like $p) { return $true }
	}
	return $false
}

function Get-GitLine {
	param([string]$Repo, [string[]]$GitArgs)
	$raw = & git -C $Repo @GitArgs 2>$null
	if ($null -eq $raw) { return '' }
	return ((@($raw) | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
}

function Get-GitExit {
	param([string]$Repo, [string[]]$GitArgs)
	$raw = & git -C $Repo @GitArgs 2>&1
	$code = $LASTEXITCODE
	return [pscustomobject]@{ Exit = $code; Text = ((@($raw) | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim() }
}

# ── 仓库发现 ────────────────────────────────────────────────────────────────
$SkipDirNames = @('node_modules', 'attachments', 'downloads', 'claude-mem-lab', 'model-benchmark')

function Get-RepoTargets {
	$children = New-Object System.Collections.Generic.List[object]
	foreach ($d in (Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
		if ($SkipDirNames -contains $d.Name) { continue }
		if ($d.Name -eq 'focus-hub' -and -not $IncludeFocusHub) { continue }
		if (-not (Test-Path -LiteralPath (Join-Path $d.FullName '.git'))) { continue }
		$children.Add([pscustomobject]@{
			Name = $d.Name
			Path = $d.FullName
			Kind = $(if ($d.Name -eq 'focus-hub') { 'sibling' } else { 'submodule' })
		})
	}
	$ordered = @($children | Sort-Object Name)
	# 根仓库永远最后处理：提交根仓库时子模块指针已经落定。
	$ordered += [pscustomobject]@{ Name = (Split-Path $Root -Leaf); Path = $Root; Kind = 'root' }
	if ($Only.Count -gt 0) {
		$ordered = @($ordered | Where-Object { $Only -contains $_.Name })
	}
	return , $ordered
}

function Get-RepoState {
	param($Target)

	$repo = $Target.Path
	$state = [pscustomobject]@{
		Name     = $Target.Name
		Path     = $repo
		Kind     = $Target.Kind
		Branch   = ''
		Detached = $false
		Upstream = ''
		Ahead    = 0
		Behind   = 0
		Stage    = @()
		Excluded = @()
		Blocked  = ''
		Action   = 'skip'
		Detail   = ''
	}

	$branch = Get-GitLine -Repo $repo -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
	if ([string]::IsNullOrWhiteSpace($branch)) {
		$state.Blocked = '不是可用 git 仓库'
		$state.Action = 'blocked'
		return $state
	}
	$state.Branch = $branch
	if ($branch -eq 'HEAD') { $state.Detached = $true }

	$up = Get-GitLine -Repo $repo -GitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
	if (-not [string]::IsNullOrWhiteSpace($up)) {
		$state.Upstream = $up
		$a = Get-GitLine -Repo $repo -GitArgs @('rev-list', '--count', "$up..HEAD")
		$b = Get-GitLine -Repo $repo -GitArgs @('rev-list', '--count', "HEAD..$up")
		if ($a -match '^\d+$') { $state.Ahead = [int]$a }
		if ($b -match '^\d+$') { $state.Behind = [int]$b }
	}

	$stage = New-Object System.Collections.Generic.List[string]
	$excluded = New-Object System.Collections.Generic.List[object]

	# core.quotepath=false：非 ASCII 路径按 UTF-8 原样输出。默认设置会把中文转成 \NNN 八进制
	# 转义（如 docs/ops/\344\270\200...），原样交给 git add 会报
	# "pathspec ... did not match any files"（2026-11-03 实测踩到）。
	# --ignore-submodules=dirty：子模块只有工作区内容变化时（" m"/" ?"）不在这里处理——那要进子模块
	# 自己提交；指针真的移动了（" M"）仍然会列出来并被暂存。否则会拿一个空改动去 commit 而失败。
	$porcelain = & git -C $repo -c core.quotepath=false status --porcelain=v1 --untracked-files=all --ignore-submodules=dirty 2>$null
	foreach ($line in @($porcelain)) {
		$s = "$line"
		if ($s.Length -lt 4) { continue }
		$xy = $s.Substring(0, 2)
		$path = $s.Substring(3)
		if ($path.StartsWith('"') -and $path.EndsWith('"') -and $path.Length -ge 2) {
			$path = $path.Substring(1, $path.Length - 2) -replace '\"', '"' -replace '\\', '\'
			$path = $path -replace '\\', '\'
		}
		if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }

		$isUntracked = $xy.StartsWith('??')
		if (Test-AnyPattern -Path $path -Patterns $DenyPatterns) {
			$excluded.Add([pscustomobject]@{ Path = $path; Reason = '凭据/敏感文件' })
			continue
		}
		if (Test-AnyPattern -Path $path -Patterns $JunkPatterns) {
			$excluded.Add([pscustomobject]@{ Path = $path; Reason = '本机临时产物' })
			continue
		}
		if ($isUntracked -and -not $IncludeUntracked) {
			$excluded.Add([pscustomobject]@{ Path = $path; Reason = '未跟踪（需 -IncludeUntracked）' })
			continue
		}
		# 内嵌仓库保护：未登记为 submodule 的嵌套 git 仓库被 add 进去只会变成空 gitlink，
		# 克隆方拿不到内容（根仓库 .gitignore 对 focus-hub 的注释就是这个教训）。
		if ($isUntracked) {
			$nested = Join-Path (Join-Path $repo $path.TrimEnd('/')) '.git'
			if (Test-Path -LiteralPath $nested) {
				$excluded.Add([pscustomobject]@{ Path = $path; Reason = '内嵌 git 仓库（未登记为 submodule）' })
				continue
			}
		}
		$stage.Add($path)
	}

	# 注意：不要写成 @($stage) / @($excluded)。PowerShell 对空的 List[object] 做数组子表达式
	# 再赋给 PSCustomObject 属性会抛 "Argument types do not match"（实测 PS 7.4）。
	$state.Stage = $stage.ToArray()
	$state.Excluded = $excluded.ToArray()

	if ($state.Detached) {
		$state.Blocked = '游离 HEAD（不在任何分支上），无法安全提交'
		$state.Action = 'blocked'
	} elseif ($state.Stage.Count -gt 0) {
		$state.Action = 'commit'
	}
	return $state
}

# ── 备份 ────────────────────────────────────────────────────────────────────
function Resolve-BackupScript {
	if (-not [string]::IsNullOrWhiteSpace($BackupScript)) { return $BackupScript }
	if (-not [string]::IsNullOrWhiteSpace($env:DSH_BACKUP_SCRIPT)) { return $env:DSH_BACKUP_SCRIPT }
	$skill = Join-Path $env:USERPROFILE '.agents\skills\dsh-backup-restore\scripts\dsh-backup.ps1'
	if (Test-Path -LiteralPath $skill) { return $skill }
	return (Join-Path $PSScriptRoot 'dsh-config-pack\scripts\dsh-backup.ps1')
}

function Invoke-DshBackup {
	if ($NoBackup) { return [pscustomobject]@{ Status = 'skipped'; Detail = '-NoBackup' } }
	if ($PlanOnly) { return [pscustomobject]@{ Status = 'planned'; Detail = '计划中（DryRun 不落盘）' } }
	$path = Resolve-BackupScript
	if (-not (Test-Path -LiteralPath $path)) {
		return [pscustomobject]@{ Status = 'missing'; Detail = "找不到 dsh-backup.ps1：$path" }
	}
	$callArgs = @('backup')
	if (-not [string]::IsNullOrWhiteSpace($BackupDest)) { $callArgs += @('-Dest', $BackupDest) }
	$out = & pwsh -NoProfile -File $path @callArgs 2>&1
	$code = $LASTEXITCODE
	$text = ((@($out) | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
	if ($code -eq 0) {
		$hit = [regex]::Match($text, 'dsh-backup-\d{8}-\d{6}')
		$name = $(if ($hit.Success) { $hit.Value } else { '（未从输出中识别备份目录名）' })
		return [pscustomobject]@{ Status = 'ok'; Detail = $name; Output = $text }
	}
	return [pscustomobject]@{ Status = 'failed'; Detail = "exit $code"; Output = $text }
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "DSH 一键提交与备份 v$ScriptVersion" -ForegroundColor Cyan
Write-Info "工作区：$Root"
Write-Info "模式：$(if ($PlanOnly) { '只盘点（DryRun）' } else { '实际执行' })  推送：$(if ($Push) { '是' } else { '否' })  备份：$(if ($NoBackup) { '跳过' } else { '提交前执行一次' })"

$targets = Get-RepoTargets
$states = New-Object System.Collections.Generic.List[object]
foreach ($t in $targets) { $states.Add((Get-RepoState -Target $t)) }

# 游离 HEAD 修复（显式开关）
# 注意：不能在 foreach 遍历 $states 的同时改它（List 会抛 Collection was modified），
# 先收集要刷新的仓库名，遍历结束后再按下标重建状态。
if ($RepairDetached -and -not $PlanOnly) {
	$repaired = New-Object System.Collections.Generic.List[string]
	foreach ($s in $states) {
		if (-not $s.Detached) { continue }
		$default = Get-GitLine -Repo $s.Path -GitArgs @('symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD')
		if ([string]::IsNullOrWhiteSpace($default)) { Write-Warn2 "$($s.Name) : origin/HEAD 未设置，跳过游离 HEAD 修复"; continue }
		$branchName = ($default -replace '^origin/', '')

		# 安全规则：本地分支已存在、且分支上有云端未含的提交时，绝不动它。
		# git checkout -B 会把分支指针硬挪到 origin，那些提交就只能靠 reflog 找回
		# （2026-11-03 复查 badge 仓库时确认了该隐患：那次本地分支恰好是纯落后，才没丢东西）。
		# 反过来，分支严格落后 origin 时用 -B 到 origin 尖端是纯快进，不会丢提交，
		# 还能带着当前游离 HEAD 上的本地改动一起过去，所以那种情况仍走 -B。
		$branchRef = Get-GitLine -Repo $s.Path -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$branchName")
		if (-not [string]::IsNullOrWhiteSpace($branchRef)) {
			$aheadLocal = Get-GitLine -Repo $s.Path -GitArgs @('rev-list', '--count', "$default..refs/heads/$branchName")
			if ($aheadLocal -match '^\d+$' -and [int]$aheadLocal -gt 0) {
				Write-Err "$($s.Name) : 本地分支 $branchName 有 $aheadLocal 个云端未含的提交，拒绝覆盖，请人工合并后再跑"
				continue
			}
		}
		$fix = Get-GitExit -Repo $s.Path -GitArgs @('checkout', '-B', $branchName, $default)
		if ($fix.Exit -eq 0) {
			Write-Ok "$($s.Name) : 游离 HEAD 已切回分支 $branchName（= $default，无提交丢失）"
			$repaired.Add($s.Name)
		} else {
			Write-Err "$($s.Name) : 游离 HEAD 修复失败：$($fix.Text)"
		}
	}
	if ($repaired.Count -gt 0) {
		for ($i = 0; $i -lt $states.Count; $i++) {
			if (-not $repaired.Contains($states[$i].Name)) { continue }
			$old = $states[$i]
			$states[$i] = Get-RepoState -Target ([pscustomobject]@{ Name = $old.Name; Path = $old.Path; Kind = $old.Kind })
		}
	}
}

Write-Head '盘点'
$rows = foreach ($s in $states) {
	[pscustomobject]@{
		'仓库'    = $s.Name
		分支      = $(if ($s.Detached) { 'DETACHED' } else { $s.Branch })
		'领先/落后' = $(if ($s.Upstream) { "$($s.Ahead)/$($s.Behind)" } else { '-' })
		'待暂存'  = $s.Stage.Count
		'已排除'  = $s.Excluded.Count
		状态      = $(if ($s.Blocked) { 'BLOCKED' } elseif ($s.Action -eq 'commit') { 'WILL COMMIT' } else { 'clean' })
	}
}
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

foreach ($s in $states) {
	if ($s.Excluded.Count -eq 0) { continue }
	Write-Info "$($s.Name) : 已排除 $($s.Excluded.Count) 项"
	$shown = [Math]::Min(8, $s.Excluded.Count)
	for ($i = 0; $i -lt $shown; $i++) {
		Write-Host "      - $($s.Excluded[$i].Path)  ($($s.Excluded[$i].Reason))"
	}
	if ($s.Excluded.Count -gt $shown) { Write-Host "      … 另有 $($s.Excluded.Count - $shown) 项被排除（全文见回执）" }
}

$blocked = @($states | Where-Object { $s = $_; $_.Blocked -ne '' })
$toCommit = @($states | Where-Object { $_.Action -eq 'commit' })

if ($blocked.Count -gt 0) {
	Write-Head '阻塞项'
	foreach ($b in $blocked) { Write-Err "$($b.Name) : $($b.Blocked)" }
	if (@($blocked | Where-Object { $_.Detached }).Count -gt 0) {
		Write-Info '游离 HEAD 可用 -RepairDetached 自动切回 origin/HEAD 分支（不在任何分支上时提交会丢失引用）。'
	}
}
if ($toCommit.Count -eq 0 -and $blocked.Count -eq 0) {
	Write-Ok '没有任何仓库需要提交。'
}
if (@($states | Where-Object { $_.Ahead -gt 0 -and $_.Behind -gt 0 }).Count -gt 0) {
	Write-Head '注意：本地与云端分叉'
	foreach ($s in $states) {
		if ($s.Ahead -gt 0 -and $s.Behind -gt 0) {
			Write-Warn2 "$($s.Name) : 本地领先 $($s.Ahead) / 落后 $($s.Behind)，先集成云端（pull/merge）再提交，否则推送会被拒绝。"
		}
	}
}

$receipt = [ordered]@{
	version      = $ScriptVersion
	stamp        = $Stamp
	mode         = $(if ($PlanOnly) { 'dry-run' } else { 'apply' })
	push         = [bool]$Push
	backup       = $null
	inventory    = @()
	repositories = @()
}
$receipt.inventory = @($states | ForEach-Object {
		[ordered]@{
			name     = $_.Name
			branch   = $_.Branch
			detached = $_.Detached
			ahead    = $_.Ahead
			behind   = $_.Behind
			staged    = @($_.Stage)
			excluded = @($_.Excluded | ForEach-Object { $_.Path })
			blocked  = $_.Blocked
		}
	})

function Write-ReceiptFile {
	$receiptDir = Join-Path (Join-Path $Root '.ptc') 'reports'
	if (-not (Test-Path -LiteralPath $receiptDir)) { New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null }
	$path = Join-Path $receiptDir ("commit-backup-$Stamp.json")
	$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding utf8
	return $path
}

if ($PlanOnly) {
	Write-Head '计划（未执行任何写操作）'
	foreach ($s in $toCommit) { Write-Info "$($s.Name) : 将暂存并提交 $($s.Stage.Count) 个文件" }
	if (-not $NoBackup) { Write-Info '将在提交前执行一次 DSH 配置备份' }
	if ($Push) { Write-Info '提交后对每个有上游的仓库执行 push（不 force）' }
	$receiptPath = Write-ReceiptFile
	Write-Host ''
	Write-Info "只读盘点结束。去掉 -DryRun / -Status 才会真正执行。"
	Write-Info "盘点回执：$receiptPath"
	exit 0
}

# 1) 备份
Write-Head '备份'
$backupResult = Invoke-DshBackup
switch ($backupResult.Status) {
	'ok'      { Write-Ok "配置备份完成：$($backupResult.Detail)" }
	'skipped' { Write-Warn2 "已跳过备份：$($backupResult.Detail)" }
	'planned' { Write-Info '计划中' }
	'missing' { Write-Warn2 $backupResult.Detail }
	'failed'  { Write-Err "配置备份失败：$($backupResult.Detail)"; Write-Host $backupResult.Output }
}
$receipt.backup = [ordered]@{ status = $backupResult.Status; detail = $backupResult.Detail }

$failures = 0
$committed = New-Object System.Collections.Generic.List[object]

# 2) 提交
if ($toCommit.Count -gt 0) { Write-Head '提交' }
foreach ($s in $states) {
	if ($s.Action -ne 'commit') { continue }

	$addResult = $s.Stage | & git -C $s.Path add --pathspec-from-file=-
	if ($LASTEXITCODE -ne 0) {
		Write-Err "$($s.Name) : 暂存失败（exit $LASTEXITCODE）"
		$failures++
		continue
	}
	# 用解析出的文件数，不要拿 Get-GitLine 的结果再 Measure-Object：
	# Get-GitLine 返回的是 join 过的单个字符串，Count 恒为 1（2026-11-03 实测踩到）。
	$stagedCount = $s.Stage.Count
	if ($stagedCount -eq 0) {
		Write-Warn2 "$($s.Name) : 暂存后无内容，跳过提交"
		continue
	}

	$subject = $(if (-not [string]::IsNullOrWhiteSpace($Message)) {
			$(if ($toCommit.Count -gt 1) { "$Message [$($s.Name)]" } else { $Message })
		} else {
			"chore(auto): 一键提交 $($s.Name)（$stagedCount 个文件）"
		})
	$body = "由 dsh-commit-backup.ps1 v$ScriptVersion 于 $Stamp 生成。备份：$($backupResult.Status)。"
	$commit = Get-GitExit -Repo $s.Path -GitArgs @('commit', '-m', $subject, '-m', $body)
	if ($commit.Exit -ne 0) {
		Write-Err "$($s.Name) : 提交失败（exit $($commit.Exit)）"
		Write-Host $commit.Text
		$failures++
		continue
	}
	$sha = Get-GitLine -Repo $s.Path -GitArgs @('rev-parse', '--short', 'HEAD')
	Write-Ok "$($s.Name) : $sha  $subject（$stagedCount 个文件）"
	$committed.Add([pscustomobject]@{ Name = $s.Name; Sha = $sha; Subject = $subject; Files = $stagedCount })
	$receipt.repositories += [ordered]@{ name = $s.Name; action = 'commit'; sha = $sha; files = $stagedCount; subject = $subject }
}

# 3) 推送
if ($Push) {
	Write-Head '推送'
	if ($committed.Count -eq 0) { Write-Info '本次没有新提交；仍检查各仓库的待推送提交。' }
	foreach ($s in $states) {
		if ($s.Detached) { Write-Warn2 "$($s.Name) : 游离 HEAD，跳过推送"; continue }
		if ([string]::IsNullOrWhiteSpace($s.Upstream)) { Write-Warn2 "$($s.Name) : 无上游分支，跳过推送"; continue }
		$aheadNow = Get-GitLine -Repo $s.Path -GitArgs @('rev-list', '--count', "$($s.Upstream)..HEAD")
		if ($aheadNow -notmatch '^\d+$' -or [int]$aheadNow -le 0) { Write-Info "$($s.Name) : 无待推送提交"; continue }
		$pushResult = Get-GitExit -Repo $s.Path -GitArgs @('push', 'origin', $s.Branch)
		if ($pushResult.Exit -eq 0) {
			Write-Ok "$($s.Name) : 已推送 $aheadNow 个提交到 origin/$($s.Branch)"
			$receipt.repositories += [ordered]@{ name = $s.Name; action = 'push'; count = [int]$aheadNow }
		} else {
			Write-Err "$($s.Name) : 推送失败（exit $($pushResult.Exit)）"
			Write-Host $pushResult.Text
			$failures++
			$receipt.repositories += [ordered]@{ name = $s.Name; action = 'push-failed'; count = [int]$aheadNow }
		}
	}
}

# 4) 回执
$receipt.failures = $failures
$receiptPath = Write-ReceiptFile

Write-Head '结果'
Write-Info "提交仓库数：$($committed.Count)   失败数：$failures"
Write-Info "回执：$receiptPath"
if ($blocked.Count -gt 0) { Write-Warn2 "仍有 $($blocked.Count) 个仓库被阻塞（见上方阻塞项）。" }

if ($failures -gt 0) { exit 1 }
if ($blocked.Count -gt 0) { exit 2 }
exit 0
