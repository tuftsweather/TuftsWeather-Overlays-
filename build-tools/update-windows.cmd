@echo off
setlocal
cd /d "%~dp0.."

echo Updating TuftsWeather Overlays...

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Install Git for Windows, then run this again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo This folder is not a Git checkout.
  echo Download updates with Git first, then this updater can pull future versions.
  pause
  exit /b 1
)

if exist "config\localoverlays.local.json" (
  if not exist "config\backups" mkdir "config\backups"
  copy /y "config\localoverlays.local.json" "config\backups\localoverlays.local.before-update.json" >nul
)

git pull --ff-only
if errorlevel 1 (
  echo Update failed. If you edited project files, Git may need those changes handled first.
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

if not exist "config\localoverlays.local.json" (
  copy /y "config\localoverlays.json" "config\localoverlays.local.json" >nul
)

echo Update complete. Your local config was kept.
pause
