@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  set "CLINIC_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    echo 未找到 Node.js。请安装 Node.js 22 或更高版本后重新打开。
    pause
    exit /b 1
  )
) else (
  set "CLINIC_NODE=node"
)
"%CLINIC_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo 需要 Node.js 22 或更高版本，请更新后重试。
  pause
  exit /b 1
)
echo 麦麦 MCP 体检站
echo 请打开下方服务输出的本机地址，端口被占用时会自动顺延。
echo 按 Ctrl+C 停止服务。
"%CLINIC_NODE%" server.mjs
pause
