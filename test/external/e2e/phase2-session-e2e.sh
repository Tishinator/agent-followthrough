#!/usr/bin/env bash
# =============================================================================
# Phase 2 End-to-End Validation: Session-Backed Task Observation
#
# Tests the full session observation lifecycle against a live OpenClaw
# environment. Produces proof artifacts in test/external/e2e/proof/.
#
# Prerequisites:
#   - Node.js 22+ and npm install completed
#   - OpenClaw gateway running (openclaw gateway status)
#   - bin/agent-follow-up.js exists
#   - src/watchdog.js supports session observable type
#
# Usage:
#   bash test/external/e2e/phase2-session-e2e.sh [--skip-cron]
#
# Flags:
#   --skip-cron   Skip OpenClaw cron verification (if cron already registered)
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/../../.."

SKIP_CRON=0
for arg in "$@"; do [[ "$arg" == "--skip-cron" ]] && SKIP_CRON=1; done

PROOF_DIR="test/external/e2e/proof"
mkdir -p "$PROOF_DIR"
RESULTS="$PROOF_DIR/results.txt"
DB_PATH="/tmp/phase2-e2e-test-$(date +%s).db"
NODE="node"
BIN="bin/agent-follow-up.js"
PASS=0; FAIL=0

log()  { echo "$*" | tee -a "$RESULTS"; }
pass() { log "  PASS: $*"; ((PASS++)) || true; }
fail() { log "  FAIL: $*"; ((FAIL++)) || true; }
sep()  { log ""; log "────────────────────────────────────────"; log "$*"; }

# ─── Find real OpenClaw sessions path ────────────────────────────────────────
# OpenClaw stores its sessions JSON at ~/.openclaw/data/sessions.json or similar.
# We detect it by looking in known locations.
find_sessions_path() {
  local candidates=(
    "$HOME/.openclaw/data/sessions.json"
    "$HOME/.openclaw/sessions.json"
    "$HOME/.openclaw/sessions/store.json"
    "$HOME/.openclaw/state/sessions.json"
  )
  for p in "${candidates[@]}"; do
    if [[ -f "$p" ]]; then echo "$p"; return 0; fi
  done

  # Last resort: ask openclaw
  if command -v openclaw &>/dev/null; then
    local out; out=$(openclaw sessions --json 2>/dev/null || true)
    if [[ -n "$out" ]]; then
      echo ""  # sessions are live via CLI, not a file
      return 0
    fi
  fi
  echo ""
}

log "Agent Follow-Up — Phase 2 E2E Validation"
log "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Node: $($NODE --version)"
log "DB:   $DB_PATH"
log ""

# ─── T1: Binary and init-db ──────────────────────────────────────────────────
sep "T1: bin/agent-follow-up.js init-db"
if $NODE "$BIN" init-db --db "$DB_PATH" > "$PROOF_DIR/t1-init-db.txt" 2>&1; then
  pass "init-db exits 0"
  if [[ -f "$DB_PATH" ]]; then
    pass "database file created at $DB_PATH"
  else
    fail "database file not found at $DB_PATH"
  fi
else
  fail "init-db failed (exit $?)"
  cat "$PROOF_DIR/t1-init-db.txt"
fi

