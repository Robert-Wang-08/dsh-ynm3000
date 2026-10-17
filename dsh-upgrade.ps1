[CmdletBinding()]
param(
	[string]$Version = '0.2.0-rc.2',
	[switch]$SkipCompat,
	[switch]$Force
)

$ErrorActionPreference = 'Stop'
# Native commands report failure via $LASTEXITCODE; never let their stderr terminate us.
$PSNativeCommandUseErrorActionPreference = $false

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$package = '@deepseek-ai/dsh'

function Get-InstalledDshVersion {
	try {
		$root = (npm root -g).Trim()
	} catch {
		return $null
	}
	$manifest = Join-Path $root '@deepseek-ai\dsh\package.json'
	if (-not (Test-Path -LiteralPath $manifest)) { return $null }
	return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
}

$before = Get-InstalledDshVersion
if ($before) {
	Write-Host "[dsh-upgrade] current installed dsh: $before"
} else {
	Write-Host '[dsh-upgrade] dsh not found in the global npm root; a fresh install will be attempted.'
}

if ($before -eq $Version -and -not $Force) {
	Write-Host "[dsh-upgrade] already at $Version; skipping install (use -Force to reinstall)."
} else {
	Write-Host "[dsh-upgrade] npm install -g $package@$Version"
	npm install -g "$package@$Version"
	if ($LASTEXITCODE -ne 0) {
		Write-Host "[dsh-upgrade] install failed (network / registry). dsh left untouched."
		exit $LASTEXITCODE
	}
}

$after = Get-InstalledDshVersion
if ($after -ne $Version) {
	Write-Host "[dsh-upgrade] version mismatch after install: expected $Version, got $($after ?? 'none')."
	exit 1
}
Write-Host "[dsh-upgrade] dsh now at $after"

if ($SkipCompat) {
	Write-Host '[dsh-upgrade] -SkipCompat set; compat patches not reapplied.'
	exit 0
}

$apply = Join-Path $rootDir 'dsh-apply-patches.ps1'
if (-not (Test-Path -LiteralPath $apply)) {
	Write-Host "[dsh-upgrade] patch script not found: $apply"
	exit 1
}

Write-Host '[dsh-upgrade] reapplying compat patches via dsh-apply-patches.ps1'
& $apply
exit $LASTEXITCODE
