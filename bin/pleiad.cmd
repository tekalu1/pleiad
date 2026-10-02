@echo off
rem pleiad CLI launcher (ADR 0090). In the desktop app this file is resources\app\bin\pleiad.cmd and runs
rem bin\pleiad.mjs with the Node built into Ply.exe. In the repository it runs node.
setlocal
set "PLEIAD_EXE=%~dp0..\..\..\Ply.exe"
if not exist "%PLEIAD_EXE%" goto node
set ELECTRON_RUN_AS_NODE=1
"%PLEIAD_EXE%" "%~dp0pleiad.mjs" %*
exit /b %ERRORLEVEL%
:node
node "%~dp0pleiad.mjs" %*
exit /b %ERRORLEVEL%
