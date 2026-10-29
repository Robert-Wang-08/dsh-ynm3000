<#
.SYNOPSIS
  修复系统 PATH 中误登记的 per-user WindowsApps 目录（先备份，再执行）。

.DESCRIPTION
  本机 HKLM 的 PATH 里混进了一条 per-user 目录
  c:\users\<user>\appdata\local\microsoft\windowsapps，
  机器 PATH 排在用户 PATH 之前，会压掉用户级 conda/miniforge 条目，
  使 python 命中 Microsoft Store 的别名占位符（"Python was not found"）。

  本脚本只做两件事：
    1) 备份：reg export 整个 HKLM Environment 键 + 单独落一份 PATH 值（含值类型）；
    2) 执行：从【机器】PATH 移除匹配条目（默认 windowsapps），保留值类型，
       并广播 WM_SETTINGCHANGE 让新进程立即生效。

  不加 -Apply 时只预览（仍会生成备份）；加 -Apply 才写入，且需要管理员权限。

.PARAMETER Apply
  真正写入 HKLM。

.PARAMETER Pattern
  要移除的条目匹配正则，默认 AppData\\Local\\Microsoft\\WindowsApps（不分大小写）。

.PARAMETER BackupRoot
  备份根目录，默认 %USERPROFILE%\.dsh\backups。

.PARAMETER RestoreFrom
  从某次备份的 machine-path.txt 还原（回滚用）。

.PARAMETER NoBroadcast
  不广播 WM_SETTINGCHANGE。

.EXAMPLE
  pwsh -NoProfile -File .\dsh-fix-machine-path.ps1

.EXAMPLE
  pwsh -NoProfile -File .\dsh-fix-machine-path.ps1 -Apply
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Pattern = 'AppData\\Local\\Microsoft\\WindowsApps',
  [string]$BackupRoot,
  [string]$RestoreFrom,
  [switch]$NoBroadcast
)

