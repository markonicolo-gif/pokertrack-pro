@echo off
title PokerTrack Pro - Data Integrity Audit
cd /d "%~dp0"
echo.
echo ===============================================
echo   PokerTrack Pro - Deep Stats Audit
echo ===============================================
echo.
echo This will re-parse every zip in data\ from scratch
echo and cross-check against the dashboard JSON.
echo.
echo Takes ~30-60 seconds depending on data size.
echo.
node --max-old-space-size=8192 audit-stats.js
echo.
pause
