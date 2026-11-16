#Requires -Version 7.0
<#
.SYNOPSIS
  解析并固定本机 superagent 使用的 lark-cli bot 配置目录（设备相关，不进 Git）。
.DESCRIPTION
  设计原则（AGENTS.md §8）：设备相关的绝对路径不写进共享脚本。
  解析顺序：-Dir 显式参数 > 设备层固定文件 > 候选探测（含 appId 自检）。
  设备层固定文件：%USERPROFILE%\.dsh\device\superagent-lark.json
      { "larkDir": "...", "expectedAppId": "cli_...", "note": "负责人+日期" }
  探测时会读候选目录下的 config.json 的 apps[0].appId，与目录名中的 appId 比对，不匹配则跳过并记录原因。
.PARAMETER Action
  status | pin | unpin        （无 Action 且被 dot-source 时只提供函数）
.EXAMPLE
  pwsh -NoProfile -File dsh-superagent-lark-bot.ps1 -Action status
  pwsh -NoProfile -File dsh-superagent-lark-bot.ps1 -Action pin -Dir "$env:USERPROFILE\.lark-cli-superagent-aa79ee689678dd03"
#>
[CmdletBinding()]
param(
  [ValidateSet('none','status','pin','unpin')][string]$Action = 'none',
  [string]$Dir = ''
)

$script:DeviceFile = Join-Path $env:USERPROFILE '.dsh\device\superagent-lark.json'

function Get-LarkConfigAppId([string]$Path){
  $cfg = Join-Path $Path "config.json"
  if (-not (Test-Path -LiteralPath $cfg)) { return $null }
  try { $j = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json; $apps = @($j.apps); if ($apps.Count -gt 0) { return [string]$apps[0].appId } } catch { return $null }
  return $null
}

function Get-DevicePin {
  if (-not (Test-Path -LiteralPath $script:DeviceFile)) { return $null }
  try { return Get-Content -LiteralPath $script:DeviceFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-LarkCandidates {
  $home_ = $env:USERPROFILE
  return @(
    (Join-Path $home_ '.lark-cli-superagent-aa79ee689678dd03'),
    (Join-Path $home_ '.lark-cli-hitl-aa67e4041a381c02'),
    (Join-Path $home_ '.lark-cli-dsh-superagent')
  )
}

function Resolve-DshLarkDir([string]$Requested){
  $report = [ordered]@{ chosen = $null; appId = $null; source = $null; reason = $null; candidates = @() }
  # 先登记全部候选（即使最终由 -LarkDir / 设备层决定，也让 status 能看到候选现状）。
  foreach ($cand in (Get-LarkCandidates)) {
    $exists = Test-Path -LiteralPath $cand
    $appId = if ($exists) { Get-LarkConfigAppId $cand } else { $null }
    $leaf = Split-Path -Leaf $cand
    $nameHint = if ($leaf -match "(cli_)?(aa[0-9a-f]{14})") { "cli_" + $matches[2] } else { $null }
    $verified = [bool]($nameHint -and $appId)
    $warn = ""
    if ($exists -and $appId -and -not $nameHint) { $warn = "目录名不含 appId，无法自检（appId=" + $appId + "）" }
    $status = if (-not $exists) { "missing" } elseif (-not $appId) { "no-config" } elseif ($nameHint -and ($appId -ne $nameHint)) { "appId-mismatch" } else { "usable" }
    $report.candidates += [pscustomobject]@{ dir = $cand; exists = $exists; appId = $appId; status = $status; verified = $verified; warn = $warn }
  }
  if ($Requested) {
    if (-not (Test-Path -LiteralPath $Requested)) { throw ("显式 -LarkDir 不存在： " + $Requested) }
    $report.chosen = $Requested; $report.appId = Get-LarkConfigAppId $Requested; $report.source = "explicit"; $report.reason = "命令行 -LarkDir"
    return $report
  }
  $pin = Get-DevicePin
  if ($pin -and $pin.larkDir) {
    if (Test-Path -LiteralPath $pin.larkDir) {
      $actual = Get-LarkConfigAppId $pin.larkDir
      if (-not $actual) {
        # 目录在、但 config.json 缺失/损坏：不能盲用（否则等于静默选中一个未配置的 bot）。
        $report.source = "device-pin-no-config"
        $report.reason = ("设备层固定的目录没有可读 config.json，已回落到探测：" + $pin.larkDir)
      } elseif ($pin.expectedAppId -and ($actual -ne [string]$pin.expectedAppId)) {
        $report.source = "device-pin-mismatch"
        $report.reason = ("设备层固定的 appId 与实际不符：期望 " + $pin.expectedAppId + "，实际 " + $actual + "；已忽略该固定值")
      } else {
        $report.chosen = $pin.larkDir; $report.appId = $actual; $report.source = "device-pin"
        $noteText = ""
        if ($pin.note) { $noteText = " [" + $pin.note + "]" }
        $report.reason = ("设备层固定：" + $script:DeviceFile + $noteText)
        return $report
      }
    } else {
      $report.source = "device-pin-missing"
      $report.reason = ("设备层固定的目录不存在，已回落到探测：" + $pin.larkDir)
    }
  }
  foreach ($c in $report.candidates) {
    if ($c.status -eq "usable" -and -not $report.chosen) {
      $report.chosen = $c.dir; $report.appId = $c.appId; $report.source = "detected"; $report.reason = ("按候选顺序探测命中：" + (Split-Path -Leaf $c.dir))
    }
  }
  if (-not $report.chosen) { $report.source = "none"; $report.reason = "没有可用的 bot 配置目录；飞书来源会报 not_configured" }
  return $report
}

function Show-LarkResolution {
  $r = Resolve-DshLarkDir ""
  Write-Host ("chosen     : " + $r.chosen)
  Write-Host ("appId      : " + $r.appId)
  Write-Host ("source     : " + $r.source)
  Write-Host ("reason     : " + $r.reason)
  Write-Host ("deviceFile : " + $script:DeviceFile + " exists=" + (Test-Path -LiteralPath $script:DeviceFile))
  Write-Host "candidates :"
  foreach ($c in $r.candidates) {
    $tail = ""
    if (-not $c.verified -and $c.exists -and $c.appId) { $tail = "  [unverified: " + $c.warn + "]" }
    Write-Host ("  " + $c.status.PadRight(14) + " " + $c.dir + " appId=" + $c.appId + $tail)
  }
  return $r
}

if ($Action -eq "status") { [void](Show-LarkResolution); exit 0 }
if ($Action -eq "unpin") { if (Test-Path -LiteralPath $script:DeviceFile) { Remove-Item -LiteralPath $script:DeviceFile -Force }; Write-Output "unpinned"; exit 0 }
if ($Action -eq "pin") {
  if (-not $Dir) { throw "pin 需要 -Dir" }
  if (-not (Test-Path -LiteralPath $Dir)) { throw ("目录不存在：" + $Dir) }
  $actual = Get-LarkConfigAppId $Dir
  if (-not $actual) { throw ("该目录没有可读的 config.json，拒绝固定：" + $Dir) }
  New-Item -ItemType Directory -Path (Split-Path -Parent $script:DeviceFile) -Force | Out-Null
  $payload = [ordered]@{ larkDir = (Resolve-Path -LiteralPath $Dir).Path; expectedAppId = $actual; pinnedAt = [DateTimeOffset]::Now.ToString("o"); note = "pinned via dsh-superagent-lark-bot.ps1" }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:DeviceFile -Encoding utf8
  Write-Output ("pinned " + $payload.larkDir + " appId=" + $actual)
  exit 0
}