@echo off
cd /d "%~dp0"

:: Kill any leftover server on port 8765
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8765"') do taskkill /f /pid %%a >nul 2>&1

echo Starting PokerTrack Pro (auto-rebuild upload server)...
start "PokerTrack Pro Server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:8765

echo.
echo PokerTrack Pro is running at http://localhost:8765
echo Drop ZIPs into the in-app import zone - they will be saved to data\
echo and the analytics JSON will be rebuilt automatically.
echo Keep this window open while using the app.
echo Close this window to stop.
echo.
pause
