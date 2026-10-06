@echo off
rem pleiad CLI launcher (ADR 0090). In the desktop app this file is resources\app\bin\pleiad.cmd and runs
rem bin\pleiad.mjs with the Node built into Ply.exe. In a per-version runtime copy (%LOCALAPPDATA%\agent-host-runtime\app\<version>\bin,
rem docs/zero-downtime-update/plan.md 1-3) it runs the pleiad-node.exe that ..\runtime-node.txt names. In the repository it runs node.
setlocal
set "PLEIAD_NODE="
if exist "%~dp0..\runtime-node.txt" for /f "usebackq delims=" %%N in ("%~dp0..\runtime-node.txt") do set "PLEIAD_NODE=%~dp0..\..\..\node\%%N\pleiad-node.exe"
if defined PLEIAD_NODE if exist "%PLEIAD_NODE%" goto runtime
set "PLEIAD_EXE=%~dp0..\..\..\Ply.exe"
if not exist "%PLEIAD_EXE%" goto node
set ELECTRON_RUN_AS_NODE=1
"%PLEIAD_EXE%" "%~dp0pleiad.mjs" %*
exit /b %ERRORLEVEL%
:runtime
"%PLEIAD_NODE%" "%~dp0pleiad.mjs" %*
exit /b %ERRORLEVEL%
:node
node "%~dp0pleiad.mjs" %*
exit /b %ERRORLEVEL%
