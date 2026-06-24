@echo off
setlocal
set choice=%1

if "%choice%"=="" (
  echo 1. Run TuftsWeather Overlays
  echo 2. Build dashboard
  set /p choice=Choose an option:
)

cd /d "%~dp0.."

if /I "%choice%"=="1" goto run
if /I "%choice%"=="run" goto run
if /I "%choice%"=="2" goto build
if /I "%choice%"=="build" goto build

:run
title TuftsWeather Overlays Server
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 goto failed
)
set stopped_existing=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":4318 .*LISTENING"') do (
  echo.
  echo Stopping existing TuftsWeather Overlays listener on PID %%p so this window owns it...
  taskkill /PID %%p /T /F >nul 2>nul
  set stopped_existing=1
)
if defined stopped_existing (
  timeout /t 1 /nobreak >nul
)
echo.
echo TuftsWeather Overlays will keep running in this window.
echo Closing this window stops TuftsWeather Overlays.
echo.
node server/index.js
if errorlevel 1 goto failed
echo.
echo TuftsWeather Overlays stopped.
pause
goto end

:build
call npm run build
if errorlevel 1 goto failed
echo.
echo Build complete.
pause
goto end

:failed
echo.
echo TuftsWeather Overlays ended with an error.
pause
goto end

:end
endlocal
