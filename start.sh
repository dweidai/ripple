#!/usr/bin/env bash
set -euo pipefail

umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

DATA_DIR=".ripple-data"
SERVER_PID_FILE="$DATA_DIR/server.pid"
TUNNEL_PID_FILE="$DATA_DIR/cloudflared.pid"
PORT="${PORT:-8787}"

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

stop_pid_file() {
  local pid_file="$1"
  local expected_pattern="$2"
  if [ -f "$pid_file" ]; then
    local old_pid
    old_pid="$(tr -dc '0-9' < "$pid_file" || true)"
    if [ -n "$old_pid" ] && [ -r "/proc/$old_pid/cmdline" ]; then
      local cmdline
      cmdline="$(tr '\0' ' ' < "/proc/$old_pid/cmdline" || true)"
      if [[ "$cmdline" == *"$expected_pattern"* ]]; then
        echo "[start.sh] Stopping previous process (PID $old_pid: $expected_pattern)..."
        kill "$old_pid" 2>/dev/null || true
        sleep 0.5
      fi
    fi
    rm -f "$pid_file"
  fi
}

cleanup() {
  rm -f "$SERVER_PID_FILE" "$TUNNEL_PID_FILE"
}
trap cleanup EXIT INT TERM

# Stop only previously recorded PIDs matching expected binaries (no broad pkill -f)
stop_pid_file "$SERVER_PID_FILE" "dist/index.js"
stop_pid_file "$TUNNEL_PID_FILE" "cloudflared"

# Start Ripple server (binds 127.0.0.1 by default)
echo "[start.sh] Starting Ripple server on 127.0.0.1:${PORT}..."
PORT="$PORT" HOST="${HOST:-127.0.0.1}" node dist/index.js > "$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PID_FILE"

# Wait for server to be healthy
for i in {1..30}; do
  if curl -s "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "[start.sh] Ripple server is up and healthy (PID $SERVER_PID)"
    break
  fi
  sleep 0.5
done

# Start Cloudflare Tunnel
rm -f "$DATA_DIR/cloudflared.log"
if [ -n "${RIPPLE_TUNNEL_TOKEN:-}" ]; then
  echo "[start.sh] Starting named Cloudflare Tunnel (Zero Trust protected)..."
  /home/antigravity/.local/bin/cloudflared tunnel --no-autoupdate run --token "$RIPPLE_TUNNEL_TOKEN" > "$DATA_DIR/cloudflared.log" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
  if [ -n "${PUBLIC_URL:-}" ]; then
    echo "$PUBLIC_URL" > "$DATA_DIR/public_url.txt"
    echo "[start.sh] Live public URL: $PUBLIC_URL"
  fi
else
  echo "[start.sh] WARNING: RIPPLE_TUNNEL_TOKEN not set; falling back to unauthenticated trycloudflare quick tunnel."
  echo "[start.sh] WARNING: For production, configure a named Cloudflare Tunnel behind Cloudflare Access / Zero Trust."
  /home/antigravity/.local/bin/cloudflared tunnel --protocol http2 --url "http://127.0.0.1:${PORT}" --no-autoupdate > "$DATA_DIR/cloudflared.log" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

  # Extract trycloudflare URL
  TUNNEL_URL=""
  for i in {1..60}; do
    if [ -f "$DATA_DIR/cloudflared.log" ]; then
      FOUND=$(grep -o 'https://[-a-zA-Z0-9\.]*\.trycloudflare\.com' "$DATA_DIR/cloudflared.log" | head -n 1 || true)
      if [ -n "$FOUND" ]; then
        TUNNEL_URL="$FOUND"
        echo "$TUNNEL_URL" > "$DATA_DIR/public_url.txt"
        echo "[start.sh] Live public URL: $TUNNEL_URL"
        break
      fi
    fi
    sleep 0.5
  done

  if [ -z "$TUNNEL_URL" ]; then
    echo "[start.sh] Error: tunnel URL was not found in log"
    cat "$DATA_DIR/cloudflared.log"
    exit 1
  fi
fi

echo "[start.sh] Ripple is running! Waiting on child processes..."
wait "$SERVER_PID" "$TUNNEL_PID"
