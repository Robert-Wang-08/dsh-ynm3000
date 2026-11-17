<#
.SYNOPSIS
  一键同步：更新 web profile 的插件与配置，并把同一层镜像到 superagent profile。

.DESCRIPTION
  已安装设备的一键入口。按顺序做：

    1) 解析 web profile 的 dsh-config-pack 来源：
       - 发布版（github:...#vX.Y.Z / 其它非 link spec）→ 调 dsh-config-pack\scripts\update.ps1；
       - link: 开发态 → 跳过发布版更新（该类 profile 以 git pull + 重启生效）。
    2) 把更新后的 web 插件与配置镜像到 superagent profile
       （dsh-superagent-profile-sync.ps1：保留 superagent 独有依赖 / bundle / patch 覆盖）。
    3) 对两个 profile 各跑一次 dsh --profile <p> --dump-config 组合校验。

  安全边界：
    - 写入前默认拒绝「目标 profile 宿主正在运行」的情况（先停服务，避免打断在跑会话）；
      确需热改时加 -SkipHostGuard。
    - 不重启任何服务；更新完成后由人重启宿主并新开顶层会话。
    - 不拉取 Git 仓库（link 开发态先自行 git pull 对应仓库）。

.PARAMETER Profiles
  要更新并验收的 profile，默认 web + superagent。

.PARAMETER Source
  透传给 update.ps1 的安装源（github:Robert-Wang-08/dsh-config-pack#vX.Y.Z）；留空自动取最新 tag。

.PARAMETER SkipOptional
  透传给 update.ps1：跳过可选三方插件组。

.PARAMETER Force
  透传给 update.ps1：版本相同也强制重跑安装。

.PARAMETER NoVerify
  跳过最后的 --dump-config 校验。

.PARAMETER DryRun
  只打印计划：不更新、不镜像、不写文件、不校验。

.PARAMETER SkipPackUpdate
  跳过 web 的发布版更新，只做 superagent 镜像（link 开发态常用）。

.PARAMETER DshHome
  DSH 主目录；默认 $env:DSH_HOME，其次 %USERPROFILE%\.dsh。测试时指向合成目录。

.PARAMETER PackRoot
  dsh-config-pack 检出目录；默认本仓库下的 dsh-config-pack，其次 web profile 里 link: 指向的目录。

.PARAMETER UpdateScript
  覆盖 update.ps1 路径（默认 <PackRoot>\scripts\update.ps1）。测试或多份检出时使用。

.PARAMETER SyncScript
  覆盖镜像脚本路径（默认本目录的 dsh-superagent-profile-sync.ps1）。

.PARAMETER SkipHostGuard
  跳过宿主运行检查（默认拒绝热改正在运行的 profile）。

.EXAMPLE
  pwsh -File dsh-sync.ps1                    # 更新 web 并镜像到 superagent
  pwsh -File dsh-sync.ps1 -DryRun            # 只看计划
  pwsh -File dsh-sync.ps1 -Profiles web      # 只更新 web
  pwsh -File dsh-sync.ps1 -SkipPackUpdate    # link 开发态：只做 superagent 镜像
#>
[CmdletBinding()]
param(
  [string[]]$Profiles = @('web', 'superagent'),
  [string]$Source = '',
  [switch]$SkipOptional,
  [switch]$Force,
  [switch]$NoVerify,
  [switch]$DryRun,
  [switch]$SkipPackUpdate,
  [string]$DshHome = '',
  [string]$PackRoot = '',
  [string]$UpdateScript = '',
  [string]$SyncScript = '',
  [switch]$SkipHostGuard
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Fail([string]$m, [int]$code = 1) { Write-Host ('FAIL  ' + $m) -ForegroundColor Red; exit $code }
function Ok([string]$m)   { Write-Host ('ok    ' + $m) -ForegroundColor Green }
function Info([string]$m) { Write-Host ('      ' + $m) }
function Warn([string]$m) { Write-Host ('warn  ' + $m) -ForegroundColor Yellow }
function Step([string]$m) { Write-Host ('== ' + $m) -ForegroundColor Cyan }
function Plan([string]$m) { Write-Host ('plan  ' + $m) -ForegroundColor DarkCyan }

$Profiles = @($Profiles | Where-Object { $_ } | ForEach-Object { $_.Trim() })
if ($Profiles.Count -eq 0) { Fail '-Profiles 不能为空' }
foreach ($p in $Profiles) {
  if ($p -notin @('web', 'superagent')) { Fail ('未知 profile: ' + $p + '（只支持 web / superagent）') }
}
$updateWeb = $Profiles -contains 'web'
$mirrorSuperagent = $Profiles -contains 'superagent'

$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath('UserProfile') }
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $UserHome '.dsh' }
}
if (-not (Test-Path $DshHome)) { Fail ('DSH_HOME 不存在: ' + $DshHome) }
$profilesDir = Join-Path $DshHome 'profiles'
$webDir = Join-Path $profilesDir 'web'
$saDir = Join-Path $profilesDir 'superagent'
if (-not (Test-Path (Join-Path $webDir 'package.json'))) { Fail ('web profile 不存在或不完整: ' + $webDir) }
if ($Profiles -contains 'superagent' -and -not (Test-Path (Join-Path $saDir 'package.json'))) {
  Fail 'superagent profile 不存在：单 profile 设备请用 -Profiles web；要启用 superagent 先按 docs/ops/superagent-profile.md 创建'
}

