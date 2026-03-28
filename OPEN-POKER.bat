@echo off
cd /d "%~dp0"

:: Kill any leftover server on port 8765
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8765"') do taskkill /f /pid %%a >nul 2>&1

echo Starting PokerTrack Pro...
start /b npx --yes serve . -p 8765
timeout /t 4 /nobreak >nul
start "" http://localhost:8765

echo.
echo PokerTrack Pro is running at http://localhost:8765
echo Keep this window open while using the app.
echo Close this window to stop.
echo.
pause
