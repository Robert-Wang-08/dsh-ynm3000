#Requires -Version 5.1
<#
.SYNOPSIS
  一键查看或修改 dsh-superagent 新会话默认使用的 provider 与模型。

.DESCRIPTION
  通过运行中 dsh-superagent 的管理接口（/orchestrator/api，与 Web 面板同一个落点）读写两个角色模型：

    eval     = 研判 / 主 Session 模型（Feishu 里和人对答的主会话）
    executor = 执行器 / 票内 worker 模型的默认值

  保存由宿主校验 provider/model 能否解析，不需要重启服务；只对修改之后新建的会话生效，
  已在运行的会话（含当前主会话）保持自己的模型选择。

  本机约定的“默认”优先级：superagent 角色模型 > DSH profile 的 agent-default-model。
  后者只能改 profile 配置并重启，不在本脚本范围内。

.PARAMETER Action
  show（默认）：打印两个角色模型与 DSH 当前默认。
  list：列出管理接口目录里的 provider / model / reasoning effort。
  set：保存新模型，必须同时给 -Role、-Provider、-Model。

.PARAMETER Role
  set 的目标：eval、executor 或 both。

.PARAMETER Provider
  精确 provider id，例如 opencode-go、ais-2dsglm、codex-relay。

.PARAMETER Model
  精确 model id，例如 deepseek-v4.1-flash、gpt-6.1-sol。

.PARAMETER ReasoningEffort
  可选 reasoning effort（适配器支持时）。省略时：provider 未变则沿用当前 effort，provider 变了则不带 effort；
  传 keep 表示强制沿用当前 effort。

.PARAMETER DryRun
  只打印将要写入的值，不发保存请求。

.EXAMPLE
  .\dsh-superagent-model.ps1
  查看当前两个角色模型。

.EXAMPLE
  .\dsh-superagent-model.ps1 set -Role both -Provider opencode-go -Model deepseek-v4.1-flash -ReasoningEffort high -DryRun
  预演把主会话与执行器默认都改成 opencode-go/deepseek-v4.1-flash。

.EXAMPLE
  .\dsh-superagent-model.ps1 set -Role executor -Provider ais-2dsglm -Model deepseek-flash
  只改执行器默认模型。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('show', 'list', 'set')]
  [string]$Action = 'show',

  [ValidateSet('eval', 'executor', 'both')]
  [string]$Role,

  [string]$Provider,
  [string]$Model,
  [string]$ReasoningEffort = '',

  [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),
  [switch]$DryRun,
  [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Stop'

$script:Base = $Url.TrimEnd('/') + '/orchestrator/api/'
$script:Headers = @{ 'x-orchestrator-request' = '1'; Accept = 'application/json' }
$script:RoleLabel = [ordered]@{
  eval     = '研判 / 主 Session (eval)'
  executor = '执行器 / worker (executor)'
}
$script:Target = ''
if ($Provider) { $script:Target = $Provider }
if ($Model) {
  if ($script:Target) { $script:Target += ' / ' + $Model } else { $script:Target = $Model }
}

function Read-ErrorBody {
  param($ErrorRecord)
  # PowerShell 5.1 与 7 都会把响应体放进 ErrorDetails.Message；优先用它。
  if ($ErrorRecord.ErrorDetails -and -not [string]::IsNullOrWhiteSpace($ErrorRecord.ErrorDetails.Message)) {
    return $ErrorRecord.ErrorDetails.Message
  }
  $response = $ErrorRecord.Exception.Response
  if ($null -eq $response) { return $null }
  try {
    $stream = $response.GetResponseStream()
    if ($stream) {
      $reader = New-Object System.IO.StreamReader($stream)
      return $reader.ReadToEnd()
    }
  } catch { }
  try {
    $content = $response.Content
    if ($content) { return $content.ReadAsStringAsync().GetAwaiter().GetResult() }
  } catch { }
  return $null
}

function Invoke-Api {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    $Body
  )
  $request = @{
    Uri             = $script:Base + $Path
    Method          = $Method
    Headers         = $script:Headers
    TimeoutSec      = $TimeoutSec
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $request.Body = ConvertTo-Json -InputObject $Body -Depth 30 -Compress
    $request.ContentType = 'application/json; charset=utf-8'
  }
  try {
    $response = Invoke-WebRequest @request
    if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
    return $response.Content | ConvertFrom-Json
  } catch {
    $status = $null
    try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    if ($null -eq $status) {
      throw "无法连接 $($script:Base)（服务未启动或端口不同？用 scripts/dsh-superagent status 检查，或用 -Url 指定地址）"
    }
    $raw = Read-ErrorBody $_
    $detail = $raw
    $code = ''
    if ($raw) {
      try {
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.error) { $detail = [string]$parsed.error }
        $code = [string]$parsed.code
      } catch { }
    }
    $text = "管理接口返回 HTTP $status：$detail"
    if ($code) { $text += " [code=$code]" }
    if ($status -eq 409) {
      $text += "`n设置在你读取之后被改动（并发保存）。重新运行本命令即可按最新 revision 重放。"
    } elseif ($code -eq 'modelUnavailable') {
      $text += "`n宿主无法解析这个 provider/model（模型不存在、provider 未启用或路由不可达）。用 list 或面板设置页确认精确 id 后再试。"
    }
    throw $text
  }
}

