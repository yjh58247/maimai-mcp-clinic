@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  set "CLINIC_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else (
  set "CLINIC_NODE=node"
)
echo 麦麦 MCP 体检站
echo 打开 http://127.0.0.1:4319
echo 按 Ctrl+C 停止服务。
"%CLINIC_NODE%" server.mjs
pause
