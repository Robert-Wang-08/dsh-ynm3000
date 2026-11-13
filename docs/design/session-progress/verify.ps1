param([string]$Browser = $env:DSH_TEST_CHROMIUM)
$ErrorActionPreference = "Stop"
if (-not $Browser) {
  foreach ($candidate in @("$env:ProgramFiles/Google/Chrome/Application/chrome.exe", "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe")) {
    if (Test-Path $candidate) { $Browser = $candidate; break }
  }
}
if (-not $Browser) { throw "Set DSH_TEST_CHROMIUM or pass -Browser with an installed Chrome/Edge path." }
$root = $PSScriptRoot
$uri = ([uri](Join-Path $root "prototype.html")).AbsoluteUri
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("progress-prototype-" + [guid]::NewGuid().ToString("N"))
$arguments = @("--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=$profile")
function Invoke-Chrome([string]$TaskName, [string[]]$Extra) {
  if ($env:DSH_PROGRESS_CLI) {
    & node $env:DSH_PROGRESS_CLI run --task $TaskName -- $Browser @arguments @Extra
  } else {
    Write-Host "Running $TaskName"
    & $Browser @arguments @Extra
  }
  if ($LASTEXITCODE -ne 0) { throw "Chrome failed: $TaskName" }
}
Invoke-Chrome "progress-prototype-test" @("--dump-dom", "$uri`?variant=B&selftest=1") | Set-Content -LiteralPath (Join-Path $root "test-dom.html") -Encoding utf8
& node (Join-Path $root "verify-prototype.cjs")
if ($LASTEXITCODE -ne 0) { throw "Prototype checks failed" }
foreach ($v in @("A","B","C")) {
  Invoke-Chrome "progress-view-$v" @("--window-size=1600,1100", "--screenshot=$(Join-Path $root "view-$v.png")", "$uri`?variant=$v")
}
Write-Host "Verification finished. Temporary isolated Chrome profile: $profile"
