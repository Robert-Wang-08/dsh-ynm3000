$ErrorActionPreference = 'Stop'
$toolDir = 'D:\src\dsh\dsh-permission-compat\tools'

if (-not (Test-Path (Join-Path $toolDir 'apply-dsh-permission-compat.mjs'))) {
	Write-Host "[dsh-compat] missing patch tools: $toolDir"
	exit 1
}

Write-Host "[dsh-compat] ensure dsh plugins are on the 0.2 set"
& node (Join-Path $toolDir 'install-dsh-plugins.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] revert previous permission patch (if a backup exists)"
$revertEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& node (Join-Path $toolDir 'apply-dsh-permission-compat.mjs') --revert 2>$null
$permissionRevert = $LASTEXITCODE
$ErrorActionPreference = $revertEap
if ($permissionRevert -ne 0) {
	Write-Host "[dsh-compat] revert unavailable (no backup for current dsh version); continuing."
}

Write-Host "[dsh-compat] revert previous session-format patch (if a backup exists)"
$ErrorActionPreference = 'Continue'
& node (Join-Path $toolDir 'apply-dsh-session-format-compat.mjs') --revert 2>$null
$sessionRevert = $LASTEXITCODE
$ErrorActionPreference = $revertEap
if ($sessionRevert -ne 0) {
	Write-Host "[dsh-compat] revert unavailable (no session-format backup); continuing."
}

Write-Host "[dsh-compat] revert previous subagent-diagnostic patch (if a backup exists)"
$ErrorActionPreference = 'Continue'
& node (Join-Path $toolDir 'apply-dsh-subagent-diagnostic-compat.mjs') --revert 2>$null
$diagnosticRevert = $LASTEXITCODE
$ErrorActionPreference = $revertEap
if ($diagnosticRevert -ne 0) {
	Write-Host "[dsh-compat] revert unavailable (no subagent-diagnostic backup); continuing."
}

Write-Host "[dsh-compat] revert previous length-recovery patch (if a backup exists)"
$ErrorActionPreference = 'Continue'
& node (Join-Path $toolDir 'apply-dsh-length-recovery-compat.mjs') --revert 2>$null
$lengthRevert = $LASTEXITCODE
$ErrorActionPreference = $revertEap
if ($lengthRevert -ne 0) {
	Write-Host "[dsh-compat] revert unavailable (no length-recovery backup); continuing."
}

Write-Host "[dsh-compat] revert previous context-recovery patch (if a backup exists)"
$ErrorActionPreference = 'Continue'
& node (Join-Path $toolDir 'apply-dsh-context-recovery-compat.mjs') --revert 2>$null
$contextRevert = $LASTEXITCODE
$ErrorActionPreference = $revertEap
if ($contextRevert -ne 0) {
	Write-Host "[dsh-compat] revert unavailable (no context-recovery backup); continuing."
}

Write-Host "[dsh-compat] ensure session-control compatibility"
& node (Join-Path $toolDir 'ensure-dsh-session-control-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] apply permission patch"
& node (Join-Path $toolDir 'apply-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] apply session-format compat patch"
& node (Join-Path $toolDir 'apply-dsh-session-format-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] apply subagent-diagnostic compat patch"
& node (Join-Path $toolDir 'apply-dsh-subagent-diagnostic-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] apply length-recovery compat patch"
& node (Join-Path $toolDir 'apply-dsh-length-recovery-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] apply context-recovery compat patch"
& node (Join-Path $toolDir 'apply-dsh-context-recovery-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] verify"
& node (Join-Path $toolDir 'verify-dsh-permission-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] verify subagent-diagnostic compat patch"
& node (Join-Path $toolDir 'apply-dsh-subagent-diagnostic-compat.mjs') --verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] verify length-recovery compat patch"
& node (Join-Path $toolDir 'apply-dsh-length-recovery-compat.mjs') --verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] verify context-recovery compat patch"
& node (Join-Path $toolDir 'apply-dsh-context-recovery-compat.mjs') --verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] test length-recovery classification (real session usage vectors)"
& node (Join-Path $toolDir 'test-dsh-length-recovery-compat.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[dsh-compat] done. All compat patches applied."
exit 0
