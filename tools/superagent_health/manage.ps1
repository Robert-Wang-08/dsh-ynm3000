[CmdletBinding()]
param(
  [ValidateSet('init','install','status','start','stop','uninstall')][string]$Action = 'status',
  [string]$Config = (Join-Path $env:USERPROFILE '.dsh/device/superagent-health/config.json'),
  [string]$TaskName = 'DSH-Superagent-Health',
  [switch]$AllowSend,
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
function New-HiddenAction([string]$Executable,[string]$Arguments,[string]$Launcher,[string]$WorkingDirectory){
  $command='"'+$Executable+'" '+$Arguments
  $body=@('Option Explicit','Dim sh, code','Set sh = CreateObject("WScript.Shell")',('sh.CurrentDirectory = "'+$WorkingDirectory.Replace('"','""')+'"'),('code = sh.Run("'+$command.Replace('"','""')+'", 0, True)'),'WScript.Quit code') -join [Environment]::NewLine
  if(Test-Path -LiteralPath $Launcher){Copy-Item -LiteralPath $Launcher -Destination ($Launcher+'.bak-before-windowless') -Force}
  [IO.File]::WriteAllText($Launcher,$body,[Text.UnicodeEncoding]::new($false,$true))
  return New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32/wscript.exe') -Argument ('//B //Nologo "'+$Launcher+'"') -WorkingDirectory $WorkingDirectory
}

if ($Action -eq 'init') {
  if (Test-Path -LiteralPath $Config) { throw 'Config already exists; refusing to overwrite.' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Config) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination $Config
  Write-Output 'Created device config; sending disabled.'
  exit 0
}
if ($Action -eq 'install') {
  if (-not (Test-Path -LiteralPath $Config)) { throw 'Run init first.' }
  $settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  if ($AllowSend -and (-not $settings.delivery.enabled -or -not $settings.delivery.binding_confirmed)) {
    throw 'Sending requires a confirmed device recipient, bot identity and content policy.'
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task exists; stop/uninstall explicitly before replacement.' }
  if (-not $Python) { $Python = (Get-Command python -ErrorAction Stop).Source }
  $runner = Join-Path $PSScriptRoot 'run.ps1'
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '" -Config "' + $Config + '" -Python "' + $Python + '"'
  if ($AllowSend) { $arguments += ' -AllowSend' }
  $launcher = Join-Path (Split-Path -Parent $Config) 'superagent-health-task.vbs'
  $actionObject = New-HiddenAction (Get-Command pwsh -ErrorAction Stop).Source $arguments $launcher $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $actionObject -Trigger $trigger -Settings $options -Description 'DSH Superagent health sampler/reporter; local state and reliable outbox; no host profile changes.' | Out-Null
  Write-Output ('Installed ' + $TaskName + '; sending=' + [bool]$AllowSend)
  exit 0
}
switch ($Action) {
  'status' { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object TaskName,State; Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object LastRunTime,LastTaskResult,NextRunTime }
  'start' { Start-ScheduledTask -TaskName $TaskName }
  'stop' { Disable-ScheduledTask -TaskName $TaskName | Out-Null; Stop-ScheduledTask -TaskName $TaskName }
  'uninstall' { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
}