function Test-ProfileHostRunning([string]$Profile) {
  try {
    $pattern = '--profile\s+["'']?' + [regex]::Escape($Profile) + '(?=[\s"'']|$)'
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    foreach ($p in $procs) { if ($p.CommandLine -and $p.CommandLine -match $pattern) { return $true } }
  } catch {
    Warn ('无法检查进程（' + $_.Exception.Message + '）；按未运行处理')
  }
  return $false
}
function Resolve-DshBin {
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if ($node) {
    $bin = Join-Path (Split-Path $node.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $bin) { return @{ node = $node.Source; bin = $bin } }
    try {
      $npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
      if ($npmRoot) {
        $bin = Join-Path $npmRoot '@deepseek-ai/dsh/lib/bin.js'
        if (Test-Path $bin) { return @{ node = $node.Source; bin = $bin } }
      }
    } catch { }
  }
  $dsh = (Get-Command dsh -ErrorAction SilentlyContinue)
  if ($dsh) { return @{ node = $null; bin = $null; dsh = $dsh.Source } }
  return $null
}
function Invoke-ProfileVerify([string]$Profile) {
  $resolved = Resolve-DshBin
  if (-not $resolved) { return [pscustomobject]@{ ok = $false; detail = '找不到 node + @deepseek-ai/dsh，无法执行 --dump-config' } }
  $logDir = Join-Path (Join-Path $DshHome 'logs') 'dsh-sync'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
  $dump = Join-Path $logDir ('dump-' + $Profile + '.yml')
  $err = $dump + '.err'
  if ($resolved.dsh) {
    & $resolved.dsh '--profile' $Profile '--dump-config' > $dump 2> $err
  } else {
    & $resolved.node $resolved.bin '--profile' $Profile '--dump-config' > $dump 2> $err
  }
  $code = $LASTEXITCODE
  $errText = if (Test-Path $err) { [System.IO.File]::ReadAllText($err) } else { '' }
  $dumpText = if (Test-Path $dump) { [System.IO.File]::ReadAllText($dump) } else { '' }
  $bad = @()
  foreach ($pattern in @('did not activate', 'patch: entry .* not found', 'patch entry .* not found')) {
    if (($errText + $dumpText) -match $pattern) { $bad += $pattern }
  }
  $ids = ([regex]::Matches($dumpText, '(?m)^\s*-?\s*id:')).Count
  if ($code -ne 0) { return [pscustomobject]@{ ok = $false; detail = ('--dump-config exit ' + $code + ': ' + $errText.Trim()) } }
  if ($bad.Count -gt 0) { return [pscustomobject]@{ ok = $false; detail = ('组合告警: ' + ($bad -join ', ')) } }
  return [pscustomobject]@{ ok = $true; detail = ($ids.ToString() + ' 个 id') }
}

# ---- 0. 解析 profile 与 pack 位置 -------------------------------------------
Step '一键同步计划'
Info ('DSH_HOME: ' + $DshHome)
Info ('profiles: ' + ($Profiles -join ', '))

$webPkg = Get-Content (Join-Path $webDir 'package.json') -Raw | ConvertFrom-Json
$webPackSpec = ''
if ($webPkg.dependencies -and $webPkg.dependencies.'dsh-config-pack') { $webPackSpec = [string]$webPkg.dependencies.'dsh-config-pack' }
Info ('web dsh-config-pack: ' + $(if ($webPackSpec) { $webPackSpec } else { '(未登记)' }))

