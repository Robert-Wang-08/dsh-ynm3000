# Windows env regression verifier. No registry/service/nvm4w writes.
[CmdletBinding()] param([switch]$PersistedEnvironment, [switch]$DependencyExperiment)
$ErrorActionPreference = 'Stop'
if ($PersistedEnvironment) {
  $p = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
  $p.UseShellExecute = $false
  foreach ($a in @('-NoProfile','-File',$PSCommandPath)) { $p.ArgumentList.Add($a) }
  if ($DependencyExperiment) { $p.ArgumentList.Add('-DependencyExperiment') }
  $p.Environment['PATH'] = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $c = [Diagnostics.Process]::Start($p); $c.WaitForExit(); exit $c.ExitCode
}
function Invoke-Probe([string]$Exe, [string[]]$Arguments, [string]$PathValue) {
  $p = [Diagnostics.ProcessStartInfo]::new($Exe)
  $p.UseShellExecute = $false; $p.RedirectStandardOutput = $true; $p.RedirectStandardError = $true
  foreach ($a in $Arguments) { $p.ArgumentList.Add($a) }
  if ($PSBoundParameters.ContainsKey('PathValue')) { $p.Environment['PATH'] = $PathValue }
  $c = [Diagnostics.Process]::Start($p)
  $o = $c.StandardOutput.ReadToEnd(); $e = $c.StandardError.ReadToEnd(); $c.WaitForExit()
  [pscustomobject]@{ Exit=$c.ExitCode; Out=$o.Trim(); Err=$e.Trim() }
}
function Expect([string]$Name, $Result, [int]$ExitCode=0) {
  Write-Output ("{0}: exit={1}" -f $Name,$Result.Exit)
  if ($Result.Out) { Write-Output $Result.Out }; if ($Result.Err) { Write-Output $Result.Err }
  if ($Result.Exit -ne $ExitCode) { throw "$Name expected exit $ExitCode, got $($Result.Exit)" }
}
$win = $env:SystemRoot; $git = 'C:\Program Files\Git\usr\bin'
& (Join-Path $win 'System32\whoami.exe') /groups | Select-String -SimpleMatch 'Mandatory Label' | ForEach-Object { $_.Line.Trim() }
$envExe = (Get-Command env.exe -CommandType Application -ErrorAction Stop).Source
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
Write-Output ('env resolved: ' + $envExe)
$work = Join-Path ([IO.Path]::GetTempPath()) ('dsh-env-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$probe = Join-Path $work 'probe.mjs'
Set-Content -LiteralPath $probe -Encoding utf8 -Value "console.log('NODE_X=' + process.env.NODE_X); console.log('argv=' + JSON.stringify(process.argv.slice(2)));"
Expect 'cmd /c env --version' (Invoke-Probe (Join-Path $win 'System32\cmd.exe') @('/d','/c','env --version'))
$a = @('NODE_X=42',$node,$probe,'alpha','beta')
$r = Invoke-Probe $envExe $a; Expect 'env NODE_X=42 node probe.mjs alpha beta' $r
if (-not $r.Out.Contains('NODE_X=42') -or -not $r.Out.Contains('["alpha","beta"]')) { throw 'environment/argv verification failed' }
$r = Invoke-Probe $envExe @($node,'--help'); Write-Output ('env node --help: exit=' + $r.Exit + '; first line=' + ($r.Out -split '\r?\n')[0]); if ($r.Exit -ne 0) { throw $r.Err }
$a = @(('PATH=' + $env:PATH),'env','NODE_X=nested',$node,$probe,'nested')
$r = Invoke-Probe $envExe $a; Write-Output ('DIAGNOSTIC nested env Windows PATH (Git appended): exit=' + $r.Exit); if ($r.Err) { $r.Err }
$a = @(('PATH=' + $git + ';' + $env:PATH),'env','NODE_X=nested',$node,$probe,'nested')
$r = Invoke-Probe $envExe $a; Write-Output ('DIAGNOSTIC nested env Windows PATH (Git prepended): exit=' + $r.Exit); if ($r.Exit -eq 0) { $r.Out } else { $r.Err }
$posix = Invoke-Probe (Join-Path $git 'cygpath.exe') @('-p','-u',$env:PATH)
if ($posix.Exit -ne 0) { throw $posix.Err }
$a = @(('PATH=' + $posix.Out),'env','NODE_X=nested',$node,$probe,'nested')
$r = Invoke-Probe $envExe $a; Expect 'nested env converted POSIX PATH' $r
if (-not $r.Out.Contains('NODE_X=nested')) { throw 'nested environment verification failed' }
$a = @(('PATH=' + (Join-Path $win 'System32')),'env','NODE_X=nested',$node,$probe)
Expect 'negative control: inner env absent from PATH' (Invoke-Probe $envExe $a) 127
if ($DependencyExperiment) {
  $sets = [ordered]@{ A=@('env.exe'); B=@('env.exe','msys-2.0.dll','msys-intl-8.dll'); C=@('env.exe','msys-2.0.dll','msys-intl-8.dll','msys-iconv-2.dll') }
  foreach ($k in $sets.Keys) {
    $d = Join-Path $work $k; New-Item -ItemType Directory -Path $d | Out-Null
    foreach ($f in $sets[$k]) { Copy-Item -LiteralPath (Join-Path $git $f) -Destination (Join-Path $d $f) }
    $r = Invoke-Probe (Join-Path $d 'env.exe') @('--version') (Join-Path $win 'System32')
    $expected = if ($k -eq 'C') { 0 } else { -1073741515 }
    Write-Output ('dependency case ' + $k + ': exit=' + $r.Exit + '; files=' + ($sets[$k] -join ','))
    if ($r.Exit -ne $expected) { throw "dependency case $k failed: $($r.Err)" }
  }
}
Write-Output ('PASS; isolated test files retained for inspection: ' + $work)
exit 0
