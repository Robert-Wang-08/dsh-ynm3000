#Requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$SkipBackup,
  [switch]$SkipSuperagentRebuild,
  [switch]$SkipSuperagentRestart,
  [switch]$SkipWebRestart,
  [switch]$RunTests,
  [string[]]$Submodules = @('dsh-provider-failover', 'dsh-wechat-hitl'),
  [int]$WebRestartDelaySeconds = 15,
  [string]$RunId = '',
  [switch]$WebRestartChild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if (-not $RunId) { $RunId = Get-Date -Format 'yyyyMMdd-HHmmss' }
$mainLog = Join-Path $logDir ("deploy-latest-$RunId.log")
$webOut = Join-Path $logDir ("web-restart-$RunId.out.log")
$webErr = Join-Path $logDir ("web-restart-$RunId.err.log")
$webReceipt = Join-Path $logDir ("deploy-latest-$RunId.web.json")

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $mainLog -Value $line -Encoding utf8
}

function Invoke-Git([string]$Repo, [string[]]$Arguments, [switch]$AllowFail) {
  $out = & git --no-optional-locks -C $Repo @Arguments 2>&1
  $code = $LASTEXITCODE
  $text = ($out | Out-String).Trim()
  if ($text) { Write-Log ("git -C {0} {1}`n{2}" -f $Repo, ($Arguments -join ' '), $text) }
  if ($code -ne 0 -and -not $AllowFail) {
    throw ("git -C {0} {1} 退出码 {2}" -f $Repo, ($Arguments -join ' '), $code)
  }
  return [pscustomobject]@{ Code = $code; Text = $text; Lines = @($out) }
}

function Get-Branch([string]$Repo) {
  return ((& git -C $Repo rev-parse --abbrev-ref HEAD) | Out-String).Trim()
}

function Get-DefaultBranch([string]$Repo) {
  $remoteHead = (& git -C $Repo symbolic-ref --short refs/remotes/origin/HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -eq 0 -and $remoteHead) { return ($remoteHead -replace '^origin/', '') }
  return 'main'
}

function Assert-Clean([string]$Repo, [string]$Name) {
  $dirty = (& git -C $Repo status --porcelain | Out-String).Trim()
  if ($dirty) { throw ("{0} 工作区不干净，先提交或 stash：`n{1}" -f $Name, $dirty) }
}

function Sync-Repo([string]$Repo, [string]$Name, [switch]$AllowDirty) {
  if (-not $AllowDirty) { Assert-Clean $Repo $Name }
  Invoke-Git $Repo @('fetch', '--prune', 'origin') | Out-Null
  $branch = Get-Branch $Repo
  if ($branch -eq 'HEAD') {
    $branch = Get-DefaultBranch $Repo
    Invoke-Git $Repo @('checkout', $branch) | Out-Null
  }
  $target = "origin/$branch"
  $counts = ((& git -C $Repo rev-list --left-right --count "HEAD...$target" | Out-String).Trim() -split '\s+')
  $ahead = [int]$counts[0]
  $behind = [int]$counts[1]
  Write-Log ("{0}: branch={1} ahead={2} behind={3}" -f $Name, $branch, $ahead, $behind)
  if ($behind -gt 0) { Invoke-Git $Repo @('merge', '--ff-only', $target) | Out-Null }
  return [pscustomobject]@{ Repo = $Repo; Name = $Name; Branch = $branch; Ahead = $ahead; Behind = $behind }
}

if ($WebRestartChild) {
  try {
    Write-Log 'web restart child: waiting before stopping 3080'
    Start-Sleep -Seconds $WebRestartDelaySeconds
    $listeners = @(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      Write-Log ("web restart child: stopping pid={0}" -f $listener.OwningProcess)
      Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) {
      Start-Sleep -Seconds 1
    }
    if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { throw 'port 3080 still listening after stop' }
    Write-Log 'web restart child: web stopped'
    $safe = Join-Path $root 'dsh-permission-compat\tools\dsh-web-safe.ps1'
    $proc = Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $safe) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $webOut -RedirectStandardError $webErr -PassThru
    Write-Log ("web restart child: launcher pid={0}" -f $proc.Id)
    $deadline = (Get-Date).AddSeconds(300)
    $up = $false
    while ((Get-Date) -lt $deadline) {
      if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
      if ($proc.HasExited) { throw ("web launcher exited early with code {0}" -f $proc.ExitCode) }
      Start-Sleep -Seconds 2
    }
    if (-not $up) { throw 'web did not listen on 3080 within 300s' }
    $webPid = (Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -First 1).OwningProcess
    Write-Log ("web restart child: listening pid={0}" -f $webPid)
    [ordered]@{
      status = 'ok'
      finished = (Get-Date).ToString('o')
      web_pid = $webPid
      main_log = $mainLog
      stdout = $webOut
      stderr = $webErr
    } | ConvertTo-Json | Set-Content -Path $webReceipt -Encoding utf8
    exit 0
  }
  catch {
    Write-Log ("web restart child FAILED: {0}" -f $_.Exception.Message)
    [ordered]@{
      status = 'failed'
      finished = (Get-Date).ToString('o')
      error = $_.Exception.Message
      main_log = $mainLog
      stdout = $webOut
      stderr = $webErr
    } | ConvertTo-Json | Set-Content -Path $webReceipt -Encoding utf8
    exit 1
  }
}

