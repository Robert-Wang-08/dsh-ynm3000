<#
.SYNOPSIS
  把 web profile 的插件与配置层镜像到 superagent profile，并保留 superagent 自有覆盖。

.DESCRIPTION
  dsh-superagent 官方文档要求 superagent 是 Web profile 的副本；本机又希望它继承 web
  profile 的全部插件与个性化配置（模型 provider、MCP、PTC、UI 插件等）。本脚本是这条
  同步的唯一入口，可重复执行（幂等）：

  1. 备份 superagent profile 的配置文件到 <DSH_HOME>\backups\superagent-profile-sync-<UTC>
  2. 从 web profile 复制 vendor/、patches/、compatibility.json、pnpm-lock.yaml
  3. package.json = web 的 dependencies + superagent 独有依赖（不写死插件名）+
     web 的 bundle 顺序 + superagent 独有 bundle；dsh-config-pack 始终排最后
  4. pnpm-workspace.yaml = web 的安装规则 + blockExoticSubdeps: false
  5. cordis.patch.yml = web 的完整 patch + 标记行之后的自有覆盖段
  6. pnpm install（仅当依赖/锁文件/工作区规则变化）
  7. dsh --profile superagent --dump-config 校验组合结果

  所有路径都从 DSH_HOME / profile 目录解析，不含设备绝对路径，可跨机使用。

.PARAMETER DshHome
  DSH 主目录；默认取 $env:DSH_HOME，其次 $HOME\.dsh。测试时指向合成目录。

.PARAMETER SourceProfile
  提供插件与配置的源 profile，默认 web。

.PARAMETER TargetProfile
  接收同步的 profile，默认 superagent。

.PARAMETER DryRun
  只打印同步计划，不备份、不写文件、不安装、不校验。

.PARAMETER SkipInstall
  只写配置文件，不执行 pnpm install（验收也会跳过）。

.PARAMETER SkipVerify
  跳过 dsh --dump-config 组合校验。

.PARAMETER SkipHostGuard
  跳过「目标 profile 宿主正在运行」检查。仅在明确知道可以热改 profile 时使用。

.PARAMETER KeepTargetPatch
  cordis.patch.yml 找不到自有覆盖标记、且与源 patch 不同时，保留目标 patch 不动
  （默认直接失败，避免静默丢掉本机覆盖）。

.EXAMPLE
  pwsh -File dsh-superagent-profile-sync.ps1
  pwsh -File dsh-superagent-profile-sync.ps1 -DryRun
  pwsh -File dsh-superagent-profile-sync.ps1 -DshHome C:\tmp\dsh-home -SkipInstall -SkipVerify -SkipHostGuard
#>
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$SourceProfile = 'web',
  [string]$TargetProfile = 'superagent',
  [switch]$DryRun,
  [switch]$SkipInstall,
  [switch]$SkipVerify,
  [switch]$SkipHostGuard,
  [switch]$KeepTargetPatch
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Fail([string]$m, [int]$code = 1) { Write-Host ('FAIL  ' + $m) -ForegroundColor Red; exit $code }
function Ok([string]$m)   { Write-Host ('ok    ' + $m) -ForegroundColor Green }
function Info([string]$m) { Write-Host ('      ' + $m) }
function Warn([string]$m) { Write-Host ('warn  ' + $m) -ForegroundColor Yellow }
function Step([string]$m) { Write-Host ('== ' + $m) -ForegroundColor Cyan }
function Plan([string]$m) { Write-Host ('plan  ' + $m) -ForegroundColor DarkCyan }

$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath('UserProfile') }
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $UserHome '.dsh' }
}
if (-not (Test-Path $DshHome)) { Fail ('DSH_HOME 不存在: ' + $DshHome) }
if ($SourceProfile -eq $TargetProfile) { Fail '源 profile 与目标 profile 不能相同' }

