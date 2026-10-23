#!/usr/bin/env bash
# bootstrap.sh — git clone to a working local cred402 instance, one command.
#
#   ./scripts/bootstrap.sh
#
# What it does, in order: installs root + frontend deps (skipped if already
# present), starts the API (sim mode — no Casper/Stripe/Plaid credentials
# needed) and the Vite console dev server, waits for the API's health check,
# seeds a full demo loop so the dashboard isn't empty on first load, then
# prints both URLs and tails both logs until you press Ctrl+C (which stops
# both processes cleanly).
#
# Zero required env vars. For a real Casper Testnet write path, Dodo/Stripe/
# Plaid, etc., see .env.example and BUILD-LOG-2026-10-23.md's "OWNER STEP"
# notes — none of that is required to see the product working locally.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

API_PORT="${CRED402_PORT:-4021}"
FRONTEND_PORT="${CRED402_FRONTEND_PORT:-5173}"
LOG_DIR="$(mktemp -d)"
API_LOG="$LOG_DIR/api.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

API_PID=""
FRONTEND_PID=""
cleanup() {
  echo ""
  echo "Stopping cred402 (API pid ${API_PID:-none}, console pid ${FRONTEND_PID:-none})…"
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== 1/4  Installing dependencies =="
if [ ! -d node_modules ]; then
  npm install
else
  echo "  (root node_modules already present — skipping; run 'npm install' manually to refresh)"
fi
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
else
  echo "  (frontend/node_modules already present — skipping)"
fi

echo "== 2/4  Starting the API (sim mode, :$API_PORT) =="
CRED402_PORT="$API_PORT" npx tsx api/server.ts > "$API_LOG" 2>&1 &
API_PID=$!

echo "  waiting for http://localhost:$API_PORT/v1/health …"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/v1/health" > /dev/null 2>&1; then
    echo "  API is up."
    break
  fi
  sleep 1
done
if ! curl -fsS "http://localhost:$API_PORT/v1/health" > /dev/null 2>&1; then
  echo "API did not come up in time — see $API_LOG" >&2
  cat "$API_LOG" >&2
  exit 1
fi

echo "== 3/4  Seeding a demo agent (register, stake, x402 revenue, credit line) =="
CRED402_PORT="$API_PORT" npx tsx scripts/seed_demo_agents.ts || echo "  (seed step failed — the API still works, just empty; see $API_LOG)"

echo "== 4/4  Starting the console (:$FRONTEND_PORT) =="
(cd frontend && CRED402_API="http://localhost:$API_PORT" npx vite --port "$FRONTEND_PORT" > "$FRONTEND_LOG" 2>&1) &
FRONTEND_PID=$!

sleep 2
cat <<EOF

cred402 is running:
  console:  http://localhost:$FRONTEND_PORT/
  API:      http://localhost:$API_PORT/v1/health
  logs:     $API_LOG
            $FRONTEND_LOG

Press Ctrl+C to stop both.
EOF

tail -f "$API_LOG" "$FRONTEND_LOG"
