@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "SERVICE=%~dp0dsh-superagent-service.ps1"
if not exist "%SERVICE%" (
  echo [ERROR] service script not found: %SERVICE%
  pause
  exit /b 1
)

set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SERVICE%" -Action %ACTION%
set "RC=%ERRORLEVEL%"

if not "%ACTION%"=="start" exit /b %RC%
if not "%RC%"=="0" goto :startfail

set "TRY=0"
:probe
set "URL="
set "URLFILE=%TEMP%\superagent-url-%RANDOM%.txt"
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SERVICE%" -Action url > "%URLFILE%" 2>nul
set /p URL=<"%URLFILE%"
del "%URLFILE%" >nul 2>nul
if not defined URL goto :retry
echo %URL% | findstr /b /i "http" >nul
if errorlevel 1 goto :retry
echo.
echo Opening %URL%
start "" "%URL%"
exit /b 0

:retry
set /a TRY+=1
if %TRY% lss 10 (
  timeout /t 2 /nobreak >nul
  goto :probe
)
echo.
echo [WARN] URL not found in service log. Open http://127.0.0.1:3082 manually.
pause
exit /b 0

:startfail
echo.
echo [ERROR] superagent start failed, exit=%RC%
pause
exit /b %RC%
