$ErrorActionPreference = 'Stop'
$repoDir = 'D:\src\dsh\dsh-permission-compat'
$toolDir = Join-Path $repoDir 'tools'
$remote = 'origin'
$branch = 'main'

if (-not (Test-Path (Join-Path $repoDir '.git'))) {
	Write-Host "[dsh-compat] not a git repo: $repoDir"
	exit 1
}

Write-Host "[dsh-compat] git fetch --prune $remote"
git -C $repoDir fetch --prune $remote
if ($LASTEXITCODE -ne 0) {
	Write-Host "[dsh-compat] fetch failed (network / auth). Patch left untouched."
	exit $LASTEXITCODE
}

Write-Host "[dsh-compat] fast-forward $branch -> $remote/$branch"
git -C $repoDir merge --ff-only "$remote/$branch"
if ($LASTEXITCODE -ne 0) {
	Write-Host "[dsh-compat] fast-forward failed: commit or stash local changes in $repoDir, then retry."
	exit $LASTEXITCODE
}
Write-Host "[dsh-compat] repo now at $(git -C $repoDir rev-parse --short HEAD) ($(git -C $repoDir log -1 --pretty=%s))"

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

Write-Host "[dsh-compat] done. Repo updated and compat patches reapplied."
exit 0
