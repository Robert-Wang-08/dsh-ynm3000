<#
.SYNOPSIS
把 web profile 的插件与配置同步到 superagent profile，并保留 dsh-superagent 自有覆盖。

.DESCRIPTION
dsh-superagent 官方文档要求 superagent 是 Web profile 的副本；本机又希望它继承 web
profile 的全部插件与个性化配置（模型 provider、MCP、PTC、taskboard、UI 插件等）。
本脚本是这条同步的唯一入口，可重复执行：

1. 备份 superagent profile 的配置文件到 %USERPROFILE%\.dsh\backups\superagent-pre-web-integration-<UTC>
2. 从 web profile 复制 vendor/、patches/、compatibility.json、pnpm-lock.yaml
3. package.json = web 的 dependencies + bundles（末尾追加 dsh-superagent）
4. pnpm-workspace.yaml = web 的安装规则 + blockExoticSubdeps: false
5. cordis.patch.yml = web 的完整 patch + 本 profile 自有覆盖（端口/stateDir/浏览器目录/微信关闭）
6. pnpm install
7. dsh --profile superagent --dump-config 校验组合结果

.PARAMETER SkipInstall
只写配置文件，不执行 pnpm install 与组合校验。

.EXAMPLE
pwsh -File dsh-superagent-profile-sync.ps1
#>
[CmdletBinding()]
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
$home_ = $env:USERPROFILE
$src = Join-Path $home_ '.dsh\profiles\web'
$dst = Join-Path $home_ '.dsh\profiles\superagent'
$ts = Get-Date -Format 'yyyyMMddTHHmmssZ'

if (-not (Test-Path $src)) { throw ('web profile 不存在: ' + $src) }
if (-not (Test-Path $dst)) { throw 'superagent profile 不存在: 先按 docs/006-deployment.md 创建 profile' }

