@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-town.cmd" 2>nul
echo 자동 시작을 껐어요.
timeout /t 2 >nul
