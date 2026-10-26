@echo off
REM ---------------------------------------------------------------
REM  Hanshuang Inject Tool - build portable exe (ASCII only on purpose)
REM  cmd.exe parses .cmd with the OEM codepage; non-ASCII bytes here
REM  would corrupt the batch parser. Logic lives in pack-portable.ps1.
REM ---------------------------------------------------------------

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-portable.ps1"

if errorlevel 1 (
  echo.
  echo Packaging failed. See messages above.
)

pause
