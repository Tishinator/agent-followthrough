#!/usr/bin/env bash
# =============================================================================
# Agent Follow-Up — End-to-End Validation Script
# =============================================================================
# Covers V&V Rev3 exit criteria that require a live OpenClaw environment:
#
#   - Emitter path proven using the documented OpenClaw command
#   - OpenClaw cron path proven as the scheduler
#   - Full registration -> watchdog -> notification flow
#   - Restart persistence (task survives OpenClaw gateway restart)
#
# Prerequisites:
#   - OpenClaw gateway is running (openclaw gateway status)
#   - Telegram plugin is enabled and configured
#   - agent-follow-up CLI is installed (npm install in project root)
#
# Usage:
#   cd ~/projects/agent-follow-up
#   bash test/e2e.sh [--skip-restart] [--skip-cron]
#
# All evidence is written to test/e2e-proof/ for the proof package.
# =============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_DIR="$PROJECT_DIR/test/e2e-proof"
DB_PATH="$PROJECT_DIR/data/tasks.db"
CLI="$PROJECT_DIR/src/cli.js"
WATCHDOG="$PROJECT_DIR/src/watchdog.js"
TELEGRAM_TARGET="telegram:8625301893"
SKIP_RESTART=false
SKIP_CRON=false

for arg in "$@"; do
  [[ "$arg" == "--skip-restart" ]] && SKIP_RESTART=true
  [[ "$arg" == "--skip-cron" ]] && SKIP_CRON=true
done

mkdir -p "$PROOF_DIR"

PASS=0
FAIL=0

# ─── helpers ─────────────────────────────────────────────────────────────────

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log() { echo "[$(ts)] $*"; }

pass() {
  log "  PASS: $1"
  echo "PASS: $1" >> "$PROOF_DIR/results.txt"
  (( PASS++ )) || true
}

fail() {
  log "  FAIL: $1"
  echo "FAIL: $1" >> "$PROOF_DIR/results.txt"
  (( FAIL++ )) || true
}

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    log "ERROR: '$1' not found. Cannot run e2e tests."
    exit 1
  fi
}

# ─── preflight ────────────────────────────────────────────────────────────────

log "=== Agent Follow-Up E2E Validation ==="
log "Proof directory: $PROOF_DIR"
echo "# E2E Proof Package — $(ts)" > "$PROOF_DIR/results.txt"
echo "" >> "$PROOF_DIR/results.txt"

require_cmd openclaw
require_cmd node
require_cmd sqlite3

log "Checking OpenClaw gateway status..."
if ! openclaw gateway status &>/dev/null; then
  log "ERROR: OpenClaw gateway is not running. Start it with: openclaw gateway run"
  exit 1
fi
openclaw gateway status > "$PROOF_DIR/gateway-status.txt" 2>&1
log "Gateway running. Evidence: e2e-proof/gateway-status.txt"

# ─── T1: Emitter path ─────────────────────────────────────────────────────────

log ""
log "=== T1: Emitter path — openclaw message send ==="

EMITTER_MSG="[Agent Follow-Up E2E] Emitter path validation test — $(ts)"
if openclaw message send \
    --channel telegram \
    --target 8625301893 \
    --message "$EMITTER_MSG" \
    > "$PROOF_DIR/t1-emitter-output.txt" 2>&1; then
  pass "T1: openclaw message send succeeded"
  echo "Command: openclaw message send --channel telegram --target 8625301893 --message '...'" >> "$PROOF_DIR/t1-emitter-output.txt"
else
  fail "T1: openclaw message send failed (exit $?)"
  cat "$PROOF_DIR/t1-emitter-output.txt"
fi

# ─── T2: Registration + watchdog + completion flow ────────────────────────────

log ""
log "=== T2: Registration -> watchdog -> completion flow ==="

TASK_ID="e2e-completion-$(date +%s)"
MARKER_PATH="/tmp/${TASK_ID}.marker.json"

# Write running marker
echo '{"status":"running"}' > "$MARKER_PATH"

# Register task
node "$CLI" register \
  --id "$TASK_ID" \
  --title "E2E Completion Test" \
  --target "$TELEGRAM_TARGET" \
  --observable-type marker \
  --observable-id "$MARKER_PATH" \
  --interval 3 \
  --db "$DB_PATH" \
  > "$PROOF_DIR/t2-register-output.txt" 2>&1

if sqlite3 "$DB_PATH" "SELECT id FROM tasks WHERE id='$TASK_ID'" | grep -q "$TASK_ID"; then
  pass "T2a: task registered in SQLite"
else
  fail "T2a: task not found in SQLite after registration"
fi

