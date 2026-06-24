#!/bin/bash

cd ../
echo "Removing node_modules to ensure a clean installation..."
rm -rf node_modules
npm install
if [ ! -f "config/localoverlays.local.json" ]; then
  cp "config/localoverlays.json" "config/localoverlays.local.json"
  echo "Created config/localoverlays.local.json for your local settings."
fi
echo "TuftsWeather Overlays dependencies installed successfully. You can now run the project using 'start-shell.sh' under build-tools."
read -p "Press [Enter] key to exit..."
