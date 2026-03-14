'use strict';

/**
 * External review tests: src/sessions.js (Phase 2b).
 *
 * sessions.js is a dedicated module extracted from watchdog.js in Phase 2b.
 * The existing watchdog.test.js imports inspectSession via watchdog.js re-export
 * and covers the main cases. This file focuses on what is NEW or distinct in
 * sessions.js itself:
 *
 *   - DEFAULT_SESSIONS_PATH points to the actual OpenClaw sessions location
 *   - STALE_FACTOR is exactly 3
 *   - opts.now allows deterministic time injection (not tested in watchdog.test.js)
 *   - Exact staleness boundary: at threshold-1ms is running, at threshold+1ms is unknown_signal
 *   - reason strings contain specific text for each failure mode
 *   - updatedAt is returned in the result when session is running
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { inspectSession, STALE_FACTOR, DEFAULT_SESSIONS_PATH } = require('../../../src/sessions');

function tmpStore(content, suffix = '') {
  const p = path.join(os.tmpdir(), `ext-sess-mod-${process.pid}-${Date.now()}${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

function cleanup(...paths) {
  paths.forEach(p => { if (p && fs.existsSync(p)) fs.unlinkSync(p); });
}

// ─── Module-level constants ───────────────────────────────────────────────────

test('STALE_FACTOR is exactly 3', () => {
  assert.equal(STALE_FACTOR, 3);
});

test('DEFAULT_SESSIONS_PATH points to the OpenClaw main agent sessions file', () => {
  const expected = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  assert.equal(DEFAULT_SESSIONS_PATH, expected);
});

// ─── opts.now time injection ──────────────────────────────────────────────────

test('opts.now: session fresh relative to injected now → running', () => {
  const checkin = 3;
  const fixedNow = 1_000_000_000_000; // arbitrary fixed timestamp
  const freshUpdatedAt = fixedNow - 10_000; // 10s ago, well within 3 * 3min = 9min window
  const uuid = 'now-inject-fresh-uuid';
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: freshUpdatedAt, abortedLastRun: false } }, 'now-fresh');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: checkin },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'running');
    assert.equal(r.updatedAt, freshUpdatedAt);
  } finally { cleanup(p); }
});

test('opts.now: session stale relative to injected now → unknown_signal', () => {
  const checkin = 3;
  const fixedNow = 1_000_000_000_000;
  const staleThresholdMs = STALE_FACTOR * checkin * 60 * 1000; // 9 minutes in ms
  const staleUpdatedAt = fixedNow - staleThresholdMs - 1000; // 1s past threshold
  const uuid = 'now-inject-stale-uuid';
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: staleUpdatedAt, abortedLastRun: false } }, 'now-stale');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: checkin },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'unknown_signal');
  } finally { cleanup(p); }
});

test('opts.now: session at exactly threshold boundary - 1ms → running', () => {
  const checkin = 3;
  const fixedNow = 1_000_000_000_000;
  const thresholdMs = STALE_FACTOR * checkin * 60 * 1000;
  const justInsideMs = fixedNow - (thresholdMs - 1); // 1ms before going stale
  const uuid = 'boundary-fresh-uuid';
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: justInsideMs, abortedLastRun: false } }, 'boundary-fresh');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: checkin },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'running', 'should be running at exactly threshold - 1ms');
  } finally { cleanup(p); }
});

test('opts.now: session at exactly threshold boundary + 1ms → unknown_signal', () => {
  const checkin = 3;
  const fixedNow = 1_000_000_000_000;
  const thresholdMs = STALE_FACTOR * checkin * 60 * 1000;
  const justOutsideMs = fixedNow - (thresholdMs + 1); // 1ms after going stale
  const uuid = 'boundary-stale-uuid';
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: justOutsideMs, abortedLastRun: false } }, 'boundary-stale');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: checkin },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'unknown_signal', 'should be unknown_signal at exactly threshold + 1ms');
  } finally { cleanup(p); }
});

test('opts.now: threshold scales with checkin_every_minutes', () => {
  // With checkin=1, threshold = STALE_FACTOR * 1 * 60s = 3 minutes
  // With checkin=10, threshold = STALE_FACTOR * 10 * 60s = 30 minutes
  const fixedNow = 1_000_000_000_000;
  const uuid = 'scale-test-uuid';

  // 5 minutes ago — fresh for checkin=10, stale for checkin=1
  const fiveMinAgo = fixedNow - (5 * 60 * 1000);
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: fiveMinAgo, abortedLastRun: false } }, 'scale');
  try {
    const r1 = inspectSession(
      { observable_id: uuid, checkin_every_minutes: 1 },
      { sessionsPath: p, now: fixedNow }
    );
    const r10 = inspectSession(
      { observable_id: uuid, checkin_every_minutes: 10 },
      { sessionsPath: p, now: fixedNow }
    );

    assert.equal(r1.status, 'unknown_signal', '5min ago is stale for checkin=1 (threshold=3min)');
    assert.equal(r10.status, 'running', '5min ago is fresh for checkin=10 (threshold=30min)');
  } finally { cleanup(p); }
});

// ─── reason string content ────────────────────────────────────────────────────

test('reason: file not readable contains ENOENT or readable', () => {
  const r = inspectSession(
    { observable_id: 'any', checkin_every_minutes: 3 },
    { sessionsPath: '/tmp/does-not-exist-ext-sessions-test.json' }
  );
  assert.equal(r.status, 'unknown_signal');
  assert.ok(r.reason, 'reason should be present');
  assert.match(r.reason, /ENOENT|readable|read/i);
});

test('reason: parse error contains "parse"', () => {
  const p = path.join(os.tmpdir(), `ext-sess-parse-err-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, 'not-valid-json{{{'); // raw write, bypasses JSON.stringify
  try {
    const r = inspectSession({ observable_id: 'any', checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal');
    assert.match(r.reason, /parse/i);
  } finally { cleanup(p); }
});

test('reason: session not found contains the observable_id', () => {
  const p = tmpStore({}, 'not-found-reason');
  try {
    const r = inspectSession({ observable_id: 'my-missing-uuid', checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal');
    assert.ok(r.reason.includes('my-missing-uuid'), `reason should include the uuid: ${r.reason}`);
  } finally { cleanup(p); }
});

test('reason: abortedLastRun contains "abort"', () => {
  const uuid = 'aborted-reason-uuid';
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: Date.now(), abortedLastRun: true } }, 'abort-reason');
  try {
    const r = inspectSession({ observable_id: uuid, checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /abort/i);
  } finally { cleanup(p); }
});

test('reason: stale session contains age and threshold info', () => {
  const fixedNow = 1_000_000_000_000;
  const uuid = 'stale-reason-uuid';
  const staleUpdatedAt = fixedNow - (STALE_FACTOR * 3 * 60 * 1000 + 60_000);
  const p = tmpStore({ k: { sessionId: uuid, updatedAt: staleUpdatedAt, abortedLastRun: false } }, 'stale-reason');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: 3 },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'unknown_signal');
    assert.ok(r.reason, 'reason should be present for stale session');
    // reason should mention time info (seconds)
    assert.match(r.reason, /\d+s/);
  } finally { cleanup(p); }
});

// ─── updatedAt in result ──────────────────────────────────────────────────────

test('result includes updatedAt when session is running', () => {
  const fixedNow = 1_000_000_000_000;
  const uuid = 'updatedat-result-uuid';
  const updatedAt = fixedNow - 5000;
  const p = tmpStore({ k: { sessionId: uuid, updatedAt, abortedLastRun: false } }, 'updatedat-result');
  try {
    const r = inspectSession(
      { observable_id: uuid, checkin_every_minutes: 3 },
      { sessionsPath: p, now: fixedNow }
    );
    assert.equal(r.status, 'running');
    assert.equal(r.updatedAt, updatedAt);
  } finally { cleanup(p); }
});

test('result does not include updatedAt when session is not running', () => {
  const p = tmpStore({}, 'no-updatedat');
  try {
    const r = inspectSession({ observable_id: 'missing', checkin_every_minutes: 3 }, { sessionsPath: p });
    assert.equal(r.status, 'unknown_signal');
    assert.equal(r.updatedAt, undefined);
  } finally { cleanup(p); }
});
