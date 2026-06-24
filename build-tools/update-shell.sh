#!/bin/bash

set -e

cd "$(dirname "$0")/.."

echo "Updating TuftsWeather Overlays..."

if ! command -v git >/dev/null 2>&1; then
  echo "Git was not found. Install Git, then run this again."
  read -r -p "Press [Enter] key to exit..."
  exit 1
fi

if [ ! -d ".git" ]; then
  echo "This folder is not a Git checkout."
  echo "Download updates with Git first, then this updater can pull future versions."
  read -r -p "Press [Enter] key to exit..."
  exit 1
fi

if [ -f "config/localoverlays.local.json" ]; then
  mkdir -p "config/backups"
  cp "config/localoverlays.local.json" "config/backups/localoverlays.local.before-update.json"
fi

git pull --ff-only
npm install

if [ ! -f "config/localoverlays.local.json" ]; then
  cp "config/localoverlays.json" "config/localoverlays.local.json"
fi

echo "Update complete. Your local config was kept."
read -r -p "Press [Enter] key to exit..."
