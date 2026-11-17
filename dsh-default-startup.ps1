$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ('dsh-default-startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $log -Append | Out-Null
try {
  Write-Host '[DSH startup] starting superagent 3082'
  & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'dsh-superagent-service.ps1') start
  if ($LASTEXITCODE -ne 0) { throw 'superagent 3082 start failed' }
  $webPort = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  if ($webPort) {
    Write-Host '[DSH startup] web profile already listening on 3080; skip duplicate start'
    exit 0
  }
  Write-Host '[DSH startup] starting web profile through webprofile.sh'
  $bash = 'C:\Program Files\Git\bin\bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash not found; cannot run webprofile.sh' }
  $bashRoot = ($root -replace '\\', '/') -replace '^([A-Za-z]):', '/$1'
  & $bash -lc ("exec " + $bashRoot + '/webprofile.sh')
  exit $LASTEXITCODE
} finally {
  Stop-Transcript | Out-Null
}
