# 受控部署 session-summary 的「任务打标」收尾桥接（默认 DryRun）
#
# 只在 SKILL.md 末尾追加一段带标记的说明；不改正文、不改 frontmatter。
# 部署前写 .bak，按标记幂等；-Uninstall 只移除标记块。
#
# 用法：
#   pwsh -File scripts/task-registry/deploy-summary-bridge.ps1 -Repo <repo> -SkillPath <SKILL.md> -WhatIf
#   pwsh -File scripts/task-registry/deploy-summary-bridge.ps1 -Repo <repo> -SkillPath <SKILL.md> -Apply
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$SkillPath = '',
  [string]$Vault = $env:TASK_REGISTRY_VAULT,
  [switch]$Apply,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$begin = '<!-- BEGIN task-registry bridge -->'
$end = '<!-- END task-registry bridge -->'

if (-not $SkillPath) {
  $root = $env:SKILLHUB_ROOT
  if (-not $root) { $root = 'C:\syncJIANGUO\Skill+Tool\skillhub' }
  $SkillPath = Join-Path $root 'store\installed\session-summary\SKILL.md'
}
if (-not (Test-Path -LiteralPath $SkillPath)) { throw "SKILL.md not found: $SkillPath" }
$text = Get-Content -LiteralPath $SkillPath -Raw

if ($Uninstall) {
  if ($text -notmatch [regex]::Escape($begin)) { Write-Host '[bridge] not installed'; return }
  $next = [regex]::Replace($text, "(?s)\r?\n?$([regex]::Escape($begin)).*?$([regex]::Escape($end))\r?\n?", "`n")
  if (-not $Apply) { Write-Host '[bridge] WhatIf: would remove the marked block'; return }
  Copy-Item -LiteralPath $SkillPath -Destination "$SkillPath.bak-before-taskbridge-$(Get-Date -Format yyyyMMddHHmmss)" -Force
  Set-Content -LiteralPath $SkillPath -Value $next -Encoding UTF8 -NoNewline
  Write-Host '[bridge] removed'
  return
}

if ($text -match [regex]::Escape($begin)) { Write-Host '[bridge] already installed'; return }
if (-not $Vault) { throw 'missing -Vault (or set TASK_REGISTRY_VAULT); it is written into the bridge command' }

$block = @'

{{BEGIN}}
## 12. 任务打标与近期任务表（task-registry，2026-11-19）

落盘汇总写完后，若工具可用，运行一次登记（失败不阻断报告）：

```powershell
node "{{REPO}}\tools\task-registry\cli.mjs" label --summary "<总结文件绝对路径>" --vault "{{VAULT}}" --apply
```

- 只在**新总结首次发布前**追加 `tasks / primary_task / task_labeling` 三个 frontmatter 键；正文、命名、水位都不改。
- 规则匹配不到任务时落 `T-INBOX` 并标 `review: manual`，不要硬编一个不存在的 ID。
- 历史总结不批量改写；由 publisher 每 10 分钟 `scan` 只读补关联（`_registry/summary-links.json`）。
- 工具或 vault 不可用：跳过，并在报告里注明「分类登记待补」，不阻断总结发布。
{{END}}
'@
$block = $block.Replace('{{BEGIN}}', $begin).Replace('{{END}}', $end).Replace('{{REPO}}', $Repo).Replace('{{VAULT}}', $Vault)

if (-not $Apply) {
  Write-Host "[bridge] WhatIf: would append a $($block.Length)-char marked section to $SkillPath"
  return
}
Copy-Item -LiteralPath $SkillPath -Destination "$SkillPath.bak-before-taskbridge-$(Get-Date -Format yyyyMMddHHmmss)" -Force
Set-Content -LiteralPath $SkillPath -Value ($text.TrimEnd() + $block) -Encoding UTF8 -NoNewline
Write-Host "[bridge] installed into $SkillPath"
