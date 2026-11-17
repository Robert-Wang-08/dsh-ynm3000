#Requires -Version 7.0
<#
.SYNOPSIS
    双击用的 superagent 重启入口：调用 dsh-superagent-service.ps1 restart（启动前补齐用户级环境变量）。

.DESCRIPTION
    桌面快捷方式指向本脚本。restart 会停掉 3082 上的 superagent 宿主再启动；
    有 Executor 回合在跑时服务脚本会拒绝，本脚本会询问是否强制中断。
    结束时保持窗口，便于查看 pid/URL/错误。

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\restart-superagent.ps1
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\restart-superagent.ps1 -WhatIf
    只打印将要执行的动作，不重启（用于自检）。
#>
[CmdletBinding()]
param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$service = Join-Path $PSScriptRoot 'dsh-superagent-service.ps1'
if (-not (Test-Path -LiteralPath $service)) {
    Write-Host ('找不到服务脚本：' + $service)
    Read-Host '按 Enter 关闭'
    exit 1
}

function Invoke-ServiceRestart([switch]$Force) {
    $parameters = @{ Action = 'restart' }
    if ($Force) { $parameters['Force'] = $true }
    if ($WhatIf) {
        $shown = ($parameters.GetEnumerator() | Sort-Object Key | ForEach-Object { '-' + $_.Key + ' ' + $_.Value }) -join ' '
        Write-Host ('[WhatIf] pwsh -File "' + $service + '" ' + $shown)
        return 0
    }
    & $service @parameters
    return $LASTEXITCODE
}

Write-Host '=== 重启 superagent（3082） ==='
Write-Host '启动时会先补齐用户级环境变量（只补缺失、不打印值）。'
Write-Host ''

$code = Invoke-ServiceRestart
if ($WhatIf) {
    Write-Host ''
    Write-Host '[WhatIf] 未实际重启；去掉 -WhatIf 才会执行。'
    exit 0
}
if ($code -eq 0) {
    Write-Host ''
    Write-Host 'restart 完成：新宿主已带上当前用户环境。'
    Read-Host '按 Enter 关闭窗口'
    exit 0
}

Write-Host ''
Write-Host ('restart 未完成（exit ' + $code + '）。')
Write-Host '常见原因：有 Executor 回合在跑，脚本拒绝中断；或端口/状态未就绪。'

$answer = Read-Host '要强制重启并中断在跑回合吗？输入 y 继续，直接回车退出'
if ($answer -match '^(y|yes|是)$') {
    $code = Invoke-ServiceRestart -Force
    Write-Host ''
    if ($code -eq 0) { Write-Host '强制 restart 完成。' } else { Write-Host ('强制 restart 仍失败（exit ' + $code + '），请查看上面的报错。') }
    Read-Host '按 Enter 关闭窗口'
    exit $code
}

Write-Host '已取消，未重启。'
Read-Host '按 Enter 关闭窗口'
exit $code