Write-Log ("deploy-latest start run={0} apply={1}" -f $RunId, $Apply)
Write-Log ("root={0}" -f $root)

if (-not $Apply) {
  Write-Log 'DryRun: 将执行 backup -> fetch/ff root+submodules+superagent -> 可选重建 superagent -> 重启 superagent -> 延迟重启 web'
  Write-Log ("root status:`n{0}" -f ((& git -C $root status --short | Out-String).Trim()))
  foreach ($name in $Submodules) {
    $repo = Join-Path $root $name
    if (-not (Test-Path (Join-Path $repo '.git'))) { Write-Log ("missing submodule: {0}" -f $name); continue }
    Write-Log ("{0} HEAD={1} status={2}" -f $name, ((& git -C $repo rev-parse --short HEAD) | Out-String).Trim(), (((& git -C $repo status --short | Out-String).Trim()) -replace "`n", '; '))
  }
  $sa = Join-Path $root 'dsh-superagent'
  Write-Log ("dsh-superagent HEAD={0} status={1}" -f ((& git -C $sa rev-parse --short HEAD) | Out-String).Trim(), (((& git -C $sa status --short | Out-String).Trim()) -replace "`n", '; '))
  Write-Log ("receipt would be: {0}" -f $webReceipt)
  Write-Log 'DryRun 结束；确认后加 -Apply'
  exit 0
}

try {
  if (-not $SkipBackup) {
    Write-Log 'backup: all profiles'
    & pwsh -NoProfile -File (Join-Path $root 'dsh-config-pack\scripts\dsh-backup.ps1') backup -AllProfiles
    if ($LASTEXITCODE -ne 0) { throw 'backup failed' }
  }

  $rootSync = Sync-Repo $root 'root' -AllowDirty
  foreach ($name in $Submodules) {
    $repo = Join-Path $root $name
    if (-not (Test-Path (Join-Path $repo '.git'))) { throw ("missing submodule: {0}" -f $name) }
    Sync-Repo $repo $name | Out-Null
  }

  $patchRepo = Join-Path $root 'dsh-superagent-patch'
  if (Test-Path (Join-Path $patchRepo '.git')) {
    Assert-Clean $patchRepo 'dsh-superagent-patch'
    Invoke-Git $patchRepo @('fetch', '--prune', 'origin') | Out-Null
  }

  $sa = Join-Path $root 'dsh-superagent'
  Assert-Clean $sa 'dsh-superagent'
  Invoke-Git $sa @('fetch', '--prune', 'origin') | Out-Null
  Invoke-Git $sa @('fetch', '--prune', 'upstream') | Out-Null
  $saBranch = Get-Branch $sa
  if ($saBranch -eq 'HEAD') {
    $saBranch = Get-DefaultBranch $sa
    Invoke-Git $sa @('checkout', $saBranch) | Out-Null
  }
  $saCounts = ((& git -C $sa rev-list --left-right --count "HEAD...origin/$saBranch" | Out-String).Trim() -split '\s+')
  if ([int]$saCounts[1] -gt 0) { Invoke-Git $sa @('merge', '--ff-only', "origin/$saBranch") | Out-Null }
  $up = [int]((& git -C $sa rev-list --count "HEAD..upstream/main" | Out-String).Trim())
  Write-Log ("dsh-superagent: branch={0} upstreamAhead={1}" -f $saBranch, $up)
  if ($up -gt 0) {
    throw 'upstream/main 领先，先运行 dsh-superagent-patch\scripts\upgrade.ps1 -Apply（注意其 pnpm check 在 Windows 可能失败）'
  }

  if (-not $SkipSuperagentRebuild) {
    Push-Location $sa
    try {
      & pnpm install --node-linker=hoisted
      if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
      & pnpm typecheck
      if ($LASTEXITCODE -ne 0) { throw 'pnpm typecheck failed' }
      & pnpm build
      if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
      if ($RunTests) {
        & pnpm check
        if ($LASTEXITCODE -ne 0) { throw 'pnpm check failed' }
      }
    }
    finally { Pop-Location }
  }

  if (-not $SkipSuperagentRestart) {
    & pwsh -NoProfile -File (Join-Path $root 'dsh-superagent-service.ps1') stop
    if ($LASTEXITCODE -ne 0) { throw 'superagent stop failed' }
    & pwsh -NoProfile -File (Join-Path $root 'dsh-superagent-service.ps1') start
    if ($LASTEXITCODE -ne 0) { throw 'superagent start failed' }
  }

  if (-not $SkipWebRestart) {
    $child = Start-Process -FilePath 'pwsh.exe' -ArgumentList @(
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', $PSCommandPath,
      '-WebRestartChild',
      '-RunId', $RunId,
      '-WebRestartDelaySeconds', [string]$WebRestartDelaySeconds
    ) -WindowStyle Hidden -PassThru
    Write-Log ("web restart scheduled: child pid={0} delay={1}s receipt={2}" -f $child.Id, $WebRestartDelaySeconds, $webReceipt)
  }

  Write-Log 'DONE'
}
catch {
  Write-Log ("FAILED: {0}" -f $_.Exception.Message)
  Write-Error $_.Exception.Message
  exit 1
}
