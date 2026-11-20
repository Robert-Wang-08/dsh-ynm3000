# Synthetic profiles only. Never point -DshHome at a live DSH home.
# 覆盖：superagent 镜像语义（保留目标独有依赖/bundle/patch）、幂等、DryRun、
# 缺标记保护、-KeepTargetPatch、防呆，以及 dsh-sync.ps1 的顺序/失败中断/link 开发态。
param([string]$WorkRoot = '')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $repoRoot 'dsh-superagent-profile-sync.ps1'
$oneClick = Join-Path $repoRoot 'dsh-sync.ps1'
if (-not $WorkRoot) { $WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-sync-test-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$script:passed = 0
function Check([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw ('FAILED: ' + $Message) }
  $script:passed++
  Write-Host ('PASS ' + $Message)
}
function Put([string]$Dir, [string]$Rel, [string]$Text) {
  $target = Join-Path $Dir $Rel
  New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
  [IO.File]::WriteAllText($target, $Text, (New-Object Text.UTF8Encoding($false)))
}
function Hash-Of([string]$Path) { if (-not (Test-Path $Path)) { return '<missing>' }; return (Get-FileHash $Path -Algorithm SHA256).Hash }
function Read-Json([string]$Path) { return (Get-Content $Path -Raw | ConvertFrom-Json) }
function Count-Backups([string]$DshHome) {
  $b = Join-Path $DshHome 'backups'
  if (-not (Test-Path $b)) { return 0 }
  return @(Get-ChildItem $b -Directory -Filter 'superagent-profile-sync-*' -ErrorAction SilentlyContinue).Count
}

$webPatch = @'
# web patch fixture
- id: webserver
  config:
    port: 3080
- id: agent-default-model
  config:
    model: deepseek-flash
'@
$saOwn = @'
# ── dsh-superagent 本机配置（fixture）
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: 'C:/state/superagent'
'@

function New-Fixture([string]$Name, [switch]$WebLinkPack, [switch]$DivergentNoMarker, [switch]$LocalFork, [switch]$OwnHostModel) {
  $fx = Join-Path $WorkRoot $Name
  $web = Join-Path $fx 'profiles/web'
  $sa = Join-Path $fx 'profiles/superagent'
  $packSpec = if ($WebLinkPack) { 'link:C:/nonexistent/dsh-config-pack' } else { 'github:Robert-Wang-08/dsh-config-pack#v0.11.7' }
  # 目标 profile 的宿主默认模型可以是 superagent 自己的值（镜像区，不在自有覆盖段里），
  # 用来验证同步后不会被 web 的 ais-2dsglm 覆盖。
  $targetWeb = $webPatch
  if ($OwnHostModel) {
    $targetWeb = $webPatch -replace '(?m)^- id: agent-default-model\r?\n  config:\r?\n    model: deepseek-flash$', "- id: agent-default-model`n  config:`n    provider: opencode-go`n    model: deepseek-v4.1-flash`n    reasoningEffort: high"
    if ($targetWeb -eq $webPatch) { throw 'fixture: failed to set the target host default model' }
  }

  $webPkg = [ordered]@{
    name = 'dsh-profile-web'; private = $true
    dependencies = [ordered]@{
      '@deepseek-ai/dsh-base' = '0.2.1-rc.5'
      '@local/plugin-new'     = 'link:C:/src/plugin-new'
      'dsh-config-pack'       = $packSpec
    }
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@local/plugin-new', 'dsh-config-pack'); patchReload = 'live' } }
  }
  Put $web 'package.json' ($webPkg | ConvertTo-Json -Depth 10)
  Put $web 'cordis.patch.yml' $webPatch
  Put $web 'pnpm-workspace.yaml' "nodeLinker: hoisted`n"
  Put $web 'pnpm-lock.yaml' "lockfileVersion: '9.0'`n"
  Put $web 'compatibility.json' '{}'
  Put $web 'vendor/keep.txt' 'vendor'

  $saDeps = [ordered]@{
    '@deepseek-ai/dsh-base'       = '0.2.1-rc.5'
    'dsh-superagent'              = 'link:C:/src/dsh-superagent'
    'dsh-plugin-eye-care-bg'      = 'link:C:/src/eye-care'
    'dsh-config-pack'             = $packSpec
  }
  if ($LocalFork) { $saDeps['dsh-superagent-local'] = 'link:C:/src/local-fork' }
  $saPkg = [ordered]@{
    name = 'dsh-profile-superagent'; private = $true
    dependencies = $saDeps
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', 'dsh-superagent', 'dsh-plugin-eye-care-bg', 'dsh-config-pack'); patchReload = 'live' } }
  }
  Put $sa 'package.json' ($saPkg | ConvertTo-Json -Depth 10)
  if ($DivergentNoMarker) {
    Put $sa 'cordis.patch.yml' ($webPatch.TrimEnd() + "`n- id: own-line`n  config:`n    port: 3082`n")
  } else {
    Put $sa 'cordis.patch.yml' ($targetWeb.TrimEnd() + "`n`n" + $saOwn)
  }
  Put $sa 'pnpm-workspace.yaml' "nodeLinker: hoisted`n"
  Put $sa 'compatibility.json' '{}'
  return $fx
}

function Invoke-Sync([string]$DshHome, [string[]]$Extra = @()) {
  $argv = @('-NoProfile', '-File', $syncScript, '-DshHome', $DshHome, '-SkipInstall', '-SkipVerify', '-SkipHostGuard') + $Extra
  $out = & pwsh @argv 2>&1 | Out-String
  return [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}
function Invoke-OneClick([string]$DshHome, [string[]]$Extra = @()) {
  $argv = @('-NoProfile', '-File', $oneClick, '-DshHome', $DshHome, '-SkipHostGuard', '-NoVerify') + $Extra
  $out = & pwsh @argv 2>&1 | Out-String
  return [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}

try {
  # ---- A. 镜像语义 ----------------------------------------------------------
  $fx = New-Fixture 'mirror'
  $r = Invoke-Sync $fx
  Check ($r.code -eq 0) 'mirror: exit 0'
  $pkg = Read-Json (Join-Path $fx 'profiles/superagent/package.json')
  $deps = $pkg.dependencies
  Check ($null -ne $deps.'@local/plugin-new') 'mirror: web 新插件进入 superagent'
  Check ($deps.'@local/plugin-new' -eq 'link:C:/src/plugin-new') 'mirror: 依赖 spec 原样继承'
  Check ($null -ne $deps.'dsh-superagent' -and $null -ne $deps.'dsh-plugin-eye-care-bg') 'mirror: superagent 独有依赖保留'
  Check ($deps.'dsh-config-pack' -eq 'github:Robert-Wang-08/dsh-config-pack#v0.11.7') 'mirror: config-pack spec 与 web 一致'
  $bundles = @($pkg.dsh.profile.bundles)
  Check (($bundles -join ',') -eq '@deepseek-ai/dsh-base,@local/plugin-new,dsh-superagent,dsh-plugin-eye-care-bg,dsh-config-pack') 'mirror: bundle = web 顺序 + 目标独有，config-pack 最后'
  Check ($pkg.name -eq 'dsh-profile-superagent') 'mirror: profile 名称保留'
  Check ($pkg.dsh.profile.patchReload -eq 'live') 'mirror: dsh.profile 其它键保留'
  $patch = Get-Content (Join-Path $fx 'profiles/superagent/cordis.patch.yml') -Raw
  Check ($patch.Contains('- id: webserver') -and $patch.Contains('port: 3082')) 'mirror: patch 继承 web 行并保留自有 port 3082'
  Check ($patch.Contains('model: deepseek-flash')) 'mirror: patch 包含 web 全量'
  Check ($patch.TrimEnd().EndsWith('stateDir: ''C:/state/superagent''')) 'mirror: 自有覆盖段位于末尾'
  Check ((Count-Backups $fx) -eq 1) 'mirror: 写入前生成备份'
  $manifest = Get-Content (Join-Path (Get-ChildItem (Join-Path $fx 'backups') -Directory | Select-Object -First 1).FullName 'MANIFEST.json') -Raw | ConvertFrom-Json
  Check (($manifest.backedUp -contains 'package.json') -and ($manifest.backedUp -contains 'cordis.patch.yml')) 'mirror: 备份清单覆盖关键文件'

  # ---- B. 幂等 --------------------------------------------------------------
  $pkgHash = Hash-Of (Join-Path $fx 'profiles/superagent/package.json')
  $patchHash = Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')
  $r = Invoke-Sync $fx
  Check ($r.code -eq 0) 'idempotent: 第二次运行 exit 0'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/package.json')) -eq $pkgHash) 'idempotent: package.json 不变'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')) -eq $patchHash) 'idempotent: cordis.patch.yml 不变'

  # ---- C. DryRun ------------------------------------------------------------
  $fx = New-Fixture 'dryrun'
  $beforePkg = Hash-Of (Join-Path $fx 'profiles/superagent/package.json')
  $beforePatch = Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')
  $r = Invoke-Sync $fx @('-DryRun')
  Check ($r.code -eq 0) 'dryrun: exit 0'
  Check ($r.out -match 'plan') 'dryrun: 输出计划'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/package.json')) -eq $beforePkg) 'dryrun: 不写 package.json'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')) -eq $beforePatch) 'dryrun: 不写 patch'
  Check ((Count-Backups $fx) -eq 0) 'dryrun: 不生成备份'

  # ---- D. 缺标记 + 分叉 patch：拒绝静默覆盖 --------------------------------
  $fx = New-Fixture 'nomarker' -DivergentNoMarker
  $beforePatch = Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')
  $r = Invoke-Sync $fx
  Check ($r.code -ne 0) 'nomarker: 非零退出'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')) -eq $beforePatch) 'nomarker: 目标 patch 未被改写'
  $r = Invoke-Sync $fx @('-KeepTargetPatch')
  Check ($r.code -eq 0) 'keep-target-patch: exit 0'
  Check ((Hash-Of (Join-Path $fx 'profiles/superagent/cordis.patch.yml')) -eq $beforePatch) 'keep-target-patch: patch 保持原样'
  $pkg = Read-Json (Join-Path $fx 'profiles/superagent/package.json')
  Check ($null -ne $pkg.dependencies.'@local/plugin-new') 'keep-target-patch: 依赖仍已同步'

  # ---- E. 防呆：dsh-superagent-local ----------------------------------------
  $fx = New-Fixture 'localfork' -LocalFork
  $r = Invoke-Sync $fx
  Check ($r.code -ne 0 -and $r.out -match 'dsh-superagent-local') 'guard: 拒绝 dsh-superagent-local'

  # ---- E2. 宿主默认模型：保留目标 profile 的 agent-default-model ------------
  $fx = New-Fixture 'hostdefault' -OwnHostModel
  $r = Invoke-Sync $fx
  Check ($r.code -eq 0) 'hostdefault: exit 0'
  $patchPath = Join-Path $fx 'profiles/superagent/cordis.patch.yml'
  $patch = Get-Content $patchPath -Raw
  Check (([regex]::Matches($patch, '(?m)^- id:\s*agent-default-model\s*$')).Count -eq 1) 'hostdefault: agent-default-model 行不重复'
  Check ($patch -match 'provider: opencode-go' -and $patch -match 'model: deepseek-v4.1-flash') 'hostdefault: 保留 superagent 的 opencode-go 默认模型'
  Check ($patch -notmatch 'model: deepseek-flash') 'hostdefault: web 的 ais-2dsglm 默认值未覆盖目标'
  $h1 = Hash-Of $patchPath
  $r = Invoke-Sync $fx
  Check ($r.code -eq 0 -and (Hash-Of $patchPath) -eq $h1) 'hostdefault: 第二次同步幂等'

  # ---- F. 一键入口：顺序、失败中断、link 开发态、DryRun、缺 profile ---------
  $stubDir = Join-Path $WorkRoot 'stubs'
  New-Item -ItemType Directory -Force $stubDir | Out-Null
  Put $stubDir 'update.ps1' @'