$ErrorActionPreference = 'Stop'
$KeyPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$RegKey  = 'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$NL      = [Environment]::NewLine

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Send-EnvChanged {
  if ($NoBroadcast) { return }
  try {
    $src = @'
using System;
using System.Runtime.InteropServices;
public static class DshEnv {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
      string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
    if (-not ('DshEnv' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
    $result = [UIntPtr]::Zero
    [void][DshEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    Write-Host '[broadcast] WM_SETTINGCHANGE sent' -ForegroundColor DarkGray
  } catch {
    Write-Warning ('广播 WM_SETTINGCHANGE 失败（不影响写入，重启后自然生效）：' + $_.Exception.Message)
  }
}

function Read-MachinePath {
  $item  = Get-Item -LiteralPath $KeyPath
  $kind  = $item.GetValueKind('Path').ToString()
  $value = $item.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
  return [pscustomobject]@{ Kind = $kind; Value = [string]$value }
}

function Write-MachinePath([string]$Value, [string]$Kind) {
  $type = if ($Kind -eq 'ExpandString') { 'ExpandString' } elseif ($Kind -eq 'String') { 'String' } else { 'ExpandString' }
  Set-ItemProperty -LiteralPath $KeyPath -Name 'Path' -Value $Value -Type $type
}

function Save-Backup([string]$Value, [string]$Kind) {
  $root = if ($BackupRoot) { $BackupRoot } else { Join-Path $env:USERPROFILE '.dsh\backups' }
  $dir  = Join-Path $root ('machine-path-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  $regFile = Join-Path $dir 'HKLM-Environment.reg'
  $export  = & reg.exe export $RegKey $regFile /y 2>&1
  $regOk   = ($LASTEXITCODE -eq 0 -and (Test-Path $regFile))
  if (-not $regOk) { Write-Warning ('reg export 失败：' + ($export -join ' ')) }

  $txt    = Join-Path $dir 'machine-path.txt'
  $header = @(
    '# machine PATH backup',
    ('# created  = ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
    ('# machine  = ' + $env:COMPUTERNAME),
    ('# kind     = ' + $Kind),
    ('# length   = ' + $Value.Length),
    '# rollback = pwsh -NoProfile -File <this script> -RestoreFrom "<this file>"',
    '# rollback2= reg import "<HKLM-Environment.reg>"',
    '---value---'
  )
  Set-Content -LiteralPath $txt -Value ($header + $Value) -Encoding utf8
  return [pscustomobject]@{ Dir = $dir; RegFile = $regFile; TxtFile = $txt; RegOk = $regOk }
}

# ── 回滚分支 ────────────────────────────────────────────────────────────────
if ($RestoreFrom) {
  if (-not (Test-Path -LiteralPath $RestoreFrom)) { throw ('备份文件不存在：' + $RestoreFrom) }
  if (-not (Test-Admin)) { Write-Host '回滚需要管理员权限（要写 HKLM）。请用管理员 PowerShell 重跑。' -ForegroundColor Red; exit 2 }
  $lines = @(Get-Content -LiteralPath $RestoreFrom -Encoding utf8)
  $kind  = 'ExpandString'
  foreach ($l in $lines) { if ($l -match '^#\s*kind\s*=\s*(\S+)') { $kind = $Matches[1] } }
  $idx = [Array]::IndexOf($lines, '---value---')
  if ($idx -lt 0) { throw '备份文件格式不对：缺少 ---value--- 分隔行' }
  $value = ($lines[($idx + 1)..($lines.Count - 1)]) -join $NL
  $cur = Read-MachinePath
  $bk  = Save-Backup $cur.Value $cur.Kind
  Write-Host ('[backup] ' + $bk.Dir) -ForegroundColor Green
  Write-MachinePath $value $kind
  Send-EnvChanged
  Write-Host ('[restore] 已还原，kind=' + $kind + ' len=' + $value.Length) -ForegroundColor Green
  exit 0
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
$cur = Read-MachinePath
Write-Host ('当前机器 PATH：kind=' + $cur.Kind + '  length=' + $cur.Value.Length)

$parts    = @($cur.Value -split ';' | Where-Object { $_ -ne '' })
$matched  = @($parts | Where-Object { $_ -match $Pattern })
$kept     = @($parts | Where-Object { $_ -notmatch $Pattern })
$newValue = ($kept -join ';')

Write-Host ''
Write-Host ('匹配 "' + $Pattern + '" 的条目：' + $matched.Count) -ForegroundColor Cyan
foreach ($m in $matched) { Write-Host ('  - ' + $m) -ForegroundColor Yellow }
Write-Host ('保留条目：' + $kept.Count + '（原 ' + $parts.Count + '）')

if ($matched.Count -eq 0) {
  Write-Host '没有需要移除的条目，未做任何改动。' -ForegroundColor Green
  exit 0
}

$bk = Save-Backup $cur.Value $cur.Kind
Write-Host ''
Write-Host ('[backup] ' + $bk.Dir) -ForegroundColor Green
Write-Host ('         reg = ' + $bk.RegFile + $(if ($bk.RegOk) { '' } else { '  (导出失败)' }))
Write-Host ('         txt = ' + $bk.TxtFile)

if (-not $Apply) {
  Write-Host ''
  Write-Host '这是预览（未写入）。确认无误后加 -Apply 执行：' -ForegroundColor Cyan
  Write-Host ('  pwsh -NoProfile -File ' + $PSCommandPath + ' -Apply')
  Write-Host ('写入后长度：' + $newValue.Length + '（当前 ' + $cur.Value.Length + '）')
  exit 0
}

if (-not (Test-Admin)) {
  Write-Host '写 HKLM 需要管理员权限。请用管理员 PowerShell 重跑同一条命令（退出码 2）。' -ForegroundColor Red
  exit 2
}

Write-MachinePath $newValue $cur.Kind
Send-EnvChanged

$after        = Read-MachinePath
$stillMatched = @($after.Value -split ';' | Where-Object { $_ -match $Pattern })
Write-Host ''
Write-Host ('[done] kind=' + $after.Kind + '  length ' + $cur.Value.Length + ' -> ' + $after.Value.Length)
if ($stillMatched.Count -gt 0) {
  Write-Warning ('仍残留 ' + $stillMatched.Count + ' 条匹配项，请人工核对。')
  exit 1
}
Write-Host '验证：新开的进程里 where python 应命中 conda 环境而不是 WindowsApps。' -ForegroundColor Green
Write-Host ('回滚：pwsh -NoProfile -File ' + $PSCommandPath + ' -RestoreFrom "' + $bk.TxtFile + '"')
Write-Host ('或  ：reg import "' + $bk.RegFile + '"')
exit 0
