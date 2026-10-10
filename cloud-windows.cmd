@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "CLOUD_BOOTSTRAP_NODE=%~dp0.desktop-build\runtime\node-v24.21.0-win-x64\node.exe"
if exist "%CLOUD_BOOTSTRAP_NODE%" goto launch
set "CLOUD_BOOTSTRAP_NODE=node"
where node >nul 2>nul
if errorlevel 1 goto missing_node

:launch
"%CLOUD_BOOTSTRAP_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto missing_node
"%CLOUD_BOOTSTRAP_NODE%" "%~dp0cloud-save-worker\scripts\windows.cjs" %*
exit /b %ERRORLEVEL%

:missing_node
echo 请先安装 Node.js 24 LTS，或保留现有 Node.js 18 及以上版本用于自动准备运行环境。
exit /b 1