function Format-Model {
  param($Selection)
  if ($null -eq $Selection) { return '(未设置，跟随 DSH 默认)' }
  $text = '{0} / {1}' -f $Selection.provider, $Selection.model
  if ($Selection.PSObject.Properties.Name -contains 'reasoningEffort' -and $Selection.reasoningEffort) {
    $text += '  effort=' + $Selection.reasoningEffort
  }
  return $text
}

function Resolve-Effort {
  param($Current, [string]$Requested)
  $hasCurrent = $Current -and ($Current.PSObject.Properties.Name -contains 'reasoningEffort')
  $currentEffort = ''
  if ($hasCurrent) { $currentEffort = [string]$Current.reasoningEffort }
  if ($Requested -eq 'keep') { return $currentEffort }
  if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested }
  # 未显式指定：provider 不变时沿用当前 effort，provider 变化时不带 effort。
  if ($Current -and $Current.provider -eq $Provider) { return $currentEffort }
  return ''
}

function Get-Catalog {
  return Invoke-Api -Method 'GET' -Path 'models'
}

function Test-InCatalog {
  param($Catalog, [string]$ProviderId, [string]$ModelId)
  if ($null -eq $Catalog -or $null -eq $Catalog.groups) { return $null }
  $group = $Catalog.groups | Where-Object { $_.id -eq $ProviderId } | Select-Object -First 1
  if ($null -eq $group) { return $false }
  $found = $group.models | Where-Object { $_.id -eq $ModelId } | Select-Object -First 1
  return ($null -ne $found)
}

function Show-Models {
  $settings = Invoke-Api -Method 'GET' -Path 'settings'
  $catalog = Get-Catalog
  Write-Output ''
  Write-Output ('dsh-superagent 角色模型    {0}' -f $Url)
  Write-Output ''
  foreach ($name in @('eval', 'executor')) {
    $block = $settings.blocks.$name
    Write-Output ('  {0,-28} : {1}   (revision {2})' -f $script:RoleLabel[$name], (Format-Model $block.value.model), $block.revision)
  }
  Write-Output ('  {0,-28} : {1}' -f 'DSH 当前默认 (profile)', (Format-Model $catalog.default))
  Write-Output ''
  Write-Output '  生效范围：只对修改之后新建的会话生效；已在运行的会话（含当前主会话）保持自己的模型选择。'
  Write-Output '  改主会话当前模型：在会话头部模型选择器切换，或等新会话。'
  Write-Output ''
}

function Show-Providers {
  $catalog = Get-Catalog
  Write-Output ''
  Write-Output ('模型目录    {0}' -f $Url)
  Write-Output ''
  Write-Output ('  DSH 当前默认 : {0}' -f (Format-Model $catalog.default))
  Write-Output ''
  foreach ($group in $catalog.groups) {
    $routable = ''
    if ($catalog.routableProviders -contains $group.id) { $routable = ' [可路由]' }
    Write-Output ('  {0}  ({1}){2}' -f $group.id, $group.name, $routable)
    foreach ($entry in $group.models) {
      $efforts = ''
      if ($entry.reasoning -and $entry.reasoning.efforts) {
        $efforts = '  efforts=' + (($entry.reasoning.efforts | ForEach-Object { $_.id }) -join '/')
        if ($entry.reasoning.defaultEffort) { $efforts += ' 默认=' + $entry.reasoning.defaultEffort }
      }
      Write-Output ('    - {0,-28} {1}{2}' -f $entry.id, $entry.name, $efforts)
    }
  }
  if ($catalog.failures) {
    Write-Output ''
    Write-Output ('  近期 provider 失败记录：' + ($catalog.failures | ConvertTo-Json -Depth 6 -Compress))
  }
  Write-Output ''
}

