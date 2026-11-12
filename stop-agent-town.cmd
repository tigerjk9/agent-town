@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent-town*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo 에이전트 타운 도우미를 껐어요.
timeout /t 2 >nul