# Snapshot registered state
sqlite3 "$DB_PATH" "SELECT * FROM tasks WHERE id='$TASK_ID'" > "$PROOF_DIR/t2-db-after-register.txt"

# Run watchdog (first cycle, marker=running)
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t2-watchdog-cycle1.txt" 2>&1 || true

CYCLE1_STATUS=$(sqlite3 "$DB_PATH" "SELECT last_observed_status FROM tasks WHERE id='$TASK_ID'")
if [[ "$CYCLE1_STATUS" == "running" ]]; then
  pass "T2b: watchdog observed running status"
else
  fail "T2b: expected running, got '$CYCLE1_STATUS'"
fi

# Check notification was sent
NOTIF_STATUS=$(sqlite3 "$DB_PATH" "SELECT last_notification_status FROM tasks WHERE id='$TASK_ID'")
if [[ "$NOTIF_STATUS" == "sent" ]]; then
  pass "T2c: first notification sent after initial watchdog cycle"
else
  fail "T2c: notification not sent (status='$NOTIF_STATUS')"
fi

# Mark task completed via marker file
echo '{"status":"completed","exitCode":0,"updatedAt":"'"$(ts)"'"}' > "$MARKER_PATH"

# Run watchdog again — should detect completion
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t2-watchdog-cycle2-completion.txt" 2>&1 || true

RESOLUTION=$(sqlite3 "$DB_PATH" "SELECT resolution_status FROM tasks WHERE id='$TASK_ID'")
if [[ "$RESOLUTION" == "completed" ]]; then
  pass "T2d: watchdog detected completion and set resolution_status=completed"
else
  fail "T2d: expected resolution_status=completed, got '$RESOLUTION'"
fi

sqlite3 "$DB_PATH" "SELECT * FROM tasks WHERE id='$TASK_ID'" > "$PROOF_DIR/t2-db-after-completion.txt"
sqlite3 "$DB_PATH" "SELECT * FROM task_events WHERE task_id='$TASK_ID'" > "$PROOF_DIR/t2-events.txt"

rm -f "$MARKER_PATH"

# ─── T3: Failure flow ─────────────────────────────────────────────────────────

log ""
log "=== T3: Failure flow ==="

TASK_ID_F="e2e-failure-$(date +%s)"
MARKER_PATH_F="/tmp/${TASK_ID_F}.marker.json"
echo '{"status":"running"}' > "$MARKER_PATH_F"

node "$CLI" register \
  --id "$TASK_ID_F" \
  --title "E2E Failure Test" \
  --target "$TELEGRAM_TARGET" \
  --observable-type marker \
  --observable-id "$MARKER_PATH_F" \
  --interval 3 \
  --db "$DB_PATH" \
  > "$PROOF_DIR/t3-register.txt" 2>&1

echo '{"status":"failed","exitCode":1,"updatedAt":"'"$(ts)"'"}' > "$MARKER_PATH_F"

node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t3-watchdog-failure.txt" 2>&1 || true

FAIL_RESOLUTION=$(sqlite3 "$DB_PATH" "SELECT resolution_status FROM tasks WHERE id='$TASK_ID_F'")
if [[ "$FAIL_RESOLUTION" == "failed" ]]; then
  pass "T3a: watchdog detected failure and set resolution_status=failed"
else
  fail "T3a: expected failed, got '$FAIL_RESOLUTION'"
fi

sqlite3 "$DB_PATH" "SELECT * FROM task_events WHERE task_id='$TASK_ID_F'" > "$PROOF_DIR/t3-events.txt"
rm -f "$MARKER_PATH_F"

# ─── T4: Unknown threshold (N=2) ──────────────────────────────────────────────

log ""
log "=== T4: Unknown threshold at N=2 cycles ==="

TASK_ID_U="e2e-unknown-$(date +%s)"
MISSING_MARKER="/tmp/no-such-marker-${TASK_ID_U}.json"

node "$CLI" register \
  --id "$TASK_ID_U" \
  --title "E2E Unknown Test" \
  --target "$TELEGRAM_TARGET" \
  --observable-type marker \
  --observable-id "$MISSING_MARKER" \
  --interval 3 \
  --db "$DB_PATH" \
  > "$PROOF_DIR/t4-register.txt" 2>&1

# Cycle 1 — expect stale
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t4-watchdog-cycle1.txt" 2>&1 || true
CYCLE1_U=$(sqlite3 "$DB_PATH" "SELECT last_observed_status, unknown_cycle_count FROM tasks WHERE id='$TASK_ID_U'")
if echo "$CYCLE1_U" | grep -q "stale"; then
  pass "T4a: cycle 1 produces stale status"
else
  fail "T4a: expected stale after cycle 1, got: $CYCLE1_U"
fi