$src = Join-Path (Join-Path $DshHome 'profiles') $SourceProfile
$dst = Join-Path (Join-Path $DshHome 'profiles') $TargetProfile
if (-not (Test-Path $src)) { Fail ('源 profile 不存在: ' + $src) }
if (-not (Test-Path $dst)) { Fail ('目标 profile 不存在: ' + $dst + '（先按 docs/ops/superagent-profile.md 创建）') }

$Utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return [System.IO.File]::ReadAllText($Path)
}
function Normalize-Text([string]$Text) { if ($null -eq $Text) { return '' }; return ($Text -replace "`r`n", "`n") }
function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8)
}
function Write-TextIfChanged([string]$Path, [string]$Text) {
  $old = Read-Text $Path
  if ($null -ne $old -and ((Normalize-Text $old) -ceq (Normalize-Text $Text))) { return $false }
  if (-not $DryRun) { Write-Text $Path $Text }
  return $true
}
function Test-ProfileHostRunning([string]$Profile) {
  try {
    $pattern = '--profile\s+["'']?' + [regex]::Escape($Profile) + '(?=[\s"'']|$)'
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    foreach ($p in $procs) {
      if ($p.CommandLine -and $p.CommandLine -match $pattern) { return $true }
    }
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
function Invoke-DumpConfigVerify([string]$Profile) {
  $resolved = Resolve-DshBin
  if (-not $resolved) { return [pscustomobject]@{ ok = $false; detail = '找不到 node + @deepseek-ai/dsh，无法执行 --dump-config' } }
  $logDir = Join-Path $dst '.sync-logs'
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

# ---- 0. 宿主守卫 -------------------------------------------------------------
if (-not $SkipHostGuard -and -not $DryRun) {
  if (Test-ProfileHostRunning $TargetProfile) {
    Fail ('目标 profile ''' + $TargetProfile + ''' 的宿主正在运行：先停止该服务（例如 pwsh -File dsh-superagent-service.ps1 stop），再重跑本脚本。' +
      ' 确需热改时加 -SkipHostGuard。') 3
  }
}

# ---- 1. 读取源/目标清单 ------------------------------------------------------
$srcPkgPath = Join-Path $src 'package.json'
$dstPkgPath = Join-Path $dst 'package.json'
if (-not (Test-Path $srcPkgPath)) { Fail ('源 profile 缺少 package.json: ' + $srcPkgPath) }
if (-not (Test-Path $dstPkgPath)) { Fail ('目标 profile 缺少 package.json: ' + $dstPkgPath) }
$srcPkg = Get-Content $srcPkgPath -Raw | ConvertFrom-Json
$dstPkg = Get-Content $dstPkgPath -Raw | ConvertFrom-Json
if (-not $srcPkg.dsh -or -not $srcPkg.dsh.profile -or -not $srcPkg.dsh.profile.bundles) { Fail ('源 profile package.json 没有 dsh.profile.bundles: ' + $srcPkgPath) }

$srcDeps = [ordered]@{}
if ($srcPkg.dependencies) { foreach ($p in $srcPkg.dependencies.PSObject.Properties) { $srcDeps[$p.Name] = [string]$p.Value } }
$dstDeps = [ordered]@{}
if ($dstPkg.dependencies) { foreach ($p in $dstPkg.dependencies.PSObject.Properties) { $dstDeps[$p.Name] = [string]$p.Value } }

# 目标独有依赖必须保留（dsh-superagent / eye-care / superagent 外观等由目标自己维护）
$deps = [ordered]@{}
foreach ($k in $srcDeps.Keys) { $deps[$k] = $srcDeps[$k] }
$keptDeps = New-Object System.Collections.ArrayList
foreach ($k in $dstDeps.Keys) {
  if (-not $deps.Contains($k)) { $deps[$k] = $dstDeps[$k]; [void]$keptDeps.Add($k) }
}

# 防呆：同名顶替上游 / 未限定 scope 的 dsh-bridge
if ($deps.Contains('dsh-superagent-local')) { Fail 'package.json 里出现 dsh-superagent-local：它与上游 dsh-superagent 包名/插件 id 相同，会顶替上游，必须移除' }
if ($deps.Contains('dsh-bridge')) { Fail 'package.json 里出现未限定 scope 的 dsh-bridge：请写全 @wenbin_wb/dsh-bridge（这是 DSH 远程控制插件），不要与 OpenClaw 网关 dsh-bridge 混淆' }

$srcBundles = @($srcPkg.dsh.profile.bundles | ForEach-Object { [string]$_ })
$dstBundles = @()
if ($dstPkg.dsh -and $dstPkg.dsh.profile -and $dstPkg.dsh.profile.bundles) { $dstBundles = @($dstPkg.dsh.profile.bundles | ForEach-Object { [string]$_ }) }
$bundles = New-Object System.Collections.Generic.List[string]
foreach ($b in $srcBundles) { if (-not $bundles.Contains($b)) { [void]$bundles.Add($b) } }
$keptBundles = New-Object System.Collections.ArrayList
foreach ($b in $dstBundles) {
  if (-not $bundles.Contains($b)) { [void]$bundles.Add($b); [void]$keptBundles.Add($b) }
}
# 补丁层/配置包必须排最后
if ($bundles.Contains('dsh-config-pack')) {
  [void]$bundles.Remove('dsh-config-pack')
  [void]$bundles.Add('dsh-config-pack')
}
if ($bundles.Contains('dsh-superagent-local')) { Fail 'bundles 里出现 dsh-superagent-local：插件 id 与上游 dsh-superagent 冲突，会起不来' }

# 目标 package.json 顶层字段与 dsh.profile 其它键原样保留
$newProfile = [ordered]@{}
if ($dstPkg.dsh -and $dstPkg.dsh.profile) {
  foreach ($p in $dstPkg.dsh.profile.PSObject.Properties) { if ($p.Name -ne 'bundles') { $newProfile[$p.Name] = $p.Value } }
}
$newProfile['bundles'] = @($bundles)
$newDsh = [ordered]@{}
if ($dstPkg.dsh) {
  foreach ($p in $dstPkg.dsh.PSObject.Properties) { if ($p.Name -ne 'profile') { $newDsh[$p.Name] = $p.Value } }
}
$newDsh['profile'] = $newProfile
$newPkg = [ordered]@{}
foreach ($p in $dstPkg.PSObject.Properties) {
  switch ($p.Name) {
    'dependencies' { $newPkg['dependencies'] = $deps }
    'dsh'          { $newPkg['dsh'] = $newDsh }
    default        { $newPkg[$p.Name] = $p.Value }
  }
}
if (-not $newPkg.Contains('dependencies')) { $newPkg['dependencies'] = $deps }
if (-not $newPkg.Contains('dsh')) { $newPkg['dsh'] = $newDsh }
$pkgJson = ($newPkg | ConvertTo-Json -Depth 20) + "`n"

# ---- 2. cordis.patch.yml：源全量 + 目标自有覆盖段 ----------------------------
$srcPatchPath = Join-Path $src 'cordis.patch.yml'
$dstPatchPath = Join-Path $dst 'cordis.patch.yml'
$srcPatch = Normalize-Text (Read-Text $srcPatchPath)
$dstPatchExists = Test-Path $dstPatchPath
$dstPatch = Normalize-Text (Read-Text $dstPatchPath)
if ($null -eq $srcPatch) { Fail ('源 profile 缺少 cordis.patch.yml: ' + $srcPatchPath) }
if (-not $dstPatchExists) { $dstPatch = '' }

$markers = @(
  '# ===== dsh-superagent 本 profile 自有覆盖',
  '# ===== superagent profile 自有覆盖',
  '# ===== superagent 自有覆盖',
  '# ── dsh-superagent 本机配置'
)
$markerIndex = -1
$dstLines = $dstPatch -split "`n"
for ($i = 0; $i -lt $dstLines.Count; $i++) {
  foreach ($m in $markers) { if ($dstLines[$i].Contains($m)) { $markerIndex = $i; break } }
  if ($markerIndex -ge 0) { break }
}

$patchMode = ''
$newPatch = $null
if ($markerIndex -ge 0) {
  $ownSection = ($dstLines[$markerIndex..($dstLines.Count - 1)] -join "`n").TrimEnd()
  $newPatch = $srcPatch.TrimEnd() + "`n`n" + $ownSection + "`n"
  $patchMode = '源全量 + 自有覆盖段'
} elseif (-not $dstPatchExists) {
  $newPatch = $srcPatch.TrimEnd() + "`n"
  $patchMode = '目标不存在，直接采用源 patch'
} elseif ((Normalize-Text $dstPatch).TrimEnd() -ceq $srcPatch.TrimEnd()) {
  $newPatch = $srcPatch.TrimEnd() + "`n"
  $patchMode = '与源相同'
} elseif ($KeepTargetPatch) {
  $patchMode = '保留目标 patch（-KeepTargetPatch）'
} else {
  Fail ('目标 cordis.patch.yml 与源不同，且找不到自有覆盖标记行（' + ($markers -join ' / ') + '）。' +
    ' 请先给自有覆盖段加标记，或用 -KeepTargetPatch 保留目标 patch 不动。')
}

# ---- 3. 计划输出 -------------------------------------------------------------
Step ('同步 ' + $SourceProfile + ' -> ' + $TargetProfile)
Info ('DSH_HOME: ' + $DshHome)
$addedDeps = @($deps.Keys | Where-Object { -not $dstDeps.Contains($_) })
Info ('依赖: 共 ' + $deps.Count + '；新增/改自源 ' + $addedDeps.Count + '；保留目标独有 ' + $keptDeps.Count)
if ($addedDeps.Count -gt 0) { Info ('  新增: ' + ($addedDeps -join ', ')) }
if ($keptDeps.Count -gt 0) { Info ('  保留目标独有: ' + ($keptDeps -join ', ')) }
Info ('bundles: ' + $bundles.Count + ' 个；保留目标独有 ' + $keptBundles.Count)
if ($keptBundles.Count -gt 0) { Info ('  保留目标独有 bundle: ' + ($keptBundles -join ', ')) }
Info ('cordis.patch.yml: ' + $patchMode)

if ($DryRun) {
  Plan 'DryRun：不备份、不写文件、不安装、不校验。'
  Plan ('将写: ' + $dstPkgPath)
  Plan ('将写: ' + $dstPatchPath)
  Plan ('将复制: vendor/ patches/ compatibility.json pnpm-lock.yaml（存在时）')
  exit 0
}

# ---- 4. 备份 -----------------------------------------------------------------
$ts = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$bak = Join-Path (Join-Path $DshHome 'backups') ('superagent-profile-sync-' + $ts)
$bakProfile = Join-Path $bak ('profiles\' + $TargetProfile)
New-Item -ItemType Directory -Path $bakProfile -Force | Out-Null
$files = @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'compatibility.json')
$backedUp = @()
foreach ($f in $files) {
  $p = Join-Path $dst $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $bakProfile $f) -Force; $backedUp += $f }
}
$manifest = [ordered]@{
  created   = (Get-Date).ToString('o')
  reason    = ('superagent profile 镜像 ' + $SourceProfile + ' 前备份')
  source    = $SourceProfile
  target    = $TargetProfile
  backedUp  = $backedUp
  sourceHashes = [ordered]@{}
}
foreach ($f in $files) {
  $p = Join-Path $src $f
  if (Test-Path $p) { $manifest.sourceHashes[$f] = (Get-FileHash $p -Algorithm SHA256).Hash }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $bak 'MANIFEST.json') -Encoding utf8
Ok ('备份: ' + $bak)

# ---- 5. 写 package.json / 安装输入 / 共享目录 -------------------------------
$changed = @()
if (Write-TextIfChanged $dstPkgPath $pkgJson) { $changed += 'package.json'; Ok 'WROTE package.json' } else { Info 'package.json 无变化' }

$wsPath = Join-Path $src 'pnpm-workspace.yaml'
if (Test-Path $wsPath) {
  $ws = Normalize-Text (Read-Text $wsPath)
  if ($ws -notmatch 'blockExoticSubdeps') { $ws = $ws.TrimEnd() + "`n" + 'blockExoticSubdeps: false' + "`n" }
  if (Write-TextIfChanged (Join-Path $dst 'pnpm-workspace.yaml') $ws) { $changed += 'pnpm-workspace.yaml'; Ok 'WROTE pnpm-workspace.yaml' }
}

foreach ($d in @('vendor', 'patches')) {
  $s = Join-Path $src $d
  if (Test-Path $s) {
    Copy-Item $s (Join-Path $dst $d) -Recurse -Force
    Ok ('COPIED dir: ' + $d)
  }
}
foreach ($f in @('compatibility.json', 'pnpm-lock.yaml')) {
  $s = Join-Path $src $f
  if (Test-Path $s) {
    $before = Read-Text (Join-Path $dst $f)
    Copy-Item $s (Join-Path $dst $f) -Force
    if ((Normalize-Text $before) -ne (Normalize-Text (Read-Text $s))) { $changed += $f }
    Ok ('COPIED: ' + $f)
  }
}

if ($null -ne $newPatch) {
  if (Write-TextIfChanged $dstPatchPath $newPatch) { $changed += 'cordis.patch.yml'; Ok ('WROTE cordis.patch.yml（' + $patchMode + '）') } else { Info 'cordis.patch.yml 无变化' }
}

# ---- 6. 安装 -----------------------------------------------------------------
if ($SkipInstall) {
  Warn '跳过 pnpm install（-SkipInstall）'
} elseif ($changed.Count -eq 0 -and (Test-Path (Join-Path $dst 'node_modules'))) {
  Info '配置与依赖均无变化，跳过 pnpm install'
} else {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail 'pnpm 不在 PATH，无法安装；补装后重试或加 -SkipInstall' }
  Step 'pnpm install'
  Push-Location $dst
  try {
    $installLog = Join-Path $dst '.sync-install.log'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $pnpmOut = & pnpm install --reporter=append-only 2>&1
    $code = $LASTEXITCODE
    $sw.Stop()
    $pnpmOut | Set-Content $installLog -Encoding utf8
    Info ('pnpm exit=' + $code + ' elapsed=' + [int]$sw.Elapsed.TotalSeconds + 's log=' + $installLog)
    if ($code -ne 0) { $pnpmOut | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }; Fail ('pnpm install 失败 exit ' + $code) }
  } finally { Pop-Location }
  Ok 'pnpm install 完成'
}

# ---- 7. 校验 ----------------------------------------------------------------
if ($SkipInstall) {
  Warn '跳过 --dump-config 校验：本次用了 -SkipInstall，依赖可能尚未安装'
} elseif ($SkipVerify) {
  Warn '跳过 --dump-config 校验（-SkipVerify）'
} else {
  Step ('校验 ' + $TargetProfile)
  $result = Invoke-DumpConfigVerify $TargetProfile
  if (-not $result.ok) { Fail ('--dump-config 校验失败: ' + $result.detail) }
  Ok ('--dump-config exit 0（' + $result.detail + '）')
  $pkgCheck = Get-Content $dstPkgPath -Raw | ConvertFrom-Json
  $bundleCheck = @($pkgCheck.dsh.profile.bundles)
  if ($bundleCheck.Count -eq 0 -or $bundleCheck[-1] -ne 'dsh-config-pack') { Fail 'bundle 顺序异常：dsh-config-pack 必须是最后一个' }
  Ok 'bundle 顺序有效（dsh-config-pack 排最后）'
}

Ok ('同步完成: ' + $SourceProfile + ' -> ' + $TargetProfile)
if (-not $SkipVerify) { Info '重启目标 profile 的宿主并新开会话，工具表与 bundle 才会刷新。' }
exit 0
