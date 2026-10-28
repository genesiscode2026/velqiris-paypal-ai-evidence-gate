#!/usr/bin/env bash
# ==============================================================================
# VELQIRIS SERVICE OPERATIONAL CONTROLLER (Gate AM)
# Commands: start | stop | health | test
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/competition_submissions/paypal_ai" ]; then
  BASE_DIR="$SCRIPT_DIR/competition_submissions/paypal_ai"
else
  BASE_DIR="$SCRIPT_DIR"
fi

PID_DIR="$BASE_DIR/.service_pids"
mkdir -p "$PID_DIR"

RECONCILER_PID_FILE="$PID_DIR/reconciler.pid"
SERVER_PID_FILE="$PID_DIR/api_server.pid"

DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin/docker"
if [ ! -x "$DOCKER_BIN" ]; then
  DOCKER_BIN="$(which docker 2>/dev/null || true)"
fi

cmd_start() {
  echo "=== [VELQIRIS] Starting Services ==="
  
  # 1. Start PostgreSQL Container
  if [ -x "$DOCKER_BIN" ]; then
    echo "[*] Ensuring PostgreSQL container 'velqiris-postgres' is active..."
    if ! "$DOCKER_BIN" ps --filter "name=velqiris-postgres" --format '{{.Names}}' | grep -q "velqiris-postgres"; then
      "$DOCKER_BIN" compose -f "$BASE_DIR/docker-compose.yml" up -d
    else
      echo "[+] Container 'velqiris-postgres' is already running."
    fi
  else
    echo "[!] Docker binary not found. Assuming external PostgreSQL on port 5432."
  fi

  # 2. Wait for PostgreSQL readiness
  echo "[*] Verifying PostgreSQL connection..."
  NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" node -e '
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db" });
    pool.query("SELECT 1").then(() => { console.log("[+] PostgreSQL is ready."); pool.end(); process.exit(0); })
    .catch(err => { console.error("[!] PostgreSQL unreachable:", err.message); process.exit(1); });
  ' || { echo "[ERROR] Could not connect to PostgreSQL. Aborting."; exit 1; }

  # 3. Start Local Reconciler Daemon
  if [ -f "$RECONCILER_PID_FILE" ] && kill -0 "$(cat "$RECONCILER_PID_FILE")" 2>/dev/null; then
    echo "[+] Local Reconciler already running with PID $(cat "$RECONCILER_PID_FILE")."
  else
    echo "[*] Starting Local Reconciler Daemon..."
    NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" NODE_ENV=production node "$BASE_DIR/local-reconciler.js" >> "$BASE_DIR/reconciler.log" 2>&1 &
    echo $! > "$RECONCILER_PID_FILE"
    echo "[+] Local Reconciler started with PID $(cat "$RECONCILER_PID_FILE")."
  fi

  # 4. Start Local Trust Gate API Server
  if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
    echo "[+] Local API server already running with PID $(cat "$SERVER_PID_FILE")."
  else
    echo "[*] Starting Local API Server (port 8080)..."
    python3 "$BASE_DIR/serve_local_api.py" >> "$BASE_DIR/server.log" 2>&1 &
    echo $! > "$SERVER_PID_FILE"
    echo "[+] Local API Server started with PID $(cat "$SERVER_PID_FILE")."
  fi

  echo "=== [VELQIRIS] All Services Successfully Started ==="
}

cmd_stop() {
  echo "=== [VELQIRIS] Graceful Shutdown Initiated ==="

  if [ -f "$RECONCILER_PID_FILE" ]; then
    PID="$(cat "$RECONCILER_PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      echo "[*] Terminating Local Reconciler (PID: $PID)..."
      kill -TERM "$PID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$RECONCILER_PID_FILE"
  fi

  if [ -f "$SERVER_PID_FILE" ]; then
    PID="$(cat "$SERVER_PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      echo "[*] Terminating Local API Server (PID: $PID)..."
      kill -TERM "$PID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$SERVER_PID_FILE"
  fi

  echo "[+] VELQIRIS local daemons stopped. (Docker container retained for data persistence)."
}

cmd_health() {
  echo "=== [VELQIRIS] Health Status Check ==="

  # PostgreSQL Check
  PG_STATUS="UNHEALTHY"
  if NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" node -e '
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db" });
    pool.query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = \x27public\x27")
      .then(r => { console.log("[+] PostgreSQL: HEALTHY (" + r.rows[0].count + " tables verified)"); pool.end(); })
      .catch(e => { console.error("[!] PostgreSQL: UNHEALTHY (" + e.message + ")"); process.exit(1); });
  ' 2>/dev/null; then
    PG_STATUS="HEALTHY"
  fi

  # Reconciler Check
  REC_STATUS="STOPPED"
  if [ -f "$RECONCILER_PID_FILE" ] && kill -0 "$(cat "$RECONCILER_PID_FILE")" 2>/dev/null; then
    REC_STATUS="RUNNING (PID: $(cat "$RECONCILER_PID_FILE"))"
  fi
  echo "[+] Local Reconciler: $REC_STATUS"

  # API Server Check
  SRV_STATUS="STOPPED"
  if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
    SRV_STATUS="RUNNING (PID: $(cat "$SERVER_PID_FILE"))"
  fi
  echo "[+] Local API Server: $SRV_STATUS"
}

cmd_test() {
  echo "=== [VELQIRIS] Executing Essential Verification Tests ==="
  NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" node "$BASE_DIR/scripts/audit_test_suite.js"
}

case "$1" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  health) cmd_health ;;
  test)   cmd_test ;;
  *)
    echo "Usage: $0 {start|stop|health|test}"
    exit 1
    ;;
esac
