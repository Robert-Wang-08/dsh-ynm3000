[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Config,
  [switch]$AllowSend,
  [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$service = Join-Path $PSScriptRoot 'service.py'
# Local binding values are non-secret pointers/recipient ids; credentials stay in lark-cli.
$bindingFile = Join-Path (Split-Path -Parent $Config) 'binding.env.json'
if (Test-Path $bindingFile) {
  $bindingValues = Get-Content -LiteralPath $bindingFile -Raw | ConvertFrom-Json
  foreach ($entry in $bindingValues.PSObject.Properties) {
    if ($entry.Name -notin @('DSH_HEALTH_CHAT_ID','DSH_HEALTH_LARK_CLI','DSH_HEALTH_LARK_CONFIG_DIR','PTC_ZSTD')) {
      throw "Unsupported binding key: $($entry.Name)"
    }
    [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
  }
}
$arguments = @($service, 'tick', '--config', $Config)
if ($AllowSend) { $arguments += '--allow-send' }
& $Python @arguments
exit $LASTEXITCODE
