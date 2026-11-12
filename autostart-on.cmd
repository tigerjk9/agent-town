@echo off
chcp 65001 >nul
set "S=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-town.cmd"
> "%S%" echo @call "%~dp0start-agent-town.cmd"
echo 이제 PC를 켤 때마다 에이전트 타운 도우미가 자동으로 켜져요.
timeout /t 3 >nul
