@echo off
rem Start the DeepSeek Harness desktop app from a terminal.
rem Uses this folder's Electron; the window has no console of its own.
setlocal
set "APP_DIR=%~dp0"
set "ELECTRON=%APP_DIR%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Electron is not installed yet. Run:  npm install
  exit /b 1
)
start "" "%ELECTRON%" "%APP_DIR:~0,-1%" %*
endlocal
