#!/bin/bash
# Double-click this file in Finder to start Plaud Exporter

cd "$(dirname "$0")"

# Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Start server in background
npm start &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server..."
until curl -s http://localhost:3000 > /dev/null 2>&1; do
  sleep 0.3
done

# Open browser
open http://localhost:3000

# Keep terminal open and show server logs
wait $SERVER_PID
