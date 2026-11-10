<#
.SYNOPSIS
  一键快照本次改动涉及的全部 DSH 配置（profile 补丁层 + PTC bundle 源文件 + AGENTS.md），并可一键回滚。

.DESCRIPTION
  这是对 dsh-backup-restore（snapshot/v1）的补充，不是替代：官方入口备份整个 profile，
  本脚本只钉住少量关键文件，用于改完 ACP 开关 / 子代理绑定后留一个可精确回滚的点。

  子命令
    backup   生成 <Dest>\ptc-config-<UTC 时间戳>\（MANIFEST.json + files\ + CHANGES.md）
    verify   校验某个快照的文件完整性与 SHA256
    restore  默认 DryRun 只打印计划；-Apply 会先写 pre-restore 安全快照再写回
    list     列出已有快照

.PARAMETER RepoRoot  工作区根，默认 D:\src\dsh
.PARAMETER Dest      备份根，默认 %USERPROFILE%\.dsh\backups
.PARAMETER Snapshot  verify / restore 的目标快照目录（缺省取最新）

.EXAMPLE  pwsh -NoProfile -File scripts/config-snapshot.ps1 backup
.EXAMPLE  pwsh -NoProfile -File scripts/config-snapshot.ps1 verify
.EXAMPLE  pwsh -NoProfile -File scripts/config-snapshot.ps1 restore -Snapshot <dir>
.EXAMPLE  pwsh -NoProfile -File scripts/config-snapshot.ps1 restore -Snapshot <dir> -Apply
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('backup', 'verify', 'restore', 'list')]
  [string]$Command = 'backup',
  [string]$Snapshot = '',
  [string]$RepoRoot = 'D:\src\dsh',
  [string]$Dest = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Home_ = $env:USERPROFILE
if (-not $Home_) { $Home_ = [Environment]::GetFolderPath('UserProfile') }
if (-not $Home_) { throw '无法确定用户主目录：请在环境里设置 USERPROFILE，或显式传 -Dest' }
if (-not $Dest) { $Dest = Join-Path $Home_ '.dsh\backups' }

# 快照清单：logical 名 -> 绝对路径。要纳入新文件只改这里。
$Ptc = Join-Path $RepoRoot 'dsh-config-pack\packages\dsh-ptc-multi-agent-mode'
$Files = [ordered]@{
  'profile-web-cordis-patch'      = Join-Path $Home_ '.dsh\profiles\web\cordis.patch.yml'
  'profile-web-package-json'      = Join-Path $Home_ '.dsh\profiles\web\package.json'
  'profile-web-pnpm-workspace'    = Join-Path $Home_ '.dsh\profiles\web\pnpm-workspace.yaml'
  'profile-plugtest-cordis-patch' = Join-Path $Home_ '.dsh\profiles\plugtest\cordis.patch.yml'
  'profile-plugtest-package-json' = Join-Path $Home_ '.dsh\profiles\plugtest\package.json'
  'workspace-AGENTS.md'           = Join-Path $RepoRoot 'AGENTS.md'
  'ptc-bundle-cordis-patch'       = Join-Path $Ptc 'assets\dsh-bundle\cordis.patch.yml'
  'ptc-public-runtime-config'     = Join-Path $Ptc 'assets\public-runtime-config.json'
  'ptc-SKILL.md'                  = Join-Path $Ptc 'SKILL.md'
  'ptc-route-script'              = Join-Path $Ptc 'scripts\ptc_route.py'
}

function Get-Sha([string]$Path) { (Get-FileHash -Path $Path -Algorithm SHA256).Hash }

# 解析 git / dsh 可执行文件：dsh 的工具子进程环境可能被裁剪（PATH/USERPROFILE 为空），
# 这里做兜底，保证 manifest 仍能记录版本与 git 状态。
$GitExe = 'git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  foreach ($c in @('C:\Program Files\Git\cmd\git.exe', 'C:\Program Files (x86)\Git\cmd\git.exe')) { if (Test-Path $c) { $GitExe = $c; break } }
}
$DshExe = 'dsh'
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  foreach ($c in @('C:\nvm4w\nodejs\dsh.cmd', 'C:\nvm4w\nodejs\dsh.ps1')) { if (Test-Path $c) { $DshExe = $c; break } }
}

