#Requires -Version 7.0
<#
.SYNOPSIS
    创建/更新桌面上的 SuperAgent 启动快捷方式（指向 launch-superagent.cmd）。

.DESCRIPTION
    origin: self; owner: wang; created: 2026-11-18; version: 1.0.0
    仓库根由 $PSScriptRoot 推导（scripts/ 的上级目录），不硬编码盘符，可跨设备重建。
    本脚本只创建快捷方式，不启动也不停止 superagent 服务。
    双击快捷方式 = 运行 launch-superagent.cmd（默认 start）：拉起 3082 上的 superagent
    宿主，轮询服务日志拿到带 token 的 Web URL 并自动用默认浏览器打开。

.PARAMETER Name
    快捷方式文件名（不含 .lnk），默认 启动SuperAgent。

.PARAMETER Target
    快捷方式指向的启动脚本；默认 <仓库根>\launch-superagent.cmd。

.PARAMETER WorkingDirectory
    启动目录；默认仓库根。

.PARAMETER Icon
    可选图标路径；留空用系统默认 .cmd 图标。

.PARAMETER Force
    目标 .lnk 已存在时允许覆盖；不加则警告退出（exit 2），不覆盖。

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\create-superagent-desktop-shortcut.ps1
.EXAMPLE
    pwsh -NoProfile -File scripts\create-superagent-desktop-shortcut.ps1 -Force -WhatIf
    只打印将创建的路径，不实际写入。
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Name = '启动SuperAgent',
    [string]$Target = '',
    [string]$WorkingDirectory = '',
    [string]$Icon = '',
    [string]$Description = '启动 superagent（DSH 3082）并自动打开 Web UI',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $repoRoot 'launch-superagent.cmd' }
if (-not $WorkingDirectory) { $WorkingDirectory = $repoRoot }
if (-not (Test-Path -LiteralPath $Target)) { throw ('目标不存在：' + $Target) }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop ($Name + '.lnk')
if (Test-Path -LiteralPath $lnkPath) {
    if (-not $Force) {
        Write-Warning ('快捷方式已存在，未覆盖（加 -Force 可覆盖）：' + $lnkPath)
        exit 2
    }
}

if (-not $PSCmdlet.ShouldProcess($lnkPath, '创建/覆盖桌面快捷方式')) { return }

$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $Target
$lnk.Arguments = ''
$lnk.WorkingDirectory = $WorkingDirectory
if ($Icon) { $lnk.IconLocation = $Icon }
$lnk.Description = $Description
$lnk.WindowStyle = 1
$lnk.Save()

Write-Host ('created: ' + $lnkPath)
Write-Host ('target : ' + $Target)
Write-Host ('workdir: ' + $WorkingDirectory)
