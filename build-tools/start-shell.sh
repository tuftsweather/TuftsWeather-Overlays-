#!/bin/bash

choice=$1

if [ -z "$choice" ]; then
    echo "1. Run TuftsWeather Overlays"
    echo "2. Build dashboard"
    read -p "Choose an option: " choice
fi

cd ../

case "$choice" in
    1|run)
        if [ ! -f "./dist/index.html" ]; then
            npm run build
        fi
        existing_pid=$(netstat -ano 2>/dev/null | grep -E ":4318 .*LISTENING" | awk '{print $5}' | head -n 1)
        if [ -n "$existing_pid" ]; then
            echo "Stopping existing TuftsWeather Overlays listener on PID $existing_pid so this shell owns it..."
            taskkill //PID "$existing_pid" //T //F >/dev/null 2>&1 || true
            sleep 1
        fi
        echo
        echo "TuftsWeather Overlays will keep running in this shell."
        echo "Closing this shell stops TuftsWeather Overlays."
        echo
        node server/index.js
        ;;
    2|build)
        npm run build
        ;;
    *)
        if [ ! -f "./dist/index.html" ]; then
            npm run build
        fi
        node server/index.js
        ;;
esac