function New-Snapshot([string]$Root, [string]$Reason) {
  $ts = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $dir = Join-Path $Root ('ptc-config-' + $ts)
  New-Item -ItemType Directory -Path (Join-Path $dir 'files') -Force | Out-Null
  $entries = @()
  foreach ($k in $Files.Keys) {
    $src = $Files[$k]
    if (-not (Test-Path $src)) { $entries += [ordered]@{ logical = $k; source = $src; present = $false }; continue }
    $sub = Join-Path (Join-Path $dir 'files') $k
    New-Item -ItemType Directory -Path $sub -Force | Out-Null
    $dst = Join-Path $sub (Split-Path $src -Leaf)
    Copy-Item $src $dst -Force
    $si = Get-Item $src
    $entries += [ordered]@{
      logical = $k; source = $src; present = $true
      stored = $dst; sha256 = (Get-Sha $dst); bytes = $si.Length
      mtime = $si.LastWriteTimeUtc.ToString('o')
    }
  }
  $gitHead = ''
  try { $gitHead = [string](& $GitExe -C $RepoRoot rev-parse HEAD 2>$null) } catch {}
  $gitBranch = ''
  try { $gitBranch = [string](& $GitExe -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null) } catch {}
  $gitDirty = @()
  try { $gitDirty = @(& $GitExe -C $RepoRoot status --porcelain=v1 2>$null) } catch {}
  $dshVersion = ''
  foreach ($pj in @('C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\package.json', (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'))) {
    if ($dshVersion -eq '' -and (Test-Path $pj)) { try { $dshVersion = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch {} }
  }
  if ($dshVersion -eq '') { try { $dshVersion = [string](& $DshExe --version 2>$null | Select-Object -First 1) } catch {} }
  $manifest = [ordered]@{
    schema = 'ptc-config-snapshot/v1'
    created = (Get-Date).ToUniversalTime().ToString('o')
    reason = $Reason
    host = "$env:COMPUTERNAME"
    repoRoot = $RepoRoot
    dshVersion = ("$dshVersion").Trim()
    git = [ordered]@{ branch = ("$gitBranch").Trim(); head = ("$gitHead").Trim(); dirtyCount = @($gitDirty).Count; dirty = @($gitDirty) }
    files = $entries
  }
  [System.IO.File]::WriteAllText((Join-Path $dir 'MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 8), $Utf8)

  $lines = @(
    ('# ptc-config snapshot ' + $ts),
    '',
    ('原因: ' + $Reason),
    ('宿主: ' + "$env:COMPUTERNAME" + '  DSH: ' + ("$dshVersion").Trim()),
    ('仓库: ' + $RepoRoot + ' @ ' + ("$gitBranch").Trim() + ' ' + ("$gitHead").Trim() + '  未提交项 ' + @($gitDirty).Count),
    '',
    '## 本快照覆盖的改动（2026-11-06）',
    '',
    '1. ACP opencode / kimi 通道默认关闭（disabled: true，配置全部保留）',
    '   profile: subagent-acp-opencode / subagent-acp-kimi / tool-subagent-opencode-dsv41 / tool-subagent-kimi-docs / tool-subagent-opencode / tool-subagent-kimi',
    '   PTC bundle: subagent-acp-opencode-dsv41 / subagent-acp-kimi-docs / tool-subagent-opencode-dsv41 / tool-subagent-kimi-docs',
    '   subagent-acp-cursor-grok 未动（保留）',
    '2. subagent_codex_astra 改绑 codex-relay/gpt-6-astra + reasoning_effort=high（此前 gpt-6.1-sol + xhigh）',
    '3. codex-relay 模型目录新增 gpt-6-astra，删除已下线的 gpt-5.5；gpt-6 显示名由 GPT-6 (Astra) 改为 GPT-6',
    '4. public-runtime-config.json: design.astraModel=gpt-6-astra, design.effort=high',
    '5. SKILL.md / ptc_route.py 文案与判定说明同步',
    '6. AGENTS.md 4.7 新增插件安装闸门（先 plugtest 后 web；禁止在活动 profile 上直接改）',
    '7. 新建 plugtest profile（3081，镜像 web 依赖与 bundle 顺序）',
    '',
    '## 回滚',
    '',
    '  # 1) 预览（默认 DryRun，只打印计划）',
    '  pwsh -NoProfile -File ' + (Join-Path $RepoRoot 'scripts\config-snapshot.ps1') + ' restore -Snapshot ' + $dir,
    '  # 2) 真写回（自动先写 pre-restore 安全快照）',
    '  pwsh -NoProfile -File ' + (Join-Path $RepoRoot 'scripts\config-snapshot.ps1') + ' restore -Snapshot ' + $dir + ' -Apply',
    '  # 3) 重启 DSH 并开新会话（工具表在会话启动时生成）',
    '',
    '## 文件清单',
    ''
  )
  foreach ($e in $entries) {
    if ($e.present) { $lines += ('- ' + $e.logical + ' <- ' + $e.source + ' (' + $e.bytes + ' B, ' + $e.sha256.Substring(0, 12) + ')') }
    else { $lines += ('- ' + $e.logical + ' 缺失: ' + $e.source) }
  }
  [System.IO.File]::WriteAllText((Join-Path $dir 'CHANGES.md'), ($lines -join [Environment]::NewLine), $Utf8)
  return $dir
}

function Get-LatestSnapshot([string]$Root) {
  $d = Get-ChildItem $Root -Directory -Filter 'ptc-config-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $d) { throw ('没有找到 ptc-config-* 快照: ' + $Root) }
  return $d.FullName
}

switch ($Command) {
  'backup' {
    $dir = New-Snapshot -Root $Dest -Reason '手动一键快照（scripts/config-snapshot.ps1 backup）'
    Write-Host ('SNAPSHOT: ' + $dir)
    $m = Get-Content (Join-Path $dir 'MANIFEST.json') -Raw | ConvertFrom-Json
    Write-Host ('FILES: ' + @($m.files | Where-Object { $_.present }).Count + '/' + $Files.Count + ' captured; dirty=' + $m.git.dirtyCount)
    $m.files | ForEach-Object { if ($_.present) { Write-Host ('  ' + $_.logical + ' ' + $_.sha256.Substring(0, 12)) } else { Write-Host ('  MISSING ' + $_.logical) } }
    Write-Host 'NEXT: pwsh -NoProfile -File scripts/config-snapshot.ps1 verify'
  }
  'verify' {
    if (-not $Snapshot) { $Snapshot = Get-LatestSnapshot $Dest }
    $mf = Join-Path $Snapshot 'MANIFEST.json'
    if (-not (Test-Path $mf)) { throw ('不是快照目录（缺 MANIFEST.json）: ' + $Snapshot) }
    $m = Get-Content $mf -Raw | ConvertFrom-Json
    $ok = 0; $bad = @()
    foreach ($e in $m.files) {
      if (-not $e.present) { $bad += ($e.logical + ': 备份时即缺失'); continue }
      if (-not (Test-Path $e.stored)) { $bad += ($e.logical + ': 快照内文件丢失'); continue }
      $h = Get-Sha $e.stored
      if ($h -eq $e.sha256) { $ok++ } else { $bad += ($e.logical + ': SHA256 不一致') }
    }
    Write-Host ('SNAPSHOT: ' + $Snapshot)
    Write-Host ('SCHEMA: ' + $m.schema + '  CREATED: ' + $m.created)
    Write-Host ('OK: ' + $ok + '/' + @($m.files).Count)
    if ($bad.Count) { $bad | ForEach-Object { Write-Host ('PROBLEM: ' + $_) }; exit 2 } else { Write-Host 'PROBLEMS: none' }
  }
  'restore' {
    if (-not $Snapshot) { $Snapshot = Get-LatestSnapshot $Dest }
    $mf = Join-Path $Snapshot 'MANIFEST.json'
    if (-not (Test-Path $mf)) { throw ('不是快照目录（缺 MANIFEST.json）: ' + $Snapshot) }
    $m = Get-Content $mf -Raw | ConvertFrom-Json
    Write-Host ('PLAN: 从快照 ' + $Snapshot + ' 写回 ' + @($m.files | Where-Object { $_.present }).Count + ' 个文件')
    $todo = @()
    foreach ($e in $m.files) {
      if (-not $e.present) { continue }
      $curHash = ''
      if (Test-Path $e.source) { $curHash = Get-Sha $e.source }
      $state = 'overwrite'
      if ($curHash -eq $e.sha256) { $state = 'same' } elseif ($curHash -eq '') { $state = 'create' }
      Write-Host ('  [' + $state + '] ' + $e.logical + ' -> ' + $e.source)
      $todo += [pscustomobject]@{ entry = $e; state = $state }
    }
    if (-not $Apply) { Write-Host 'DRY-RUN: 未写任何文件。要真写回请加 -Apply'; break }
    $pre = New-Snapshot -Root $Dest -Reason ('restore 前安全快照（写回 ' + (Split-Path $Snapshot -Leaf) + ' 之前）')
    Write-Host ('PRE-RESTORE: ' + $pre)
    foreach ($t in $todo) {
      $e = $t.entry
      if ($t.state -eq 'same') { continue }
      $parent = Split-Path $e.source -Parent
      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item $e.stored $e.source -Force
      Write-Host ('  WROTE ' + $e.source)
    }
    Write-Host 'DONE: 请重启 DSH 并开新会话（工具表在会话启动时生成）'
  }
  'list' {
    Get-ChildItem $Dest -Directory -Filter 'ptc-config-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      $mf = Join-Path $_.FullName 'MANIFEST.json'
      $cnt = '-'
      if (Test-Path $mf) { $cnt = @((Get-Content $mf -Raw | ConvertFrom-Json).files | Where-Object { $_.present }).Count }
      Write-Host ($_.Name + '  files=' + $cnt + '  ' + $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
    }
  }
}
