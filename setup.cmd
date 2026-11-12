@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   === 에이전트 타운 설치 ===
echo.
where node >nul 2>nul || (echo [!] Node.js 가 없어요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요. & pause & exit /b 1)
for /f "delims=" %%v in ('node -v') do echo   Node.js %%v 확인
echo.
echo   1) Claude Code 훅 연결
node install-hooks.js
echo   2) 도우미 실행
call "%~dp0start-agent-town.cmd"
echo.
echo   3) 확인용 화면을 엽니다: http://localhost:4747
start "" http://localhost:4747
echo.
echo   완료! 이 창은 닫아도 됩니다. (새로 여는 Claude Code 세션부터 마을에 나타나요)
pause
