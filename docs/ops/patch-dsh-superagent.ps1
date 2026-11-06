<#
  patch-dsh-superagent.ps1 —— 升级 dsh-superagent 之后，把本机必需的补丁重新打回去。

  为什么需要：飞书通道能在本机跑通，靠的是两处对 node_modules 的改写
  （MSYS env 路径改写、orchestrator 工具白名单里的 bash）。升级包管理器会整目录替换，
  改写随之丢失，表现为：
    - 面板保存报「机器人的 lark-cli 不可用」+ 404 page not found；
    - 服务 err 日志报 tools.restrict() names unknown global tool "bash"，
      orchestrator 起不来，feishu/github 两个 source 永远 pending。

  补丁本体在仓库里（单一事实源）：docs\ops\dsh-superagent-patches\*.mjs
  node_modules 只是被改写的副本；任何一次改写前都会留 .prepatch-backup 以便回滚。

  用法：
    pwsh -File docs\ops\patch-dsh-superagent.ps1                    # 校验（默认）
    pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply        # 打上缺的补丁（幂等）
    pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode restore      # 回滚到备份
    pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply -AllProfiles
    pwsh -File docs\ops\patch-dsh-superagent.ps1 -PkgPath <目录>    # 指定别的副本

  打完补丁要重启对应服务才会生效（superagent: dsh-superagent-service.ps1 stop/start）。
#>
[CmdletBinding()]
param(
  [ValidateSet('verify', 'apply', 'restore')][string]$Mode = 'verify',
  [string]$Profile = 'superagent',
  [switch]$AllProfiles,
  [string]$PkgPath = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$runner = Join-Path $here 'dsh-superagent-patches\runner.mjs'
if (-not (Test-Path $runner)) { Write-Host "[FAIL] 找不到 runner: $runner"; exit 1 }

function Resolve-Pkg([string]$name) {
  $base = Join-Path $env:USERPROFILE ".dsh\profiles\$name\node_modules\dsh-superagent"
  if (Test-Path $base) { return $base }
  return $null
}

$targets = @()
if ($PkgPath) {
  $targets += [pscustomobject]@{ Name = '(explicit)'; Pkg = $PkgPath }
} elseif ($AllProfiles) {
  $root = Join-Path $env:USERPROFILE '.dsh\profiles'
  foreach ($d in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
    $p = Resolve-Pkg $d.Name
    if ($p) { $targets += [pscustomobject]@{ Name = $d.Name; Pkg = $p } }
  }
} else {
  $p = Resolve-Pkg $Profile
  if (-not $p) { Write-Host "[FAIL] profile $Profile 下没有 dsh-superagent"; exit 1 }
  $targets += [pscustomobject]@{ Name = $Profile; Pkg = $p }
}

$bad = 0
foreach ($t in $targets) {
  Write-Host ("=== profile " + $t.Name + " ===")
  Write-Host ("    " + $t.Pkg)
  $out = & node $runner --pkg $t.Pkg --mode $Mode 2>&1
  $code = $LASTEXITCODE
  $out | ForEach-Object { if ($_ -match '\S') { Write-Host ('  ' + $_) } }
  if ($code -ne 0) { $bad += 1 }
  if ($Mode -eq 'apply' -and $code -eq 0) {
    Write-Host "  [提示] 重启对应服务后生效（superagent: dsh-superagent-service.ps1 stop 然后 start）"
  }
}

if ($Mode -eq 'verify' -and $bad -gt 0) {
  Write-Host ''
  Write-Host "有补丁缺失（升级后常见）。执行：pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply"
}
exit $(if ($bad -gt 0) { 1 } else { 0 })
