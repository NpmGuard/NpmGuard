#!/usr/bin/env bash
# Kill orphaned dev/prod processes (engine, frontend)

kill_by_port() {
  local port=$1 name=$2
  pids=$(lsof -ti :"$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Killing $name on :$port (PIDs: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null
  fi
}

kill_by_port 8000 "engine"
kill_by_port 3000 "frontend"
kill_by_port 5173 "frontend (vite)"

pkill -f "uvicorn npmguard.api:app" 2>/dev/null && echo "Killed uvicorn engine processes"
pkill -f "vite.*frontend" 2>/dev/null && echo "Killed vite processes"

echo "Done."
