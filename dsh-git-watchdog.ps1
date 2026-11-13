#Requires -Version 7.0
<#
.SYNOPSIS
    本机 Git 巡检：离线状态、受限快进更新、DSH 一键备份滞留提醒。
.DESCRIPTION
    从设备 gitsync 清单读取仓库。work 永远只读；drift/conflict 或 DryRun 全程离线。
    独立于 superagent，由 Windows 计划任务运行；不提交、不推送。
.EXAMPLE
    pwsh -NoProfile -File ./dsh-git-watchdog.ps1 -DryRun -Json
    pwsh -NoProfile -File ./dsh-git-watchdog.ps1 -NoToast
.NOTES
    退出码：0 无 issue；1 有 issue；2 配置损坏；3 预检 drift/conflict（report-only）。
    DryRun 不 fetch/拉取/通知，但照写报告与日志。NoToast 同时关闭 wxHitl。
#>
[CmdletBinding()]
param([switch]$DryRun, [switch]$NoToast, [switch]$Json, [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$deviceHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$config = @{
    gitsyncHome = $null
    autoPullGroups = @('personal','thirdparty')
    fetchGroups = @('personal','thirdparty')
    skipGroups = @('excluded')
    fetchTimeoutSeconds = 90
    backupCheck = @{ enabled = $true; backupsDir = $null; profileExts = @('cordis.yml','cordis.patch.yml','package.json','pnpm-workspace.yaml') }
    notify = @{ toast = $true; wxHitl = @{ enabled = $false; command = $null } }
    reportDir = $null
    keepReports = 20
}
$issues = [System.Collections.Generic.List[object]]::new()
$results = [System.Collections.Generic.List[object]]::new()
$log = [System.Collections.Generic.List[string]]::new()
$preflight = @{ state = 'unavailable'; suggestedAction = $null; differing = @(); autoPullBlocked = $false; warning = $null }
$backup = @{ latestBundle = $null; latestBundleAt = $null; lastMaterialChangeAt = $null; stale = $false; reasons = @() }
$notification = @{ toast = 'skipped'; toastError = $null; wxHitl = 'skipped'; wxHitlError = $null }
$configError = $false
function Add-Issue([string]$Kind, [string]$RepoId, [string]$Detail, [string]$Hint = '') {
    $item = @{ kind = $Kind; detail = $Detail }
    if ($RepoId) { $item.repo = $RepoId }
    if ($Hint) { $item.hint = $Hint }
    $issues.Add($item)
}
function Merge-Options([hashtable]$Into, [hashtable]$From) {
    foreach ($key in $From.Keys) {
        if (-not $Into.ContainsKey($key)) { throw "未知配置项：$key" }
        if ($Into[$key] -is [hashtable] -and $From[$key] -is [hashtable]) { Merge-Options $Into[$key] $From[$key] }
        else { $Into[$key] = $From[$key] }
    }
}
function Invoke-Process([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 90) {
    $p = [System.Diagnostics.Process]::new()
    $p.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $p.StartInfo.FileName = $Executable
    $p.StartInfo.UseShellExecute = $false
    $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardOutput = $true
    $p.StartInfo.RedirectStandardError = $true
    $p.StartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p.StartInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    # 禁止无人值守巡检弹出 Git 凭据输入，网络调用必须有界。
    $p.StartInfo.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $p.StartInfo.Environment['GCM_INTERACTIVE'] = 'Never'
    foreach ($arg in $Arguments) { $p.StartInfo.ArgumentList.Add($arg) }
    try {
        [void]$p.Start()
        $stdoutTask = $p.StandardOutput.ReadToEndAsync()
        $stderrTask = $p.StandardError.ReadToEndAsync()
        $timedOut = -not $p.WaitForExit($TimeoutSeconds * 1000)
        if ($timedOut) { $p.Kill($true); $p.WaitForExit() }
        return @{ exitCode = $p.ExitCode; stdout = $stdoutTask.GetAwaiter().GetResult().TrimEnd(); stderr = $stderrTask.GetAwaiter().GetResult().TrimEnd(); timedOut = $timedOut }
    }
    catch { return @{ exitCode = -1; stdout = ''; stderr = $_.Exception.Message; timedOut = $false } }
    finally { $p.Dispose() }
}
function Invoke-Git([string]$RepoPath, [string[]]$Arguments, [int]$TimeoutSeconds = 90) {
    return Invoke-Process 'git' (@('--no-optional-locks','-c','core.quotepath=false','-C',$RepoPath) + $Arguments) $TimeoutSeconds
}
function Update-Counts([hashtable]$Row) {
    $counts = Invoke-Git $Row.path @('rev-list','--left-right','--count','@{upstream}...HEAD')
    if ($counts.exitCode -ne 0) { $Row.noUpstream = $true; return }
    $parts = $counts.stdout.Trim() -split '\s+'
    $Row.behind = [int]$parts[0]; $Row.ahead = [int]$parts[1]; $Row.noUpstream = $false
}
function Resolve-GitsyncHome {
    if ($config.gitsyncHome) { return [string]$config.gitsyncHome }
    if ($env:GITSYNC_HOME) { return $env:GITSYNC_HOME }
    $deviceConfig = Join-Path $HOME '.dsh/device/gitsync.json'
    if (Test-Path -LiteralPath $deviceConfig) {
        $entry = Get-Content -LiteralPath $deviceConfig -Raw -Encoding utf8 | ConvertFrom-Json
        if ($entry.home) { return [string]$entry.home }
    }
    # 常见 父目录/gitsync 从仓库父目录派生，跨设备不依赖固定盘符。
    $sibling = Join-Path (Split-Path -Parent $PSScriptRoot) 'gitsync'
    if (Test-Path -LiteralPath (Join-Path $sibling 'repos.json')) { return $sibling }
    return (Join-Path $HOME 'src/gitsync')
}
try {
    if (-not $ConfigPath) { $ConfigPath = $env:DSH_GIT_WATCHDOG_CONFIG }
    if (-not $ConfigPath) { $ConfigPath = Join-Path $HOME '.dsh/device/git-watchdog.json' }
    if (Test-Path -LiteralPath $ConfigPath) { Merge-Options $config (Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable) }
    foreach ($key in @('fetchTimeoutSeconds','keepReports')) {
        if ($config[$key] -isnot [int] -and $config[$key] -isnot [long]) { throw "$key 必须是整数" }
        if ($config[$key] -lt 1 -or $config[$key] -gt 3600) { throw "$key 必须在 1..3600 之间" }
    }
    foreach ($key in @('fetchGroups','autoPullGroups','skipGroups')) {
        if ($config[$key] -isnot [array]) { throw "$key 必须是数组" }
    }
    if ($config.backupCheck -isnot [hashtable] -or $config.notify -isnot [hashtable] -or $config.notify.wxHitl -isnot [hashtable]) { throw 'backupCheck/notify/wxHitl 必须是对象' }
    foreach ($flag in @($config.backupCheck.enabled,$config.notify.toast,$config.notify.wxHitl.enabled)) { if ($flag -isnot [bool]) { throw 'enabled/toast 必须是布尔值' } }
    if ($config.backupCheck.profileExts -isnot [array]) { throw 'profileExts 必须是文件名数组' }
    foreach ($name in $config.backupCheck.profileExts) { if ($name -match '[\\/]' -or $name -in @('.','..')) { throw 'profileExts 仅允许文件名' } }
    # work 组硬排除，设备配置不能放开铁律。
    $config.fetchGroups = @($config.fetchGroups | Where-Object { $_ -ne 'work' })
    $config.autoPullGroups = @($config.autoPullGroups | Where-Object { $_ -ne 'work' })
    $config.gitsyncHome = Resolve-GitsyncHome
    if (-not $config.reportDir) { $config.reportDir = Join-Path $PSScriptRoot '.ptc/reports' }
    if (-not $config.backupCheck.backupsDir) { $config.backupCheck.backupsDir = Join-Path $env:USERPROFILE '.dsh/backups' }
    $manifestPath = Join-Path $config.gitsyncHome 'repos.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'repos.json 缺失' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    if ($manifest.repos -isnot [array]) { throw 'repos.json 的 repos 必须是数组' }
    foreach ($repo in $manifest.repos) { if (-not $repo.id -or -not $repo.path -or -not $repo.group) { throw 'repos.json 条目缺少 id/path/group' } }
}
catch {
    $configError = $true
    Add-Issue 'configError' '' ('git-watchdog 配置损坏：' + $_.Exception.Message)
    # 损坏配置不能破坏默认报告落点及保留策略。
    $config.reportDir = Join-Path $PSScriptRoot '.ptc/reports'
    $config.keepReports = 20
}
if (-not $configError) {
    $preflightScript = Join-Path $HOME '.agents/skills/local-git-sync/scripts/engine-preflight.ps1'
    if (Test-Path -LiteralPath $preflightScript) {
        # 显式 UTF-8，避免无控制台/计划任务环境把中文 suggestedAction 编成系统代码页。
        $preflightCommand = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ' + "'" + $preflightScript.Replace("'", "''") + "' -Target '" + $config.gitsyncHome.Replace("'", "''") + "' -Json -NoState; " + 'exit $LASTEXITCODE'
        $preflightEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($preflightCommand))
        $check = Invoke-Process (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-NonInteractive','-EncodedCommand',$preflightEncoded) 120
        try {
            if ($check.timedOut) { throw '预检超时' }
            $state = $check.stdout | ConvertFrom-Json -AsHashtable
            if ($state.state -notin @('in-sync','fresh','drift','conflict')) { throw '预检返回未知 state' }
            $preflight.state = $state.state
            $preflight.suggestedAction = $state.suggestedAction
            $preflight.differing = @($state.differing)
        }
        catch {
            # 存在但无法完成的预检不能静默放开同步。
            $preflight.state = 'conflict'
            $preflight.warning = '预检执行失败：' + $_.Exception.Message
        }
    }
    else { $preflight.warning = '引擎预检脚本不可用，按约定允许受限快进' }
    $preflight.autoPullBlocked = $preflight.state -in @('drift','conflict')
    if ($preflight.autoPullBlocked) { Add-Issue 'preflight' '' ('引擎预检 ' + $preflight.state + '：report-only，跳过 fetch 与自动拉取') '请管理人决策引擎差异' }
    if ($preflight.warning) { Add-Issue 'preflightWarning' '' $preflight.warning }
    foreach ($repo in $manifest.repos) {
        $row = @{
            id = $repo.id; path = $repo.path; group = $repo.group; branch = $null
            dirtyCount = 0; behind = 0; ahead = 0; fetched = $false; pulled = $false
            pullError = $null; fetchError = $null; fetchTimeout = $false
            skipped = $false; skipReason = $null; head = $null; detached = $false; noUpstream = $false
            action = 'ok'; hint = $null
        }
        $results.Add($row)
        if ($repo.stale -eq $true) { $row.skipped = $true; $row.skipReason = 'stale'; continue }
        if ($repo.group -in $config.skipGroups) { $row.skipped = $true; $row.skipReason = 'skipGroup'; continue }
        if (-not (Test-Path -LiteralPath $repo.path -PathType Container)) {
            $row.skipped = $true; $row.skipReason = 'missing'
            Add-Issue 'missing' $repo.id '清单有但磁盘缺失'; continue
        }
        $status = Invoke-Git $repo.path @('status','--porcelain=v1','-b')
        if ($status.exitCode -ne 0) {
            $row.skipped = $true; $row.skipReason = 'statusError'
            Add-Issue 'statusError' $repo.id $status.stderr; continue
        }
        # porcelain 每个非头部非空行计一处（含子模块脏标记），不是文件内容行数。
        $lines = @($status.stdout -split '\r?\n' | Where-Object { $_ })
        $row.dirtyCount = @($lines | Where-Object { -not $_.StartsWith('## ') }).Count
        $branch = Invoke-Git $repo.path @('symbolic-ref','--quiet','--short','HEAD')
        $row.detached = $branch.exitCode -ne 0
        $row.branch = if ($row.detached) { 'HEAD (detached)' } else { $branch.stdout }
        $head = Invoke-Git $repo.path @('rev-parse','--short','HEAD'); $row.head = $head.stdout
        Update-Counts $row
        # report-only/DryRun 不写远端跟踪引用；work 即使配置误加也不 fetch。
        if (-not $DryRun -and -not $preflight.autoPullBlocked -and $repo.group -ne 'work' -and $repo.group -in $config.fetchGroups) {
            $fetch = Invoke-Git $repo.path @('fetch','--prune','--quiet') $config.fetchTimeoutSeconds
            if ($fetch.timedOut) { $row.fetchTimeout = $true; $row.fetchError = 'fetchTimeout' }
            elseif ($fetch.exitCode -ne 0) { $row.fetchError = $fetch.stderr }
            else { $row.fetched = $true; Update-Counts $row }
            if ($row.fetchError) { Add-Issue 'fetchError' $repo.id $row.fetchError '远端可能不可达；work 组默认且强制不 fetch' }
        }
        if ($row.detached) { Add-Issue 'detached' $repo.id 'HEAD 无分支，需人工处理' }
        elseif ($row.noUpstream) { Add-Issue 'noUpstream' $repo.id '无上游或上游不可解析，需人工处理' }
        if ($row.dirtyCount -gt 0) {
            $row.action = 'notify'; $row.hint = "有 $($row.dirtyCount) 处未提交内容，请管理人处理（推送或合并）"
            Add-Issue 'dirty' $repo.id $row.hint
        }
        if ($row.ahead -gt 0) { Add-Issue 'ahead' $repo.id "本地领先 $($row.ahead) 个提交未推送" '请管理人推送；dsh 工作区通常走一键提交与备份' }
        if ($row.behind -gt 0) {
            $canPull = $row.dirtyCount -eq 0 -and $row.ahead -eq 0 -and -not $row.detached -and -not $row.noUpstream -and $repo.group -ne 'work' -and $repo.group -in $config.autoPullGroups -and $repo.pull -ne $false -and -not $preflight.autoPullBlocked -and -not $DryRun -and $row.fetched
            if ($canPull) {
                $pull = Invoke-Git $repo.path @('merge','--ff-only','@{upstream}') $config.fetchTimeoutSeconds
                if ($pull.exitCode -eq 0 -and -not $pull.timedOut) {
                    $row.pulled = $true; $row.action = 'pulled'
                    $head = Invoke-Git $repo.path @('rev-parse','--short','HEAD'); $row.head = $head.stdout
                    Update-Counts $row
                }
                else { $row.pullError = if ($pull.timedOut) { 'ff-only 超时' } else { $pull.stderr }; Add-Issue 'pullError' $repo.id $row.pullError }
            }
            if (-not $row.pulled) {
                $reason = if ($repo.group -eq 'work' -or $repo.group -notin $config.autoPullGroups) { '按铁律不自动拉取' }
                    elseif ($preflight.autoPullBlocked) { '引擎预检门槛阻止自动拉取' }
                    elseif ($DryRun) { 'DryRun 不拉取' }
                    elseif ($repo.pull -eq $false) { '清单禁用 pull' }
                    elseif (-not $row.fetched) { '本轮未成功 fetch，不使用过期引用自动拉取' }
                    else { '脏工作区、领先/分叉或异常状态需要人工处理' }
                Add-Issue 'behindBlocked' $repo.id "落后 $($row.behind) 个提交，$reason" ('管理人确认后可执行 git -C "' + $repo.path + '" pull --ff-only')
            }
        }
    }
    if ($config.backupCheck.enabled) {
        $reasons = [System.Collections.Generic.List[string]]::new()
        $lastChange = $null; $bundleAt = $null
        try {
            $latest = Get-ChildItem -LiteralPath $config.backupCheck.backupsDir -Directory -Filter 'dsh-backup-*' -ErrorAction SilentlyContinue |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bundle.json') } | Sort-Object Name -Descending | Select-Object -First 1
            if ($latest) {
                $backup.latestBundle = Join-Path $latest.FullName 'bundle.json'
                $bundle = Get-Content -LiteralPath $backup.latestBundle -Raw -Encoding utf8 | ConvertFrom-Json
                if (-not $bundle.created_at) { throw 'bundle.created_at 缺失' }
                # PowerShell 7.5+ JSON 自动解析 ISO 日期；强制 Parse 会丢时区与小数秒。
                $bundleAt = [datetimeoffset]$bundle.created_at
                $backup.latestBundleAt = $bundleAt.ToUniversalTime().ToString('o')
            }
            else { $reasons.Add('未找到 bundle') }
        }
        catch { $reasons.Add('bundle 无法读取或 created_at 无效：' + $_.Exception.Message) }
        $rootPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')
        foreach ($repo in $manifest.repos) {
            $repoPath = [System.IO.Path]::GetFullPath($repo.path).TrimEnd('\','/')
            if ($repoPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or $repoPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
                $commit = Invoke-Git $repo.path @('log','-1','--format=%cI')
                if ($commit.exitCode -eq 0 -and $commit.stdout) {
                    try { $when = [datetimeoffset]::Parse($commit.stdout); if (-not $lastChange -or $when -gt $lastChange) { $lastChange = $when } } catch { $reasons.Add('提交时间无法解析：' + $repo.id) }
                }
            }
        }
        $materialFiles = @('dsh-commit-backup.ps1','dsh-restore.ps1','dsh-config-pack/scripts/dsh-backup.ps1','dsh-config-pack/scripts/snapshot.mjs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
        $profilesDir = Join-Path $deviceHome 'profiles'
        foreach ($profile in @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)) {
            foreach ($name in $config.backupCheck.profileExts) { $materialFiles += Join-Path $profile.FullName $name }
        }
        foreach ($file in $materialFiles) {
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                $when = [datetimeoffset](Get-Item -LiteralPath $file).LastWriteTimeUtc
                if (-not $lastChange -or $when -gt $lastChange) { $lastChange = $when }
            }
        }
        if ($lastChange) { $backup.lastMaterialChangeAt = $lastChange.ToUniversalTime().ToString('o') }
        if ($bundleAt -and $lastChange -gt $bundleAt) { $reasons.Add('最近实质变化晚于 bundle.created_at（零容差）') }
        # -Status 会生成 backup=null；只检查最近一份真实备份回执，避免空回执遮蔽失败。
        foreach ($receipt in @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.ptc/reports') -Filter 'commit-backup-*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
            try {
                $closeout = Get-Content -LiteralPath $receipt.FullName -Raw -Encoding utf8 | ConvertFrom-Json
                if ($null -ne $closeout.backup) {
                    if ($closeout.backup.status -ne 'ok') { $reasons.Add('最近收口备份状态：' + $closeout.backup.status) }
                    break
                }
            }
            catch { $reasons.Add('收口回执不可读：' + $receipt.Name); break }
        }
        $backup.reasons = @($reasons)
        $backup.stale = -not $bundleAt -or ($lastChange -and $lastChange -gt $bundleAt) -or $reasons.Count -gt 0
        if ($backup.stale) { Add-Issue 'backupStale' '' 'dsh 一键备份需要更新' "运行 pwsh -NoProfile -File ./dsh-commit-backup.ps1 -Push -Message 'chore: 收口备份'" }
    }
}
$summary = @{
    reposChecked = @($results | Where-Object { -not $_.skipped }).Count
    dirty = @($results | Where-Object { $_.dirtyCount -gt 0 }).Count
    behindBlocked = @($issues | Where-Object { $_.kind -eq 'behindBlocked' }).Count
    aheadUnpushed = @($results | Where-Object { $_.ahead -gt 0 }).Count
    pulled = @($results | Where-Object { $_.pulled }).Count
    stale = @($results | Where-Object { $_.skipReason -eq 'stale' }).Count
    issues = $issues.Count
}
$message = if ($configError) { $issues[0].detail } else { "$($summary.dirty) 仓有未提交 · $($summary.issues) 项需人工 · 备份" + $(if ($backup.stale) { '需更新' } else { '正常或已禁用' }) }
if ($message.Length -gt 200) { $message = $message.Substring(0,200) }
if ($issues.Count -gt 0 -and -not $DryRun -and -not $NoToast) {
    if ($config.notify.toast) {
        try {
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
            [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
            $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
            $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>DSH Git 巡检</text><text>' + [System.Security.SecurityElement]::Escape($message) + '</text></binding></visual></toast>')
            $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH.GitWatchdog').Show($toast)
            $notification.toast = 'sent'
        }
        catch { $notification.toast = 'failed'; $notification.toastError = $_.Exception.Message }
    }
    if ($config.notify.wxHitl.enabled -and $config.notify.wxHitl.command) {
        try {
            # 配置 command 是可信 PowerShell 表达式；%MESSAGE% 代换为已单引号转义的字面量。
            $command = $config.notify.wxHitl.command.Replace('%MESSAGE%', ("'" + $message.Replace("'", "''") + "'"))
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
            $sent = Invoke-Process (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) 30
            if ($sent.exitCode -ne 0 -or $sent.timedOut) { throw ('通知失败：' + $sent.stderr) }
            $notification.wxHitl = 'sent'
        }
        catch { $notification.wxHitl = 'failed'; $notification.wxHitlError = $_.Exception.Message }
    }
}
$report = [ordered]@{ runAt = [datetimeoffset]::UtcNow.ToString('o'); dryRun = [bool]$DryRun; preflight = $preflight; config = $config; repos = @($results); backupCheck = $backup; issues = @($issues); notify = $notification; summary = $summary }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$logDir = Join-Path $PSScriptRoot '.ptc/logs'
try {
    [void](New-Item -ItemType Directory -Path $config.reportDir -Force)
    [void](New-Item -ItemType Directory -Path $logDir -Force)
    $reportPath = Join-Path $config.reportDir "git-watchdog-$stamp.json"
    $logPath = Join-Path $logDir "git-watchdog-$stamp.log"
    $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
    $log.Add("$($report.runAt) preflight=$($preflight.state) dryRun=$([bool]$DryRun) $message")
    foreach ($issue in $issues) { $log.Add("[$($issue.kind)] $($issue.repo) $($issue.detail) $($issue.hint)") }
    foreach ($row in $results) { $log.Add("repo=$($row.id) skipped=$($row.skipped) dirty=$($row.dirtyCount) ahead=$($row.ahead) behind=$($row.behind) fetched=$($row.fetched) pulled=$($row.pulled)") }
    $log | Set-Content -LiteralPath $logPath -Encoding utf8NoBOM
    foreach ($target in @(@{dir=$config.reportDir;filter='git-watchdog-*.json'},@{dir=$logDir;filter='git-watchdog-*.log'})) {
        # 只清理本脚本前缀的常规文件；不递归、不接触其他回执。
        Get-ChildItem -LiteralPath $target.dir -Filter $target.filter -File | Sort-Object Name -Descending | Select-Object -Skip $config.keepReports | ForEach-Object {
            $resolved = [System.IO.Path]::GetFullPath($_.FullName)
            if ([System.IO.Path]::GetDirectoryName($resolved) -ne [System.IO.Path]::GetFullPath($target.dir).TrimEnd('\','/')) { throw '报告清理路径不匹配' }
            Remove-Item -LiteralPath $resolved -Force
        }
    }
}
catch { if ($Json) { [Console]::Error.WriteLine('报告或日志落盘失败：' + $_.Exception.Message) } else { Write-Warning ('报告或日志落盘失败：' + $_.Exception.Message) }; $configError = $true }
if ($Json) { $report | ConvertTo-Json -Depth 20 }
else {
    foreach ($issue in $issues) { Write-Output ("[$($issue.kind)] $($issue.repo) $($issue.detail) $($issue.hint)") }
    $results | Where-Object { $_.pulled } | ForEach-Object { Write-Output ("[pulled] $($_.id) HEAD=$($_.head)") }
    Write-Output ("检查 $($summary.reposChecked) 仓 | 脏 $($summary.dirty) | 领先 $($summary.aheadUnpushed) | 拉取 $($summary.pulled) | issue $($summary.issues) | preflight=$($preflight.state)")
    Write-Output ("报告：$reportPath；日志：$logPath")
}
if ($configError) { exit 2 }
if ($preflight.autoPullBlocked) { exit 3 }
if ($issues.Count -gt 0) { exit 1 }
exit 0
