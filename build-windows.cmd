@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Pokeclicker - Windows Build
pushd "%~dp0"
if errorlevel 1 goto directory_error

set "BUILD_NODE=%~dp0.desktop-build\runtime\node-v24.21.0-win-x64\node.exe"
if exist "%BUILD_NODE%" goto build
set "BUILD_NODE=node"
where node >nul 2>nul
if errorlevel 1 goto missing_node

:build
"%BUILD_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto missing_node
"%BUILD_NODE%" "%~dp0desktop\scripts\build-windows.cjs" %*
set "BUILD_RESULT=%ERRORLEVEL%"
goto finish

:missing_node
echo.
echo [需要先安装 Node.js]
echo 请打开 https://nodejs.org/en/download ，安装 Windows x64 的 Node.js 24 LTS。
echo 安装时使用默认选项，完成后关闭这个窗口，再双击本文件。
echo Node.js 只需安装一次，之后打包脚本会自动准备项目依赖。
set "BUILD_RESULT=1"
goto finish

:directory_error
echo Cannot open the project directory. Please extract the full project to a writable local folder.
set "BUILD_RESULT=1"
goto pause_exit

:finish
popd
:pause_exit
if /i "%~1"=="--ci" exit /b %BUILD_RESULT%
echo.
echo 按任意键关闭窗口。
pause >nul
exit /b %BUILD_RESULT%
