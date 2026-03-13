'use strict';

/**
 * Session observer — deterministic, no LLM.
 *
 * Reads ~/.openclaw/agents/main/sessions/sessions.json and finds
 * the entry matching a given session UUID (task.observable_id).
 *
 * Observation logic:
 *   1. File absent or unreadable         → unknown_signal
 *   2. Entry not found by sessionId/key  → unknown_signal
 *   3. entry.abortedLastRun === true      → failed
 *   4. entry.updatedAt absent            → unknown_signal
 *   5. age < interval * STALE_FACTOR     → running
 *   6. otherwise                         → unknown_signal (feeds stale/unknown cycle)
 *
 * Limitations (documented):
 *   - No completed state: sessions.json has no completion signal; use CLI resolve.
 *   - abortedLastRun is the only failure signal available here.
 *   - A long tool call keeps updatedAt stale even when work is in progress.
 *   - Session eviction (entry absent) is treated as unknown_signal, not error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SESSIONS_PATH = path.join(
  os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json'
);

/** Multiple of checkin interval before a session is considered stale */
const STALE_FACTOR = 3;

/**
 * Inspect a session-backed task.
 *
 * @param {object} task - task row from DB (needs observable_id, checkin_every_minutes)
 * @param {object} [opts]
 * @param {string} [opts.sessionsPath] - override path to sessions.json (for tests)
 * @param {number} [opts.now]          - override Date.now() (for tests)
 * @returns {{ status: 'running'|'failed'|'unknown_signal', reason?: string, updatedAt?: number }}
 */
function inspectSession(task, opts = {}) {
  const sessionsPath = opts.sessionsPath || DEFAULT_SESSIONS_PATH;
  const nowMs = opts.now !== undefined ? opts.now : Date.now();

  let raw;
  try {
    raw = fs.readFileSync(sessionsPath, 'utf8');
  } catch (err) {
    return { status: 'unknown_signal', reason: `sessions.json not readable: ${err.code || err.message}` };
  }

  let sessions;
  try {
    sessions = JSON.parse(raw);
  } catch (err) {
    return { status: 'unknown_signal', reason: `sessions.json parse error: ${err.message}` };
  }

  const targetId = task.observable_id;
  let entry = null;

  // UUID match: look for entry where entry.sessionId === targetId
  for (const val of Object.values(sessions)) {
    if (val && typeof val === 'object' && val.sessionId === targetId) {
      entry = val;
      break;
    }
  }

  // Key match fallback: observable_id is the sessions.json map key itself
  if (!entry && sessions[targetId] && typeof sessions[targetId] === 'object') {
    entry = sessions[targetId];
  }

  if (!entry) {
    return { status: 'unknown_signal', reason: `session not found: ${targetId}` };
  }

  if (entry.abortedLastRun === true) {
    return { status: 'failed', reason: 'abortedLastRun=true; session was aborted' };
  }

  if (typeof entry.updatedAt !== 'number') {
    return { status: 'unknown_signal', reason: 'entry.updatedAt missing or not a number' };
  }

  const ageMs = nowMs - entry.updatedAt;
  const intervalMs = (task.checkin_every_minutes || 3) * 60 * 1000;
  const staleThresholdMs = intervalMs * STALE_FACTOR;

  if (ageMs < staleThresholdMs) {
    return {
      status: 'running',
      updatedAt: entry.updatedAt,
      reason: `session active: updated ${Math.round(ageMs / 1000)}s ago`
    };
  }

  return {
    status: 'unknown_signal',
    reason: `no update for ${Math.round(ageMs / 1000)}s (threshold: ${Math.round(staleThresholdMs / 1000)}s)`
  };
}

module.exports = { inspectSession, STALE_FACTOR, DEFAULT_SESSIONS_PATH };
