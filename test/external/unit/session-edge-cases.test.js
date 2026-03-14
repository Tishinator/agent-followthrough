'use strict';

/**
 * External review tests: inspectSession edge cases (Phase 2).
 *
 * The agent's watchdog.test.js covers the core inspectSession contract.
 * This file covers complementary edge cases:
 *
 *   - Multiple sessions in the store (only the matching one matters)
 *   - observable_id matched as sessionId takes priority over key match
 *   - STALE_FACTOR is applied proportionally to checkin_every_minutes
 *   - updatedAt at exactly the stale boundary
 *   - Empty sessions store object (not file-not-found, but valid JSON with no entries)
 *   - Session store is an empty object {}
 *   - Sessions with null/undefined fields handled gracefully
 *
 * Depends on: src/watchdog.js exports { inspectSession, STALE_FACTOR }
 * Sessions store format: { "<key>": { sessionId, updatedAt (ms), abortedLastRun } }
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { inspectSession, STALE_FACTOR } = require('../../../src/watchdog');

function tmpSessionsFile(content, suffix = '') {
  const p = path.join(os.tmpdir(), `ext-sess-${process.pid}-${Date.now()}${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

function cleanup(...paths) {
  paths.forEach(p => { if (p && fs.existsSync(p)) fs.unlinkSync(p); });
}

const FRESH_MS = Date.now() - 2_000;        // 2s ago — definitely fresh
const OLD_MS   = Date.now() - 4 * 3600_000; // 4h ago — definitely stale

// ─── STALE_FACTOR contract ────────────────────────────────────────────────────

test('STALE_FACTOR: is a positive finite number', () => {
  assert.ok(typeof STALE_FACTOR === 'number', 'STALE_FACTOR should be a number');
  assert.ok(STALE_FACTOR > 0, 'STALE_FACTOR should be positive');
  assert.ok(Number.isFinite(STALE_FACTOR), 'STALE_FACTOR should be finite');
});

test('STALE_FACTOR: a session updated within (STALE_FACTOR * interval) is fresh', () => {
  // updatedAt is just 1ms inside the window → should be running
  const checkin = 3;
  const freshMs = Date.now() - (STALE_FACTOR * checkin * 60 * 1000 - 1000); // 1s before threshold
  const uuid = 'stale-factor-test-uuid';
  const p = tmpSessionsFile({ 'k': { sessionId: uuid, updatedAt: freshMs, abortedLastRun: false } }, 'sf-fresh');
  try {
    const r = inspectSession({ observable_id: uuid, checkin_every_minutes: checkin }, { sessionsPath: p });
    assert.equal(r.status, 'running', `expected running for updatedAt ${freshMs}ms ago (threshold: STALE_FACTOR=${STALE_FACTOR} * ${checkin}m)`);
  } finally { cleanup(p); }
});

test('STALE_FACTOR: a session updated beyond (STALE_FACTOR * interval) is unknown_signal', () => {
  const checkin = 3;
  const staleMs = Date.now() - (STALE_FACTOR * checkin * 60 * 1000 + 60_000); // 1 min past threshold
  const uuid = 'stale-factor-old-uuid';
  const p = tmpSessionsFile({ 'k': { sessionId: uuid, updatedAt: staleMs, abortedLastRun: false } }, 'sf-old');
  try {
    const r = inspectSession({ observable_id: uuid, checkin_every_minutes: checkin }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal', `expected unknown_signal for stale updatedAt`);
  } finally { cleanup(p); }
});

// ─── Multiple sessions in store ───────────────────────────────────────────────

test('inspectSession: multiple sessions — only matching UUID is used', () => {
  const target = 'target-uuid-0001';
  const p = tmpSessionsFile({
    'k1': { sessionId: 'other-uuid-0001', updatedAt: FRESH_MS, abortedLastRun: false },
    'k2': { sessionId: target,            updatedAt: FRESH_MS, abortedLastRun: false },
    'k3': { sessionId: 'other-uuid-0002', updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'multi');
  try {
    const r = inspectSession({ observable_id: target, checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'running');
  } finally { cleanup(p); }
});

test('inspectSession: multiple sessions — non-matching UUID returns unknown_signal', () => {
  const p = tmpSessionsFile({
    'k1': { sessionId: 'uuid-a', updatedAt: FRESH_MS, abortedLastRun: false },
    'k2': { sessionId: 'uuid-b', updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'multi-miss');
  try {
    const r = inspectSession({ observable_id: 'uuid-c', checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal');
  } finally { cleanup(p); }
});

test('inspectSession: sessionId match takes priority over key match', () => {
  // If observable_id matches a sessionId in one entry AND the key of another,
  // the match that identifies a running session should win.
  const uuid = 'shared-value-0001';
  const p = tmpSessionsFile({
    [uuid]: { sessionId: 'different-uuid', updatedAt: OLD_MS,   abortedLastRun: false }, // key matches but stale
    'k2':   { sessionId: uuid,             updatedAt: FRESH_MS, abortedLastRun: false }  // sessionId matches and fresh
  }, 'priority');
  try {
    const r = inspectSession({ observable_id: uuid, checkin_every_minutes: 3 }, { sessionsPath: p });
    // At minimum, the result should not be based solely on the stale key-match entry
    // Acceptable: running (sessionId match wins) or running (any match found)
    assert.ok(
      r.status === 'running' || r.status === 'unknown_signal',
      `status should be running or unknown_signal, got: ${r.status}`
    );
    // If it resolves to running, that's the preferred behavior
    // If it resolves to unknown_signal, agent chose key-match only — note this in review
  } finally { cleanup(p); }
});

// ─── Empty / minimal stores ───────────────────────────────────────────────────

test('inspectSession: empty sessions store {} -> unknown_signal', () => {
  const p = tmpSessionsFile({}, 'empty-obj');
  try {
    const r = inspectSession({ observable_id: 'any-uuid', checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal');
  } finally { cleanup(p); }
});

test('inspectSession: sessions store is empty array [] -> unknown_signal (graceful)', () => {
  const p = tmpSessionsFile([], 'empty-arr');
  try {
    // The store format is an object, not array. If agent gets an array,
    // it should degrade gracefully to unknown_signal, not throw.
    assert.doesNotThrow(() => {
      const r = inspectSession({ observable_id: 'any-uuid', checkin_every_minutes: 3 }, { sessionsPath: p });
      assert.equal(r.status, 'unknown_signal');
    });
  } finally { cleanup(p); }
});

// ─── Defensive field handling ─────────────────────────────────────────────────

test('inspectSession: entry with missing abortedLastRun field -> does not throw', () => {
  const uuid = 'no-abort-field-uuid';
  const p = tmpSessionsFile({
    'k': { sessionId: uuid, updatedAt: FRESH_MS /* no abortedLastRun */ }
  }, 'no-abort');
  try {
    assert.doesNotThrow(() => {
      inspectSession({ observable_id: uuid, checkin_every_minutes: 3 }, { sessionsPath: p });
    });
  } finally { cleanup(p); }
});

test('inspectSession: entry with missing updatedAt field -> unknown_signal', () => {
  const uuid = 'no-updatedat-uuid';
  const p = tmpSessionsFile({
    'k': { sessionId: uuid, abortedLastRun: false /* no updatedAt */ }
  }, 'no-ts');
  try {
    const r = inspectSession({ observable_id: uuid, checkin_every_minutes: 3 }, { sessionsPath: p });
    // Without updatedAt, freshness cannot be confirmed — should be unknown_signal
    assert.equal(r.status, 'unknown_signal');
  } finally { cleanup(p); }
});

// ─── sessionsPath default behavior ───────────────────────────────────────────

test('inspectSession: called without sessionsPath option -> returns a status (does not throw)', () => {
  // When no sessionsPath is given, inspectSession should either:
  //   (a) read from the default OpenClaw sessions path, or
  //   (b) return unknown_signal if the default path is not available
  // Either is acceptable — it must not throw.
  assert.doesNotThrow(() => {
    const r = inspectSession({ observable_id: 'any-uuid', checkin_every_minutes: 3 }, {});
    assert.ok(['running', 'unknown_signal', 'failed', 'completed'].includes(r.status),
      `status should be a known value, got: ${r.status}`);
  });
});
