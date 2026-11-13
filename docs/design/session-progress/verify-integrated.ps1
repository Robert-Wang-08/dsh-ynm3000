param([string]$Browser = $env:DSH_TEST_CHROMIUM)
$ErrorActionPreference = 'Stop'
if (-not $Browser) {
  $chrome = Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'
  $edge = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft/Edge/Application/msedge.exe'
  foreach ($candidate in @($chrome,$edge)) {
    if (Test-Path $candidate) { $Browser = $candidate; break }
  }
}
if (-not $Browser) { throw 'Set DSH_TEST_CHROMIUM or pass -Browser with Chrome/Edge.' }
$root = $PSScriptRoot
$env:PYTHONIOENCODING = 'utf-8'
& python (Join-Path $root 'build-integrated.py')
if ($LASTEXITCODE -ne 0) { throw 'Integration build failed' }
$uri = ([uri](Join-Path $root 'integrated-prototype.html')).AbsoluteUri
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('focus-hub-integration-' + [guid]::NewGuid().ToString('N'))
$browserArgs = @('--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',"--user-data-dir=$profile")
function Invoke-ReferenceChrome([string]$TaskName,[string[]]$Extra) {
  if ($env:DSH_PROGRESS_CLI) { & node $env:DSH_PROGRESS_CLI run --task $TaskName -- $Browser @browserArgs @Extra }
  else { Write-Host "Running $TaskName"; & $Browser @browserArgs @Extra }
  if ($LASTEXITCODE -ne 0) { throw "Browser failed: $TaskName" }
}
Invoke-ReferenceChrome 'focus-hub-integrated-selftest' @('--virtual-time-budget=1500','--dump-dom',($uri + '?view=dag&selftest=1')) | Set-Content -LiteralPath (Join-Path $root 'integrated-test-dom.html') -Encoding utf8
Invoke-ReferenceChrome 'focus-hub-url-reload' @('--dump-dom',($uri + '?view=board&focus=W11&selected=T112&restorecheck=1')) | Set-Content -LiteralPath (Join-Path $root 'integrated-reload-dom.html') -Encoding utf8
& node (Join-Path $root 'verify-integrated.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Integrated browser assertions failed' }
$shots = @(
  @{name='metro'; query='view=metro'},
  @{name='journey'; query='view=journey&focus=P01&selected=W11'},
  @{name='dag'; query='view=dag'},
  @{name='board'; query='view=board&focus=W11&selected=T112'},
  @{name='external'; query='view=dag&focus=P02&selected=W22'}
)
foreach ($shot in $shots) {
  Invoke-ReferenceChrome ('focus-hub-view-' + $shot.name) @('--window-size=1760,1260',"--screenshot=$(Join-Path $root ('integrated-' + $shot.name + '.png'))",($uri + '?' + $shot.query))
}
Write-Host "Done. Isolated temporary browser profile: $profile"
