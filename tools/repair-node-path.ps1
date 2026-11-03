<#
.SYNOPSIS
  修复 Windows 用户级 Node.js PATH，并设置 DSH 的 DSHPACK_NODE。
.DESCRIPTION
  自动探测常见 Node.js 安装位置；备份用户 PATH；移除失效的 C:\nvm4w\nodejs
  路径；写入真实 Node 目录、npm 目录和 DSHPACK_NODE。不会修改系统 PATH、项目文件、凭据或 DSH 会话。
#>
[CmdletBinding()]
param(
  [string]$NodePath = '',
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $env:USERPROFILE '.dsh\device\node-path-backups'

function Fail([string]$Message) { Write-Error $Message; exit 1 }
function Info([string]$Message) { Write-Host $Message }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }

if (-not $NoBackup) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $backupPath = Join-Path $backupDir ('user-path-' + $stamp + '.txt')
  [System.IO.File]::WriteAllText($backupPath, $userPath, [System.Text.UTF8Encoding]::new($false))
  Info ('已备份用户 PATH: ' + $backupPath)
}

if ($NodePath -ne '') {
  $nodeExe = [System.IO.Path]::GetFullPath($NodePath)
} else {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $nodeExe = $candidates | Select-Object -First 1
}

if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  Fail '未找到 Node.js。请安装 Node.js 20+，或用 -NodePath C:\path\to\node.exe 指定。'
}

$nodeDir = Split-Path -Parent $nodeExe
$npmDir = Join-Path $env:APPDATA 'npm'
$parts = @($userPath -split ';' | Where-Object {
  $_.Trim() -ne '' -and $_ -notmatch '(?i)^[A-Z]:\nvm4w\nodejs\?$'
})
foreach ($entry in @($nodeDir, $npmDir)) {
  if ($parts -notcontains $entry) { $parts += $entry }
}
$newPath = $parts -join ';'
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
[Environment]::SetEnvironmentVariable('DSHPACK_NODE', $nodeExe, 'User')

$env:Path = (($env:Path -split ';' | Where-Object {
  $_.Trim() -ne '' -and $_ -notmatch '(?i)^[A-Z]:\nvm4w\nodejs\?$'
}) + @($nodeDir, $npmDir)) -join ';'
$env:DSHPACK_NODE = $nodeExe

Info ('Node: ' + $nodeExe)
Info ('DSHPACK_NODE: ' + $env:DSHPACK_NODE)
Info '用户 PATH 已更新。请重新打开 PowerShell，使新 PATH 对所有进程生效。'
Info '验证命令：node --version; npm --version; dsh --version'
