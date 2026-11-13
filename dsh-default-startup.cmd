@echo off
setlocal
set "DSH_STARTUP_PS1=D:\src\dsh\dsh-default-startup.ps1"
where wt.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  start "DSH default startup" wt.exe -w 0 new-tab --title "DSH default startup" pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%DSH_STARTUP_PS1%"
) else (
  start "DSH default startup" pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%DSH_STARTUP_PS1%"
)
endlocal