function Set-Models {
  if (-not $Role) { throw 'set 需要 -Role eval|executor|both' }
  if ([string]::IsNullOrWhiteSpace($Provider) -or [string]::IsNullOrWhiteSpace($Model)) {
    throw 'set 需要 -Provider 与 -Model（精确 id）'
  }

  $catalog = Get-Catalog
  $inCatalog = Test-InCatalog -Catalog $catalog -ProviderId $Provider -ModelId $Model

  $targets = @($Role)
  if ($Role -eq 'both') { $targets = @('eval', 'executor') }

  $settings = Invoke-Api -Method 'GET' -Path 'settings'
  $plan = @()
  foreach ($name in $targets) {
    $block = $settings.blocks.$name
    if ($null -eq $block) { throw "管理接口没有 $name 设置块，无法保存" }
    # 整个块回写：只替换 model，其它字段（mode/timeoutSeconds、maxWorkers/directory/prepare/blockedCommands）原样保留。
    $value = $block.value
    $current = $value.model
    $effort = Resolve-Effort -Current $current -Requested $ReasoningEffort
    $selection = [ordered]@{}
    $selection['provider'] = $Provider
    $selection['model'] = $Model
    if (-not [string]::IsNullOrWhiteSpace($effort)) { $selection['reasoningEffort'] = $effort }
    $value | Add-Member -NotePropertyName model -NotePropertyValue ([pscustomobject]$selection) -Force
    $plan += [pscustomobject]@{
      role     = $name
      label    = $script:RoleLabel[$name]
      revision = [int]$block.revision
      value    = $value
      before   = (Format-Model $current)
      after    = (Format-Model ([pscustomobject]$selection))
    }
  }

  Write-Output ''
  Write-Output ('目标：{0}    {1}' -f $Url, $script:Target)
  foreach ($item in $plan) {
    Write-Output ('  {0,-28} : {1}  ->  {2}   (revision {3})' -f $item.label, $item.before, $item.after, $item.revision)
  }
  if ($inCatalog -eq $false) {
    Write-Output ''
    Write-Output '  注意：该 provider/model 不在当前模型目录中（面板里也不可选）。若适配器实际接受它，保存仍可能成功。'
  }

  if ($DryRun) {
    Write-Output ''
    Write-Output '  这是 DryRun：没有写入任何设置。'
    Write-Output ''
    return
  }

  $saved = @()
  foreach ($item in $plan) {
    $result = Invoke-Api -Method 'PUT' -Path ('settings/' + $item.role) -Body @{ value = $item.value; revision = $item.revision }
    $saved += [pscustomobject]@{ role = $item.role; label = $item.label; before = $item.before; after = $item.after; result = $result }
  }

  # 读回复核：以运行中服务返回值为准，而不是相信请求参数。
  $verify = Invoke-Api -Method 'GET' -Path 'settings'
  Write-Output ''
  Write-Output '结果：'
  $failed = @()
  foreach ($item in $saved) {
    $block = $verify.blocks.($item.role)
    $actual = Format-Model $block.value.model
    $ok = ($block.value.model.provider -eq $Provider) -and ($block.value.model.model -eq $Model)
    if (-not $ok) { $failed += $item.role }
    $revisionText = ''
    if ($item.result -and $item.result.PSObject.Properties.Name -contains 'revision') { $revisionText = ' revision=' + $item.result.revision }
    $okText = '不一致'
    if ($ok) { $okText = 'OK' }
    Write-Output ('  {0,-28} : {1}  保存后读到 {2}{3}  {4}' -f $item.label, $item.after, $actual, $revisionText, $okText)
    if ($item.result -and $item.result.PSObject.Properties.Name -contains 'restarting' -and $item.result.restarting) {
      Write-Output '  注意：这次保存触发了服务重启（通常由其它字段引起，模型切换本身不需要重启）。'
    }
  }
  Write-Output ''
  if ($failed.Count -gt 0) {
    Write-Output ('  复核不一致：' + ($failed -join ', ') + '（并发改动或服务拒绝，请重新 show 确认）')
    exit 1
  }
  Write-Output '  生效范围：只对修改之后新建的会话生效；已在运行的会话（含当前主会话）保持原模型。'
  Write-Output '  回退：用同样的 set 命令把上面“保存前”的 provider/model/effort 写回。'
  Write-Output ''
}

try {
  switch ($Action) {
    'show' { Show-Models }
    'list' { Show-Providers }
    'set'  { Set-Models }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('错误：' + $_.Exception.Message)
  exit 1
}
