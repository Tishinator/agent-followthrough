'use strict';

/**
 * Unit tests for src/sessions.js inspectSession().
 *
 * All tests use fixture data written to a temp directory — no real
 * ~/.openclaw/agents/main/sessions/sessions.json is read.
 *
 * Observed vs inferred:
 *   - OBSERVED: sessions.json structure from ~/.openclaw/agents/main/sessions/sessions.json
 *     contains keys like "agent:main:main" with sessionId, updatedAt (epoch ms), abortedLastRun.
 *   - OBSERVED: abortedLastRun=false in live artifact; failure path tested via fixture.
 *   - INFERRED: STALE_FACTOR=3 is a design choice; not directly derived from observed artifact.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inspectSession, STALE_FACTOR } = require('../src/sessions');

const BASE_TASK = {
  observable_id: 'test-uuid-1111',
  checkin_every_minutes: 3,
};

function tmpSessions(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-sess-'));
  const p = path.join(dir, 'sessions.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

// ─── file-level failures ──────────────────────────────────────────────────────

test('sessions.json absent → unknown_signal with readable/read reason', () => {
  const result = inspectSession(BASE_TASK, {
    sessionsPath: '/tmp/no-such-afu-test-xyzzy.json',
  });
  assert.equal(result.status, 'unknown_signal');
  // reason must be diagnosable as a read/access error
  assert.ok(result.reason, 'reason should be set');
});

test('sessions.json invalid JSON → unknown_signal with parse reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-sess-'));
  const p = path.join(dir, 'sessions.json');
  fs.writeFileSync(p, 'not-valid-json{{{');

  const result = inspectSession(BASE_TASK, { sessionsPath: p });
  assert.equal(result.status, 'unknown_signal');
  assert.match(result.reason, /parse/i);
});

// ─── entry lookup ─────────────────────────────────────────────────────────────

test('session UUID not found → unknown_signal with not found reason', () => {
  const nowMs = Date.now();
  const p = tmpSessions({
    'agent:main:other': { sessionId: 'different-uuid', updatedAt: nowMs, abortedLastRun: false },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'unknown_signal');
  assert.match(result.reason, /not found/i);
});

test('lookup by sessionId value → running when fresh', () => {
  const nowMs = Date.now();
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',  // matches BASE_TASK.observable_id
      updatedAt: nowMs - 60_000,    // 1m ago; threshold=9m for interval=3
      abortedLastRun: false,
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'running');
});

test('lookup by key (observable_id = sessions.json key) → running when fresh', () => {
  const nowMs = Date.now();
  const task = { ...BASE_TASK, observable_id: 'agent:main:main' };
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'some-other-uuid',
      updatedAt: nowMs - 60_000,
      abortedLastRun: false,
    },
  });
  const result = inspectSession(task, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'running');
});

// ─── abortedLastRun ───────────────────────────────────────────────────────────

test('abortedLastRun=true → failed with abort in reason', () => {
  const nowMs = Date.now();
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',
      updatedAt: nowMs - 60_000,
      abortedLastRun: true,
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /abort/i);
});

test('abortedLastRun=false → not failed', () => {
  const nowMs = Date.now();
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',
      updatedAt: nowMs - 60_000,
      abortedLastRun: false,
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.notEqual(result.status, 'failed');
});

// ─── updatedAt freshness ──────────────────────────────────────────────────────

test('updatedAt missing → unknown_signal', () => {
  const nowMs = Date.now();
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',
      abortedLastRun: false,
      // no updatedAt
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'unknown_signal');
  assert.match(result.reason, /updatedAt/i);
});

test('updatedAt stale → unknown_signal with no update reason', () => {
  const nowMs = Date.now();
  const staleAge = (BASE_TASK.checkin_every_minutes * STALE_FACTOR * 60 * 1000) + 60_000;
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',
      updatedAt: nowMs - staleAge,
      abortedLastRun: false,
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'unknown_signal');
  assert.match(result.reason, /no update/i);
});

test('running result includes updatedAt timestamp', () => {
  const nowMs = Date.now();
  const updatedAt = nowMs - 30_000;
  const p = tmpSessions({
    'agent:main:main': {
      sessionId: 'test-uuid-1111',
      updatedAt,
      abortedLastRun: false,
    },
  });
  const result = inspectSession(BASE_TASK, { sessionsPath: p, now: nowMs });
  assert.equal(result.status, 'running');
  assert.equal(result.updatedAt, updatedAt);
});

test('STALE_FACTOR is 3', () => {
  assert.equal(STALE_FACTOR, 3);
});
