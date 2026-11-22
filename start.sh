#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

mkdir -p .ripple-data

# Kill any existing server or tunnel
pkill -f "node dist/index.js" || true
pkill -f "cloudflared tunnel" || true
sleep 1

# Start Ripple server
echo "[start.sh] Starting Ripple server on port 8787..."
PORT=8787 node dist/index.js > .ripple-data/server.log 2>&1 &
SERVER_PID=$!

# Wait for server to be healthy
for i in {1..30}; do
  if curl -s http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "[start.sh] Ripple server is up and healthy (PID $SERVER_PID)"
    break
  fi
  sleep 0.5
done

# Start Cloudflare Tunnel
echo "[start.sh] Starting Cloudflare Tunnel..."
rm -f .ripple-data/cloudflared.log
/home/antigravity/.local/bin/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate > .ripple-data/cloudflared.log 2>&1 &
TUNNEL_PID=$!

# Extract trycloudflare URL
TUNNEL_URL=""
for i in {1..60}; do
  if [ -f .ripple-data/cloudflared.log ]; then
    FOUND=$(grep -o 'https://[-a-zA-Z0-9\.]*\.trycloudflare\.com' .ripple-data/cloudflared.log | head -n 1 || true)
    if [ -n "$FOUND" ]; then
      TUNNEL_URL="$FOUND"
      echo "$TUNNEL_URL" > .ripple-data/public_url.txt
      echo "[start.sh] Live public URL: $TUNNEL_URL"
      break
    fi
  fi
  sleep 0.5
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[start.sh] Error: tunnel URL was not found in log"
  cat .ripple-data/cloudflared.log
  exit 1
fi

echo "[start.sh] Ripple is running! Waiting on child processes..."
wait $SERVER_PID $TUNNEL_PID
