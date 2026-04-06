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

# tsx/node running engine
pkill -f "tsx src/index.ts" 2>/dev/null && echo "Killed tsx engine processes"
pkill -f "node dist/index.js" 2>/dev/null && echo "Killed node engine processes"
pkill -f "vite.*frontend" 2>/dev/null && echo "Killed vite processes"

echo "Done."
