@echo off
REM === Drag tournament zip files onto this .bat to import them ===
REM Copies dropped files into data\ then re-runs parser + injector

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================
echo  PokerTrack Pro - Tournament Importer
echo ========================================
echo.

REM Count dropped files
set "count=0"
for %%F in (%*) do set /a count+=1

if %count%==0 (
    echo No files dropped. To use:
    echo   1. Drag your tournament .zip file onto IMPORT-TOURNAMENTS.bat
    echo   2. Or drop multiple zips at once
    echo.
    echo Re-running parser on existing data/ folder anyway...
    echo.
    goto :reparse
)

echo Importing %count% file(s) into data\ ...
echo.

for %%F in (%*) do (
    if /I "%%~xF"==".zip" (
        echo   ^> Copying "%%~nxF"
        copy /Y "%%~F" "data\" >nul
        if errorlevel 1 (
            echo     [FAILED]
        ) else (
            echo     [OK]
        )
    ) else (
        echo   ^> Skipping non-zip: %%~nxF
    )
)

echo.

:reparse
echo ========================================
echo  Step 1/2: Parsing all hand histories
echo ========================================
node --max-old-space-size=8192 build-deep-from-zips.js
if errorlevel 1 (
    echo.
    echo [ERROR] Parser failed. See output above.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Step 2/2: Updating dashboard HTML
echo ========================================
node build-deep-analysis.js
if errorlevel 1 (
    echo.
    echo [ERROR] Injector failed. See output above.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  DONE! Refresh index.html in your browser
echo ========================================
echo.
echo Press any key to open the dashboard...
pause >nul
start "" "index.html"
endlocal
