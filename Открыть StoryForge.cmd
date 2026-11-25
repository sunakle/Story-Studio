@echo off
rem StoryForge launcher. Double-click to open the app.
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "EXE=node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo Electron is not installed in this folder.
  echo Run once:  npm.cmd install --cache .npm-cache
  echo.
  pause
  exit /b 1
)

start "" "%EXE%" --no-sandbox --user-data-dir=.userdata .
exit /b 0