# 1) 备份
$bak = Join-Path $home_ ('.dsh\backups\superagent-pre-web-integration-' + $ts)
New-Item -ItemType Directory -Path (Join-Path $bak 'profiles\superagent') -Force | Out-Null
$files = @('package.json','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml','compatibility.json')
foreach ($f in $files) { $p = Join-Path $dst $f; if (Test-Path $p) { Copy-Item $p (Join-Path $bak ('profiles\superagent\' + $f)) -Force } }
$manifest = [ordered]@{ created = (Get-Date).ToString('o'); reason = 'superagent profile 集成 web 插件与配置前备份'; backedUp = @($files | Where-Object { Test-Path (Join-Path $bak ('profiles\superagent\' + $_)) }); webHashes = [ordered]@{} }
foreach ($f in @('package.json','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml')) { $manifest.webHashes[$f] = (Get-FileHash (Join-Path $src $f) -Algorithm SHA256).Hash }
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $bak 'MANIFEST.json') -Encoding utf8
Write-Host ('BACKUP: ' + $bak)

# 2) 共享安装输入
foreach ($d in @('vendor','patches')) { $s = Join-Path $src $d; if (Test-Path $s) { Copy-Item $s (Join-Path $dst $d) -Recurse -Force; Write-Host ('COPIED dir: ' + $d) } }
if (Test-Path (Join-Path $src 'compatibility.json')) { Copy-Item (Join-Path $src 'compatibility.json') (Join-Path $dst 'compatibility.json') -Force; Write-Host 'COPIED: compatibility.json' }

# 3) package.json：web 依赖与 bundle 顺序 + dsh-superagent 收尾
$webPkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
$deps = [ordered]@{}
foreach ($p in $webPkg.dependencies.PSObject.Properties) { $deps[$p.Name] = $p.Value }
$deps['dsh-superagent'] = 'link:D:/src/dsh-superagent'
$deps['dsh-plugin-superagent-appearance'] = 'link:D:/src/dsh/dsh-plugin-superagent-appearance'
$bundles = New-Object System.Collections.ArrayList
foreach ($b in $webPkg.dsh.profile.bundles) { [void]$bundles.Add($b) }
[void]$bundles.Add('dsh-superagent')
$out = [ordered]@{ name = 'dsh-profile-superagent'; private = $true; dependencies = $deps; dsh = [ordered]@{ profile = [ordered]@{ bundles = @($bundles); patchReload = 'live' } } }
[System.IO.File]::WriteAllText((Join-Path $dst 'package.json'), ($out | ConvertTo-Json -Depth 8) + [char]10, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('WROTE package.json deps=' + $deps.Count + ' bundles=' + $bundles.Count)

# 4) pnpm 安装规则
$ws = Get-Content (Join-Path $src 'pnpm-workspace.yaml') -Raw
if ($ws -notmatch 'blockExoticSubdeps') { $ws = $ws.TrimEnd() + [char]10 + 'blockExoticSubdeps: false' + [char]10 }
[System.IO.File]::WriteAllText((Join-Path $dst 'pnpm-workspace.yaml'), $ws, (New-Object System.Text.UTF8Encoding($false)))
Copy-Item (Join-Path $src 'pnpm-lock.yaml') (Join-Path $dst 'pnpm-lock.yaml') -Force
Write-Host 'WROTE pnpm-workspace.yaml / COPIED pnpm-lock.yaml'

# 5) cordis.patch.yml = web 全量 + 自有覆盖
$webPatch = Get-Content (Join-Path $src 'cordis.patch.yml') -Raw
$own = @'

# ===== dsh-superagent 本 profile 自有覆盖（由 dsh-superagent-profile-sync.ps1 维护）=====
# 按 id 覆盖时 config 整体替换、不做深合并：改 bundle 默认值时要同步这里。
- insert:
    - id: superagent-appearance
      name: dsh-plugin-superagent-appearance
      config:
        preset: soft
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: C:/Users/wwm_1/.dsh/state/superagent
# 内嵌浏览器：与 3080 的 web 实例分开 Chrome profile 目录，避免 user-data-dir 争用。
- id: embedded-browser
  config:
    browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    lazyTools: false
    profileDir: C:/Users/wwm_1/.dsh/embedded-browser/profile-superagent
# WeChat 人工确认回环：本 profile 默认关闭，避免与 3080 实例共用同一网关队列时重复应答。
# 要让 superagent 也走微信审批时，把 disabled 改为 false。
- id: wechat-hitl
  disabled: true
# 飞书 Source：superagent 原生支持，启用后由面板配置 lark-cli 与接收的群/私聊。
- id: dsh-superagent-feishu
  disabled: false
'@
[System.IO.File]::WriteAllText((Join-Path $dst 'cordis.patch.yml'), $webPatch.TrimEnd() + $own, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('WROTE cordis.patch.yml lines=' + (Get-Content (Join-Path $dst 'cordis.patch.yml')).Count)

if ($SkipInstall) { Write-Host 'SKIP install (per -SkipInstall)'; return }

# 6) 安装
Push-Location $dst
try {
  $installLog = Join-Path $dst '.install-web-integration.log'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $pnpmOut = & pnpm install --reporter=append-only 2>&1
  $code = $LASTEXITCODE
  $sw.Stop()
  $pnpmOut | Set-Content $installLog -Encoding utf8
  Write-Host ('PNPM exit=' + $code + ' elapsed=' + [int]$sw.Elapsed.TotalSeconds + 's log=' + $installLog)
  if ($code -ne 0) { $pnpmOut | Select-Object -Last 20; throw ('pnpm install 失败 exit ' + $code) }
} finally { Pop-Location }

# 7) 组合校验
$node = (Get-Command node).Source
$bin = Join-Path (Split-Path $node) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $bin)) { $bin = Join-Path (& npm root -g) '@deepseek-ai/dsh/lib/bin.js' }
$dump = Join-Path $dst 'dump-config.yml'
$errFile = Join-Path $dst 'dump-config.err'
& $node $bin --profile superagent --dump-config > $dump 2> $errFile
if ($LASTEXITCODE -ne 0) { Get-Content $errFile -Raw; throw 'dump-config 失败' }
$ids = (Select-String -Path $dump -Pattern '^\s*-?\s*id:').Count
$portHits = (Select-String -Path $dump -Pattern '^\s*port: 3082').Count
$stateHits = (Select-String -Path $dump -Pattern 'stateDir: C:/Users/wwm_1/.dsh/state/superagent').Count
Write-Host ('VERIFY dump-config ok: ' + $ids + ' entries, port3082=' + $portHits + ', stateDir=' + $stateHits)
Write-Host 'NEXT: pwsh -File dsh-superagent-service.ps1 start'
# 8) 防呆：拒绝被 local fork 顶替、拒绝未限定 scope 的 dsh-bridge
$pkgText = Get-Content (Join-Path $dst 'package.json') -Raw
$depNames = @((($pkgText | ConvertFrom-Json).dependencies).PSObject.Properties.Name)
if ($depNames -contains 'dsh-superagent-local') { throw 'package.json 里出现 dsh-superagent-local：它与上游 dsh-superagent 包名/插件 id 相同，会顶替上游，必须移除' }
if ($depNames -contains 'dsh-bridge') { throw 'package.json 里出现未限定 scope 的 dsh-bridge：请写全 @wenbin_wb/dsh-bridge（这是 DSH 远程控制插件），不要与 OpenClaw 网关 dsh-bridge 混淆' }
$bundleNames = @((($pkgText | ConvertFrom-Json).dsh.profile.bundles))
if ($bundleNames -contains 'dsh-superagent-local') { throw 'bundles 里出现 dsh-superagent-local：插件 id 与上游 dsh-superagent 冲突，会起不来' }
$_sa = Join-Path $dst 'node_modules\dsh-superagent'
if (Test-Path $_sa) {
  $_pkg = Get-Content (Join-Path $_sa 'package.json') -Raw | ConvertFrom-Json
  if ($_pkg.author -match 'local fork') { throw ('node_modules/dsh-superagent 被 local fork 顶替（author=' + $_pkg.author + '），请删掉后重跑本脚本') }
  $_target = (Get-Item $_sa).Target
  if ($_target -and ($_target -notmatch 'dsh-superagent$')) { throw ('node_modules/dsh-superagent 指向了意外的目录: ' + $_target) }
  Write-Host ('GUARD ok: dsh-superagent ' + $_pkg.version + ' <- ' + $_target)
}
Write-Host 'GUARD ok: no dsh-superagent-local, no unscoped dsh-bridge'