# Cycle 2 — expect unknown
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t4-watchdog-cycle2.txt" 2>&1 || true
CYCLE2_U=$(sqlite3 "$DB_PATH" "SELECT last_observed_status, unknown_cycle_count FROM tasks WHERE id='$TASK_ID_U'")
if echo "$CYCLE2_U" | grep -q "unknown"; then
  pass "T4b: cycle 2 transitions to unknown (threshold N=2 honored)"
else
  fail "T4b: expected unknown after cycle 2, got: $CYCLE2_U"
fi

sqlite3 "$DB_PATH" "SELECT * FROM task_events WHERE task_id='$TASK_ID_U'" > "$PROOF_DIR/t4-events.txt"

# ─── T5: Duplicate notification suppression ───────────────────────────────────

log ""
log "=== T5: Duplicate notification suppression ==="

TASK_ID_S="e2e-suppress-$(date +%s)"
MARKER_PATH_S="/tmp/${TASK_ID_S}.marker.json"
echo '{"status":"running"}' > "$MARKER_PATH_S"

node "$CLI" register \
  --id "$TASK_ID_S" \
  --title "E2E Suppression Test" \
  --target "$TELEGRAM_TARGET" \
  --observable-type marker \
  --observable-id "$MARKER_PATH_S" \
  --interval 3 \
  --db "$DB_PATH" \
  > "$PROOF_DIR/t5-register.txt" 2>&1

# Cycle 1 — should notify
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t5-watchdog-cycle1.txt" 2>&1 || true

NOTIF_COUNT_1=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM task_events WHERE task_id='$TASK_ID_S' AND event_type='notification'")

# Cycle 2 immediately — should NOT send another notification (within interval)
node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t5-watchdog-cycle2.txt" 2>&1 || true

NOTIF_COUNT_2=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM task_events WHERE task_id='$TASK_ID_S' AND event_type='notification'")

if [[ "$NOTIF_COUNT_1" == "1" && "$NOTIF_COUNT_2" == "1" ]]; then
  pass "T5: duplicate notification suppressed (1 notification after 2 immediate cycles)"
else
  fail "T5: expected 1 notification, got $NOTIF_COUNT_1 after cycle 1 and $NOTIF_COUNT_2 after cycle 2"
fi

sqlite3 "$DB_PATH" "SELECT * FROM task_events WHERE task_id='$TASK_ID_S'" > "$PROOF_DIR/t5-events.txt"
rm -f "$MARKER_PATH_S"

# ─── T6: Restart persistence ─────────────────────────────────────────────────

if [[ "$SKIP_RESTART" == "true" ]]; then
  log ""
  log "=== T6: Restart persistence (SKIPPED via --skip-restart) ==="
else
  log ""
  log "=== T6: Restart persistence ==="

  TASK_ID_R="e2e-restart-$(date +%s)"
  MARKER_PATH_R="/tmp/${TASK_ID_R}.marker.json"
  echo '{"status":"running"}' > "$MARKER_PATH_R"

  node "$CLI" register \
    --id "$TASK_ID_R" \
    --title "E2E Restart Test" \
    --target "$TELEGRAM_TARGET" \
    --observable-type marker \
    --observable-id "$MARKER_PATH_R" \
    --interval 3 \
    --db "$DB_PATH" \
    > "$PROOF_DIR/t6-register-before-restart.txt" 2>&1

  DB_BEFORE=$(sqlite3 "$DB_PATH" "SELECT id, resolution_status FROM tasks WHERE id='$TASK_ID_R'")

  log "Restarting OpenClaw gateway..."
  openclaw gateway restart > "$PROOF_DIR/t6-gateway-restart.txt" 2>&1
  sleep 3

  # Verify task still in DB after restart
  if sqlite3 "$DB_PATH" "SELECT id FROM tasks WHERE id='$TASK_ID_R'" | grep -q "$TASK_ID_R"; then
    pass "T6a: task persisted in SQLite after gateway restart"
  else
    fail "T6a: task missing from SQLite after restart"
  fi

  # Run watchdog after restart — should still process the task
  node "$WATCHDOG" --db "$DB_PATH" > "$PROOF_DIR/t6-watchdog-after-restart.txt" 2>&1 || true

  POST_RESTART_STATUS=$(sqlite3 "$DB_PATH" "SELECT last_observed_status FROM tasks WHERE id='$TASK_ID_R'")
  if [[ "$POST_RESTART_STATUS" == "running" ]]; then
    pass "T6b: watchdog processed task normally after restart"
  else
    fail "T6b: unexpected status after restart: '$POST_RESTART_STATUS'"
  fi

  sqlite3 "$DB_PATH" "SELECT * FROM tasks WHERE id='$TASK_ID_R'" > "$PROOF_DIR/t6-db-after-restart.txt"
  rm -f "$MARKER_PATH_R"