param([string]$ProfileName, [string]$Source, [switch]$SkipOptional, [switch]$Force, [switch]$NoVerify)
$calls = Join-Path $env:STUB_CALLS 'calls.txt'
Add-Content -LiteralPath $calls -Value ('update:' + $ProfileName)
exit ([int]$env:STUB_UPDATE_EXIT)
'@
  Put $stubDir 'sync.ps1' @'
param([string]$DshHome, [string]$SourceProfile, [string]$TargetProfile, [switch]$DryRun, [switch]$SkipVerify, [switch]$SkipHostGuard)
$calls = Join-Path $env:STUB_CALLS 'calls.txt'
Add-Content -LiteralPath $calls -Value ('sync:' + $TargetProfile)
exit ([int]$env:STUB_SYNC_EXIT)
'@
  $oldCalls = $env:STUB_CALLS; $oldUe = $env:STUB_UPDATE_EXIT; $oldSe = $env:STUB_SYNC_EXIT
  try {
    $env:STUB_CALLS = $stubDir; $env:STUB_UPDATE_EXIT = '0'; $env:STUB_SYNC_EXIT = '0'
    $fx = New-Fixture 'oneclick'
    $r = Invoke-OneClick $fx @('-UpdateScript', (Join-Path $stubDir 'update.ps1'), '-SyncScript', (Join-Path $stubDir 'sync.ps1'))
    Check ($r.code -eq 0) 'oneclick: exit 0'
    $calls = @(Get-Content (Join-Path $stubDir 'calls.txt'))
    Check (($calls -join ',') -eq 'update:web,sync:superagent') 'oneclick: 先更新 web 再镜像 superagent'

    Remove-Item (Join-Path $stubDir 'calls.txt') -Force
    $env:STUB_UPDATE_EXIT = '2'
    $r = Invoke-OneClick $fx @('-UpdateScript', (Join-Path $stubDir 'update.ps1'), '-SyncScript', (Join-Path $stubDir 'sync.ps1'))
    Check ($r.code -ne 0) 'oneclick: web 更新失败时非零退出'
    $calls = if (Test-Path (Join-Path $stubDir 'calls.txt')) { @(Get-Content (Join-Path $stubDir 'calls.txt')) } else { @() }
    Check (($calls -join ',') -eq 'update:web') 'oneclick: 更新失败后不执行镜像'

    Remove-Item (Join-Path $stubDir 'calls.txt') -Force -ErrorAction SilentlyContinue
    $env:STUB_UPDATE_EXIT = '0'
    $fx = New-Fixture 'oneclick-link' -WebLinkPack
    $r = Invoke-OneClick $fx @('-UpdateScript', (Join-Path $stubDir 'update.ps1'), '-SyncScript', (Join-Path $stubDir 'sync.ps1'))
    Check ($r.code -eq 0) 'oneclick link: exit 0'
    $calls = @(Get-Content (Join-Path $stubDir 'calls.txt'))
    Check (($calls -join ',') -eq 'sync:superagent') 'oneclick link: 跳过发布版更新，仍镜像'

    Remove-Item (Join-Path $stubDir 'calls.txt') -Force
    $r = Invoke-OneClick $fx @('-UpdateScript', (Join-Path $stubDir 'update.ps1'), '-SyncScript', (Join-Path $stubDir 'sync.ps1'), '-DryRun')
    Check ($r.code -eq 0) 'oneclick dryrun: exit 0'
    $calls = @(Get-Content (Join-Path $stubDir 'calls.txt') -ErrorAction SilentlyContinue)
    Check (($calls -join ',') -eq 'sync:superagent') 'oneclick dryrun: 不更新 web，只让镜像脚本出计划'
    Check ($r.out -match 'plan') 'oneclick dryrun: 输出计划'

    $fx = New-Fixture 'singleprofile'
    Remove-Item (Join-Path $fx 'profiles/superagent') -Recurse -Force
    $r = Invoke-OneClick $fx @('-UpdateScript', (Join-Path $stubDir 'update.ps1'), '-SyncScript', (Join-Path $stubDir 'sync.ps1'))
    Check ($r.code -ne 0 -and $r.out -match 'superagent profile 不存在') 'oneclick: 缺 superagent profile 时明确失败'
  } finally {
    $env:STUB_CALLS = $oldCalls; $env:STUB_UPDATE_EXIT = $oldUe; $env:STUB_SYNC_EXIT = $oldSe
  }

  Write-Host ('PASS: ' + $script:passed + ' checks（镜像语义/保留/宿主默认模型/幂等/DryRun/标记保护/防呆/一键入口）')
} finally {
  if (Test-Path $WorkRoot) { Remove-Item $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

