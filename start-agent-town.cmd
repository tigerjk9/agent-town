@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo [!] Node.js 가 없어요. https://nodejs.org 에서 설치해 주세요. & pause & exit /b 1)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent-town*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process node -ArgumentList '\"%~dp0server.js\"' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo 에이전트 타운 도우미를 켰어요. 링크: https://tigerjk9.github.io/agent-town/
timeout /t 3 >nul