fi

# ─── T7: OpenClaw native cron scheduler ───────────────────────────────────────

if [[ "$SKIP_CRON" == "true" ]]; then
  log ""
  log "=== T7: OpenClaw native cron scheduler (SKIPPED via --skip-cron) ==="
else
  log ""
  log "=== T7: OpenClaw native cron scheduler ==="

  CRON_JOB_NAME="agent-follow-up-e2e-watchdog-$(date +%s)"

  # Register the watchdog as an OpenClaw cron job (non-LLM exec path)
  openclaw cron add \
    --name "$CRON_JOB_NAME" \
    --every 3m \
    --session isolated \
    --message "Run agent-follow-up watchdog: node $WATCHDOG" \
    > "$PROOF_DIR/t7-cron-add.txt" 2>&1

  JOB_ID=$(openclaw cron list --json 2>/dev/null | \
    node -e "const j=require('fs').readFileSync('/dev/stdin','utf8'); const jobs=JSON.parse(j); const job=jobs.find(x=>x.name==='$CRON_JOB_NAME'); console.log(job ? job.jobId : '');" 2>/dev/null || echo "")

  if [[ -n "$JOB_ID" ]]; then
    pass "T7a: cron job registered in OpenClaw (jobId=$JOB_ID)"
    echo "jobId: $JOB_ID" >> "$PROOF_DIR/t7-cron-add.txt"
  else
    fail "T7a: cron job not found in openclaw cron list after add"
  fi

  # Trigger immediately and capture run log
  if [[ -n "$JOB_ID" ]]; then
    openclaw cron run "$JOB_ID" > "$PROOF_DIR/t7-cron-run.txt" 2>&1 || true
    sleep 2
    openclaw cron runs --id "$JOB_ID" > "$PROOF_DIR/t7-cron-run-log.txt" 2>&1 || true

    if [[ -s "$PROOF_DIR/t7-cron-run-log.txt" ]]; then
      pass "T7b: cron run log exists and is non-empty"
    else
      fail "T7b: cron run log empty or missing"
    fi

    # Clean up the test cron job
    openclaw cron rm "$JOB_ID" > /dev/null 2>&1 || true
  fi
fi

# ─── T8: CLI negative cases ────────────────────────────────────────────────────

log ""
log "=== T8: CLI negative cases ==="

# Duplicate registration
TASK_DUP="e2e-dup-$(date +%s)"
MARKER_DUP="/tmp/${TASK_DUP}.marker.json"
echo '{"status":"running"}' > "$MARKER_DUP"

node "$CLI" register \
  --id "$TASK_DUP" --title "Dup" --target "$TELEGRAM_TARGET" \
  --observable-type marker --observable-id "$MARKER_DUP" \
  --db "$DB_PATH" > /dev/null 2>&1

if node "$CLI" register \
  --id "$TASK_DUP" --title "Dup" --target "$TELEGRAM_TARGET" \
  --observable-type marker --observable-id "$MARKER_DUP" \
  --db "$DB_PATH" > "$PROOF_DIR/t8-dup-output.txt" 2>&1; then
  fail "T8a: duplicate registration should have exited non-zero"
else
  pass "T8a: duplicate registration rejected"
fi

# Resolve non-existent task
if node "$CLI" resolve \
  --id "ghost-task-e2e-$(date +%s)" --status completed \
  --db "$DB_PATH" > "$PROOF_DIR/t8-resolve-ghost.txt" 2>&1; then
  fail "T8b: resolving ghost task should have exited non-zero"
else
  pass "T8b: resolving non-existent task rejected"
fi

rm -f "$MARKER_DUP"

# ─── Results ──────────────────────────────────────────────────────────────────

log ""
log "=== Results ==="
log "PASS: $PASS"
log "FAIL: $FAIL"
log "Proof artifacts written to: $PROOF_DIR"

echo "" >> "$PROOF_DIR/results.txt"
echo "Total PASS: $PASS" >> "$PROOF_DIR/results.txt"
echo "Total FAIL: $FAIL" >> "$PROOF_DIR/results.txt"
echo "Run at: $(ts)" >> "$PROOF_DIR/results.txt"

# List proof artifacts
echo "" >> "$PROOF_DIR/results.txt"
echo "Artifacts:" >> "$PROOF_DIR/results.txt"
ls "$PROOF_DIR" >> "$PROOF_DIR/results.txt"

if [[ $FAIL -gt 0 ]]; then
  log "Some tests FAILED. Check $PROOF_DIR for details."
  exit 1
else
  log "All tests PASSED."
  exit 0
fi