$isLinkProfile = $webPackSpec -like 'link:*'
if (-not $PackRoot) {
  $candidate = Join-Path $PSScriptRoot 'dsh-config-pack'
  if (Test-Path (Join-Path $candidate 'scripts\update.ps1')) { $PackRoot = $candidate }
  elseif ($isLinkProfile) {
    $linkTarget = $webPackSpec.Substring(5)
    if (Test-Path (Join-Path $linkTarget 'scripts\update.ps1')) { $PackRoot = $linkTarget }
  }
}
if (-not $UpdateScript) {
  if ($PackRoot) { $UpdateScript = Join-Path $PackRoot 'scripts\update.ps1' }
}
if (-not $SyncScript) { $SyncScript = Join-Path $PSScriptRoot 'dsh-superagent-profile-sync.ps1' }
if (-not (Test-Path $SyncScript)) { Fail ('缺少镜像脚本: ' + $SyncScript) }

if ($updateWeb -and -not $SkipPackUpdate -and -not $isLinkProfile) {
  if (-not $UpdateScript -or -not (Test-Path $UpdateScript)) {
    Fail '找不到 update.ps1：请用 -PackRoot 指定 dsh-config-pack 检出目录，或加 -SkipPackUpdate'
  }
}
if ($isLinkProfile) {
  Info 'web 是 link: 开发态 profile：跳过发布版更新（先 git pull 对应仓库，再重启生效）'
}

# ---- 1. 宿主守卫 -------------------------------------------------------------
if (-not $SkipHostGuard -and -not $DryRun) {
  $running = @()
  foreach ($p in $Profiles) { if (Test-ProfileHostRunning $p) { $running += $p } }
  if ($running.Count -gt 0) {
    Fail ('以下 profile 的宿主正在运行：' + ($running -join ', ') + '。先停止对应服务（superagent: pwsh -File dsh-superagent-service.ps1 stop），再重跑；确需热改时加 -SkipHostGuard。') 3
  }
}

# ---- 2. 更新 web（发布版） ---------------------------------------------------
if ($updateWeb -and -not $SkipPackUpdate) {
  if ($isLinkProfile) {
    Ok 'web 发布版更新：跳过（link 开发态）'
  } else {
    Step ('更新 web -> ' + $(if ($Source) { $Source } else { '(远端最新 tag)' }))
    $updateArgs = @{ ProfileName = 'web' }
    if ($Source) { $updateArgs.Source = $Source }
    if ($SkipOptional) { $updateArgs.SkipOptional = $true }
    if ($Force) { $updateArgs.Force = $true }
    if ($NoVerify -or $DryRun) { $updateArgs.NoVerify = $true }
    if ($DryRun) {
      Plan ('会执行: pwsh -File ' + $UpdateScript + ' ' + (($updateArgs.GetEnumerator() | ForEach-Object { '-' + $_.Key + ' ' + $_.Value }) -join ' '))
    } else {
      & $UpdateScript @updateArgs
      if ($LASTEXITCODE -ne 0) { Fail ('update.ps1 失败 exit ' + $LASTEXITCODE + '；superagent 镜像未执行') }
      Ok 'web 更新完成'
    }
  }
} elseif ($updateWeb) {
  Warn '跳过 web 发布版更新（-SkipPackUpdate）'
}

# ---- 3. 镜像到 superagent ----------------------------------------------------
if ($mirrorSuperagent) {
  Step ('镜像 web -> superagent')
  $syncArgs = @{ DshHome = $DshHome; SourceProfile = 'web'; TargetProfile = 'superagent' }
  if ($DryRun) { $syncArgs.DryRun = $true }
  if ($NoVerify -or $DryRun) { $syncArgs.SkipVerify = $true }
  if ($SkipHostGuard) { $syncArgs.SkipHostGuard = $true }
  & $SyncScript @syncArgs
  if ($LASTEXITCODE -ne 0) { Fail ('superagent 镜像失败 exit ' + $LASTEXITCODE) }
  if ($DryRun) { Plan 'superagent 镜像计划已生成（未写入）' } else { Ok 'superagent 镜像完成' }
}

# ---- 4. 双 profile 验收 ------------------------------------------------------
$verifyOk = $true
if ($NoVerify -or $DryRun) {
  Warn '跳过 --dump-config 校验'
} else {
  foreach ($p in $Profiles) {
    Step ('校验 ' + $p)
    $result = Invoke-ProfileVerify $p
    if ($result.ok) { Ok ($p + ': --dump-config exit 0（' + $result.detail + '）') }
    else { $verifyOk = $false; Write-Host ('FAIL  ' + $p + ': ' + $result.detail) -ForegroundColor Red }
  }
}

if (-not $verifyOk) { Fail '至少一个 profile 的组合校验失败' }
if ($DryRun) { Plan 'DryRun 完成：未做任何写入。'; exit 0 }
Ok ('一键同步完成: ' + ($Profiles -join ', '))
Info '下一步：重启受影响的宿主（web 3080 / superagent 3082）并新开顶层会话，工具表与 bundle 才会刷新。'
exit 0