# ─── T2: Detect the OpenClaw sessions path ────────────────────────────────────
sep "T2: Locate OpenClaw sessions store"
SESSIONS_PATH=$(find_sessions_path)
if [[ -n "$SESSIONS_PATH" ]]; then
  pass "Sessions file found at: $SESSIONS_PATH"
  # Extract one session UUID for use in subsequent tests
  SESSION_UUID=$(python3 -c "
import json, sys
try:
  data = json.load(open('$SESSIONS_PATH'))
  if isinstance(data, dict) and data:
    entry = next(iter(data.values()))
    print(entry.get('sessionId', list(data.keys())[0]))
  else:
    print('')
except:
  print('')
" 2>/dev/null || true)
  if [[ -n "$SESSION_UUID" ]]; then
    pass "Extracted session UUID: $SESSION_UUID"
  else
    log "  NOTE: Sessions store is empty or could not extract UUID (may be normal if no active sessions)"
    SESSION_UUID="no-active-sessions-placeholder"
  fi
  cp "$SESSIONS_PATH" "$PROOF_DIR/t2-sessions-snapshot.json"
else
  log "  NOTE: Could not find sessions file — session observation E2E will be limited"
  log "  Continuing with manual observation tests only"
  SESSIONS_PATH=""
  SESSION_UUID="no-sessions-file"
fi

# ─── T3: Register a session-backed task ───────────────────────────────────────
sep "T3: Register session-backed task"
if [[ "$SESSION_UUID" != "no-active-sessions-placeholder" && "$SESSION_UUID" != "no-sessions-file" ]]; then
  REGISTER_OUT=$($NODE "$BIN" register \
    --db "$DB_PATH" \
    --id "e2e-sess-1" \
    --title "E2E Phase 2 Session Task" \
    --interval 1 \
    --target "telegram:8625301893" \
    --observable-type session \
    --observable-id "$SESSION_UUID" 2>&1 || true)
  echo "$REGISTER_OUT" > "$PROOF_DIR/t3-register-session.txt"
  if echo "$REGISTER_OUT" | grep -q "e2e-sess-1"; then
    pass "session task registered: e2e-sess-1"
  else
    fail "session task registration output missing task id"
    cat "$PROOF_DIR/t3-register-session.txt"
  fi
else
  log "  SKIP: No live session UUID available — registering with placeholder"
  $NODE "$BIN" register \
    --db "$DB_PATH" \
    --id "e2e-sess-1" \
    --title "E2E Phase 2 Session Task (no live session)" \
    --interval 1 \
    --target "telegram:8625301893" \
    --observable-type session \
    --observable-id "placeholder-uuid" > "$PROOF_DIR/t3-register-session.txt" 2>&1 || true
  log "  NOTE: Session task registered with placeholder UUID for structural test"
fi

# ─── T4: Register a marker task (regression check) ────────────────────────────
sep "T4: Marker task registration (Phase 1 regression)"
MARKER="/tmp/e2e-phase2-marker-$(date +%s).json"
echo '{"status":"running","updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$MARKER"

$NODE "$BIN" register \
  --db "$DB_PATH" \
  --id "e2e-marker-1" \
  --title "E2E Phase 2 Marker Task" \
  --interval 1 \
  --target "telegram:8625301893" \
  --observable-type marker \
  --observable-id "$MARKER" > "$PROOF_DIR/t4-register-marker.txt" 2>&1

if grep -q "e2e-marker-1" "$PROOF_DIR/t4-register-marker.txt"; then
  pass "marker task registered: e2e-marker-1"
else
  fail "marker task registration failed"
fi

# ─── T5: Run watchdog with sessions path ──────────────────────────────────────
sep "T5: Watchdog cycle with session + marker tasks"
WATCHDOG_ARGS=(watchdog --db "$DB_PATH")
[[ -n "$SESSIONS_PATH" ]] && WATCHDOG_ARGS+=(--sessions-path "$SESSIONS_PATH")

if $NODE "$BIN" "${WATCHDOG_ARGS[@]}" > "$PROOF_DIR/t5-watchdog-cycle1.txt" 2>&1; then
  pass "watchdog cycle exits 0"
  cat "$PROOF_DIR/t5-watchdog-cycle1.txt"
  if grep -qi "processed\|task" "$PROOF_DIR/t5-watchdog-cycle1.txt"; then
    pass "watchdog output mentions processed tasks"
  else
    fail "watchdog output missing processed task info"
  fi
else
  fail "watchdog exits non-zero (exit $?)"
  cat "$PROOF_DIR/t5-watchdog-cycle1.txt"
fi

# ─── T6: List shows both task types ──────────────────────────────────────────
sep "T6: List shows both task types"
$NODE "$BIN" list --db "$DB_PATH" > "$PROOF_DIR/t6-list.txt" 2>&1
cat "$PROOF_DIR/t6-list.txt"
if grep -q "e2e-marker-1" "$PROOF_DIR/t6-list.txt"; then
  pass "list shows marker task"
else
  fail "list missing marker task"
fi
if grep -q "e2e-sess-1" "$PROOF_DIR/t6-list.txt"; then
  pass "list shows session task"
else
  fail "list missing session task"
fi

# ─── T7: Marker task completes ────────────────────────────────────────────────
sep "T7: Marker completes → watchdog detects"
echo '{"status":"completed","updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$MARKER"

if $NODE "$BIN" "${WATCHDOG_ARGS[@]}" > "$PROOF_DIR/t7-watchdog-cycle2.txt" 2>&1; then
  cat "$PROOF_DIR/t7-watchdog-cycle2.txt"
  MARKER_STATUS=$($NODE -e "
    const db = require('./src/db');
    const t = db.getTask('$DB_PATH', 'e2e-marker-1');
    console.log(t ? t.resolution_status || t.last_observed_status : 'not-found');
  " 2>/dev/null || echo "error")
  if [[ "$MARKER_STATUS" == "completed" ]]; then
    pass "marker task resolved as completed"
  else
    fail "marker task status: $MARKER_STATUS (expected completed)"
  fi
else
  fail "watchdog cycle 2 failed"
fi

# ─── T8: Session task unknown threshold (stale → unknown) ─────────────────────
sep "T8: Session absent → stale → unknown at N=2"
# Register a new session task with a UUID that won't match anything in sessions
$NODE "$BIN" register \
  --db "$DB_PATH" \
  --id "e2e-sess-absent" \
  --title "Absent Session Task" \
  --interval 1 \
  --target "telegram:8625301893" \
  --observable-type session \
  --observable-id "deliberately-absent-uuid-$(date +%s)" > "$PROOF_DIR/t8-register-absent.txt" 2>&1

$NODE "$BIN" "${WATCHDOG_ARGS[@]}" > "$PROOF_DIR/t8-cycle1.txt" 2>&1
STATUS1=$($NODE -e "
  const db = require('./src/db');
  const t = db.getTask('$DB_PATH', 'e2e-sess-absent');
  console.log(t ? t.last_observed_status : 'not-found');
" 2>/dev/null || echo "error")
log "  After cycle 1: status=$STATUS1"

$NODE "$BIN" "${WATCHDOG_ARGS[@]}" > "$PROOF_DIR/t8-cycle2.txt" 2>&1
STATUS2=$($NODE -e "
  const db = require('./src/db');
  const t = db.getTask('$DB_PATH', 'e2e-sess-absent');
  console.log(t ? t.last_observed_status : 'not-found');
" 2>/dev/null || echo "error")
log "  After cycle 2: status=$STATUS2"

if [[ "$STATUS1" == "stale" ]]; then
  pass "cycle 1: session absent → stale"
else
  fail "cycle 1: expected stale, got $STATUS1"
fi
if [[ "$STATUS2" == "unknown" ]]; then
  pass "cycle 2: session absent → unknown (N=2 threshold)"
else
  fail "cycle 2: expected unknown, got $STATUS2"
fi

# ─── T9: Cron registration (optional) ────────────────────────────────────────
if [[ $SKIP_CRON -eq 0 ]]; then
  sep "T9: OpenClaw cron watchdog registration"
  if command -v openclaw &>/dev/null; then
    CRON_OUT=$(openclaw cron list --json 2>/dev/null || echo "[]")
    echo "$CRON_OUT" > "$PROOF_DIR/t9-cron-list.json"
    if echo "$CRON_OUT" | grep -q "agent-follow-up-watchdog"; then
      pass "watchdog cron job already registered"
    else
      log "  NOTE: watchdog cron job not found — Phase 1 cron registration may not have been promoted"
      log "  Run: openclaw cron add --name agent-follow-up-watchdog --every 3m ..."
    fi
  else
    log "  SKIP: openclaw not in PATH"
  fi
else
  sep "T9: OpenClaw cron (skipped via --skip-cron)"
fi

# ─── Cleanup ──────────────────────────────────────────────────────────────────
rm -f "$MARKER" "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm" 2>/dev/null || true

# ─── Summary ──────────────────────────────────────────────────────────────────
sep "SUMMARY"
TOTAL=$((PASS + FAIL))
log "  Passed: $PASS / $TOTAL"
log "  Failed: $FAIL / $TOTAL"
log "  Proof artifacts: $PROOF_DIR/"
log ""

if [[ $FAIL -gt 0 ]]; then
  log "RESULT: FAIL"
  exit 1
else
  log "RESULT: PASS"
  exit 0
fi
