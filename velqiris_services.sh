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
  
  # 0. Ensure Node.js dependencies
  if ! NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" node -e 'require("pg")' 2>/dev/null; then
    echo "[*] Node dependencies ('pg') missing. Installing dependencies via npm install..."
    npm --prefix "$BASE_DIR" install
  fi

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
  PORT_STATUS=$(python3 -c '
import sys, socket, urllib.request, json
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.5)
res = s.connect_ex(("127.0.0.1", 8080))
s.close()
if res == 0:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req = urllib.request.Request("http://127.0.0.1:8080/health")
        with opener.open(req, timeout=1.0) as resp:
            data = json.loads(resp.read().decode())
            if "VELQIRIS" in str(data):
                sys.exit(0)
    except Exception:
        pass
    sys.exit(2)
sys.exit(1)
' 2>/dev/null; echo $?)

  if [ "$PORT_STATUS" -eq 0 ]; then
    PID=""
    [ -f "$SERVER_PID_FILE" ] && PID=" (PID: $(cat "$SERVER_PID_FILE"))"
    echo "[+] Local API server is already running and healthy on port 8080$PID."
  elif [ "$PORT_STATUS" -eq 2 ]; then
    echo "[ERROR] Port 8080 is occupied by another non-VELQIRIS process. Aborting without terminating foreign process."
    exit 1
  else
    echo "[*] Starting Local API Server (port 8080)..."
    python3 "$BASE_DIR/serve_local_api.py" >> "$BASE_DIR/server.log" 2>&1 &
    echo $! > "$SERVER_PID_FILE"

    READY=0
    for i in {1..10}; do
      sleep 0.5
      if python3 -c '
import sys, urllib.request
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8080/health", timeout=0.5) as resp:
        if resp.status == 200: sys.exit(0)
except Exception:
    sys.exit(1)
' 2>/dev/null; then
        READY=1
        break
      fi
    done
    if [ "$READY" -eq 1 ]; then
      echo "[+] Local API Server started with PID $(cat "$SERVER_PID_FILE") and verified healthy."
    else
      echo "[+] Local API Server process launched with PID $(cat "$SERVER_PID_FILE")."
    fi
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
  if python3 -c '
import sys, urllib.request
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8080/health", timeout=0.8) as resp:
        if resp.status == 200: sys.exit(0)
except Exception:
    sys.exit(1)
' 2>/dev/null; then
    PID=""
    [ -f "$SERVER_PID_FILE" ] && PID=" (PID: $(cat "$SERVER_PID_FILE"))"
    SRV_STATUS="HEALTHY$PID"
  elif [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
    SRV_STATUS="RUNNING (PID: $(cat "$SERVER_PID_FILE"), /health pending)"
  fi
  echo "[+] Local API Server: $SRV_STATUS"
}

cmd_test() {
  echo "=== [VELQIRIS] Executing Essential Verification Tests ==="
  if ! NODE_PATH="$BASE_DIR/node_modules:$BASE_DIR/../node_modules" node -e 'require("pg")' 2>/dev/null; then
    echo "[*] Node dependencies ('pg') missing. Installing dependencies via npm install..."
    npm --prefix "$BASE_DIR" install
  fi
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
