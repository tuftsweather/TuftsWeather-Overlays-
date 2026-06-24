@echo off
cd /d "%~dp0.."
echo Removing node_modules to ensure a clean installation...
if exist node_modules rmdir /s /q node_modules
call npm install
if errorlevel 1 (
  echo Install failed.
  pause
  goto end
)
if not exist "config\localoverlays.local.json" (
  copy /y "config\localoverlays.json" "config\localoverlays.local.json" >nul
  echo Created config\localoverlays.local.json for your local settings.
)
echo TuftsWeather Overlays dependencies installed successfully. You can now run the project using 'start-windows.cmd' under build-tools.
pause
:end
