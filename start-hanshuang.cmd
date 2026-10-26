@echo off
REM ---------------------------------------------------------------
REM  Hanshuang Inject Tool - dev launcher (ASCII only on purpose)
REM  cmd.exe parses .cmd files with the OEM codepage, so any non-ASCII
REM  bytes here would corrupt the batch parser. All real logic and all
REM  Chinese messages live in start-hanshuang.ps1 instead.
REM ---------------------------------------------------------------

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-hanshuang.ps1"

if errorlevel 1 (
  echo.
  echo Launcher exited with an error. See messages above.
  pause
)
