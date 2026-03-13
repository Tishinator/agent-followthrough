'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { openDb, insertTask, getTask, getTaskEvents } = require('../src/db');
const { runWatchdog, inspectMarker, inspectSession, notificationDue, UNKNOWN_THRESHOLD, STALE_FACTOR } = require('../src/watchdog');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb() {
  const dbPath = path.join(os.tmpdir(), `wdtest-${process.pid}-${Date.now()}.db`);
  const db = openDb(dbPath);
  db._testPath = dbPath;
  return db;
}

function cleanup(db) {
  db.close();
  const p = db._testPath;
  if (fs.existsSync(p)) fs.unlinkSync(p);
  ['wal', 'shm'].forEach(ext => {
    const f = `${p}-${ext}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

function writeMarker(markerPath, status) {
  fs.writeFileSync(markerPath, JSON.stringify({ status }));
}

function mkTmpMarker(suffix = '') {
  return path.join(os.tmpdir(), `test-marker-${process.pid}-${Date.now()}${suffix}.json`);
}

/**
 * Stub sendNotification to avoid real network calls.
 * Returns a restore function.
 */
function stubEmitter(outcome = { success: true, exitCode: 0, output: 'stubbed' }) {
  const emitterModule = require('../src/emitter');
  const orig = emitterModule.sendNotification;
  emitterModule.sendNotification = () => outcome;
  return () => { emitterModule.sendNotification = orig; };
}

// ─── inspectMarker ────────────────────────────────────────────────────────────

test('inspectMarker: absent file -> unknown_signal', () => {
  const r = inspectMarker({ observable_id: '/tmp/does-not-exist-ever.json' });
  assert.equal(r.status, 'unknown_signal');
});

test('inspectMarker: marker.status=running -> running', () => {
  const p = mkTmpMarker('a');
  writeMarker(p, 'running');
  const r = inspectMarker({ observable_id: p });
  assert.equal(r.status, 'running');
  fs.unlinkSync(p);
});

test('inspectMarker: marker.status=completed -> completed', () => {
  const p = mkTmpMarker('b');
  writeMarker(p, 'completed');
  const r = inspectMarker({ observable_id: p });
  assert.equal(r.status, 'completed');
  fs.unlinkSync(p);
});

test('inspectMarker: marker.status=failed -> failed', () => {
  const p = mkTmpMarker('c');
  writeMarker(p, 'failed');
  const r = inspectMarker({ observable_id: p });
  assert.equal(r.status, 'failed');
  fs.unlinkSync(p);
});

test('inspectMarker: invalid JSON -> unknown_signal', () => {
  const p = mkTmpMarker('d');
  fs.writeFileSync(p, 'not-json');
  const r = inspectMarker({ observable_id: p });
  assert.equal(r.status, 'unknown_signal');
  fs.unlinkSync(p);
});

// ─── notificationDue ─────────────────────────────────────────────────────────

test('notificationDue: no prior notification -> true', () => {
  const task = { last_notification_sent_at: null, checkin_every_minutes: 3 };
  assert.equal(notificationDue(task, 'running'), true);
});

test('notificationDue: recent notification -> false', () => {
  const task = {
    last_notification_sent_at: new Date().toISOString(),
    checkin_every_minutes: 3
  };
  assert.equal(notificationDue(task, 'running'), false);
});

test('notificationDue: old notification -> true', () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m ago
  const task = { last_notification_sent_at: old, checkin_every_minutes: 3 };
  assert.equal(notificationDue(task, 'running'), true);
});

// ─── UNKNOWN_THRESHOLD constant ───────────────────────────────────────────────

test('UNKNOWN_THRESHOLD is 2', () => {
  assert.equal(UNKNOWN_THRESHOLD, 2);
});

// ─── runWatchdog: running marker ─────────────────────────────────────────────

test('watchdog marks task running when marker says running', () => {
  const restore = stubEmitter();
  const db = makeDb();
  try {
    const markerPath = mkTmpMarker('run');
    writeMarker(markerPath, 'running');
    insertTask(db, {
      id: 'wd-run-1',
      title: 'Running Task',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: markerPath
    });

    const results = runWatchdog(db);
    assert.equal(results.length, 1);
    assert.equal(results[0].observedStatus, 'running');
    assert.equal(results[0].notified, true); // first run, no prior notification

    const t = getTask(db, 'wd-run-1');
    assert.equal(t.last_observed_status, 'running');
    assert.equal(t.unknown_cycle_count, 0);
    assert.ok(t.last_notification_sent_at);

    fs.unlinkSync(markerPath);
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── runWatchdog: completed marker ────────────────────────────────────────────

test('watchdog resolves task as completed when marker says completed', () => {
  const restore = stubEmitter();
  const db = makeDb();
  try {
    const markerPath = mkTmpMarker('comp');
    writeMarker(markerPath, 'completed');
    insertTask(db, {
      id: 'wd-comp-1',
      title: 'Completed Task',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: markerPath
    });

    const results = runWatchdog(db);
    assert.equal(results[0].observedStatus, 'completed');
    assert.equal(results[0].notified, true);

    const t = getTask(db, 'wd-comp-1');
    assert.equal(t.resolution_status, 'completed');
    assert.ok(t.resolution_at);

    // Task no longer active
    const active = db.prepare("SELECT * FROM tasks WHERE resolution_status IS NULL").all();
    assert.ok(!active.find(x => x.id === 'wd-comp-1'));

    fs.unlinkSync(markerPath);
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── runWatchdog: failed marker ───────────────────────────────────────────────

test('watchdog resolves task as failed when marker says failed', () => {
  const restore = stubEmitter();
  const db = makeDb();
  try {
    const markerPath = mkTmpMarker('fail');
    writeMarker(markerPath, 'failed');
    insertTask(db, {
      id: 'wd-fail-1',
      title: 'Failed Task',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: markerPath
    });

    const results = runWatchdog(db);
    assert.equal(results[0].observedStatus, 'failed');
    assert.equal(results[0].notified, true);

    const t = getTask(db, 'wd-fail-1');
    assert.equal(t.resolution_status, 'failed');

    fs.unlinkSync(markerPath);
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── runWatchdog: unknown threshold ──────────────────────────────────────────

test('watchdog transitions to unknown after 2 missing-marker cycles', () => {
  const restore = stubEmitter();
  const db = makeDb();
  try {
    // Marker does not exist
    insertTask(db, {
      id: 'wd-unknown-1',
      title: 'Unknown Task',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: '/tmp/no-such-file-xyzzy.json'
    });

    // Cycle 1 -> stale (count=1, below threshold)
    runWatchdog(db);
    let t = getTask(db, 'wd-unknown-1');
    assert.equal(t.unknown_cycle_count, 1);
    assert.equal(t.last_observed_status, 'stale');

    // Cycle 2 -> unknown (count=2, at threshold)
    runWatchdog(db);
    t = getTask(db, 'wd-unknown-1');
    assert.equal(t.unknown_cycle_count, 2);
    assert.equal(t.last_observed_status, 'unknown');
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── runWatchdog: notification suppression ───────────────────────────────────

test('watchdog suppresses repeat notification within interval', () => {
  const calls = [];
  const emitterModule = require('../src/emitter');
  const orig = emitterModule.sendNotification;
  emitterModule.sendNotification = (target, msg) => {
    calls.push({ target, msg });
    return { success: true, exitCode: 0, output: 'ok' };
  };

  const db = makeDb();
  try {
    const markerPath = mkTmpMarker('supp');
    writeMarker(markerPath, 'running');
    insertTask(db, {
      id: 'wd-supp-1',
      title: 'Suppression Test',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: markerPath,
      checkin_every_minutes: 3
    });

    // First cycle: should notify
    runWatchdog(db);
    assert.equal(calls.length, 1);

    // Second immediate cycle: should NOT notify (within interval)
    runWatchdog(db);
    assert.equal(calls.length, 1); // still 1

    fs.unlinkSync(markerPath);
  } finally {
    cleanup(db);
    emitterModule.sendNotification = orig;
  }
});

// ─── runWatchdog: emitter failure recorded ───────────────────────────────────

test('watchdog records emitter failure without crashing', () => {
  const restore = stubEmitter({ success: false, exitCode: 1, output: 'connection refused' });
  const db = makeDb();
  try {
    const markerPath = mkTmpMarker('emitfail');
    writeMarker(markerPath, 'running');
    insertTask(db, {
      id: 'wd-emitfail-1',
      title: 'Emitter Fail Test',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: markerPath
    });

    const results = runWatchdog(db);
    assert.equal(results[0].emitSuccess, false);

    const t = getTask(db, 'wd-emitfail-1');
    assert.equal(t.last_notification_status, 'failed');

    // No false success claim in events
    const events = getTaskEvents(db, 'wd-emitfail-1');
    const notifEvent = events.find(e => e.event_type === 'notification');
    assert.ok(notifEvent.message.includes('failed'));

    fs.unlinkSync(markerPath);
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── runWatchdog: multiple tasks ─────────────────────────────────────────────

test('watchdog processes multiple tasks in one cycle', () => {
  const restore = stubEmitter();
  const db = makeDb();
  try {
    const m1 = mkTmpMarker('m1');
    const m2 = mkTmpMarker('m2');
    writeMarker(m1, 'running');
    writeMarker(m2, 'completed');

    insertTask(db, { id: 'multi-1', title: 'A', notify_target: 'telegram:1', observable_type: 'marker', observable_id: m1 });
    insertTask(db, { id: 'multi-2', title: 'B', notify_target: 'telegram:2', observable_type: 'marker', observable_id: m2 });

    const results = runWatchdog(db);
    assert.equal(results.length, 2);
    const statusMap = Object.fromEntries(results.map(r => [r.taskId, r.observedStatus]));
    assert.equal(statusMap['multi-1'], 'running');
    assert.equal(statusMap['multi-2'], 'completed');

    [m1, m2].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  } finally {
    cleanup(db);
    restore();
  }
});

// ─── inspectSession ───────────────────────────────────────────────────────────

function writeSessionStore(p, sessions) {
  fs.writeFileSync(p, JSON.stringify(sessions));
}

function mkTmpSessions(suffix = '') {
  return path.join(os.tmpdir(), `test-sessions-${process.pid}-${Date.now()}${suffix}.json`);
}

const FRESH_UPDATED_AT = Date.now() - 5 * 1000; // 5s ago — very recent
const OLD_UPDATED_AT   = Date.now() - 60 * 60 * 1000; // 1h ago — definitely stale

test('STALE_FACTOR is exported as a positive number', () => {
  assert.ok(typeof STALE_FACTOR === 'number' && STALE_FACTOR > 0);
});

test('inspectSession: sessions.json not readable -> unknown_signal', () => {
  const r = inspectSession(
    { observable_id: 'uuid-x', checkin_every_minutes: 3 },
    { sessionsPath: '/tmp/no-such-sessions-file-xyzzy.json' }
  );
  assert.equal(r.status, 'unknown_signal');
  assert.match(r.reason, /readable|read/i);
});

test('inspectSession: sessions.json malformed JSON -> unknown_signal', () => {
  const p = mkTmpSessions('bad');
  fs.writeFileSync(p, 'not-valid-json{{{');
  const r = inspectSession(
    { observable_id: 'uuid-x', checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'unknown_signal');
  assert.match(r.reason, /parse/i);
  fs.unlinkSync(p);
});

test('inspectSession: session UUID absent from store -> unknown_signal', () => {
  const p = mkTmpSessions('absent');
  writeSessionStore(p, {
    'agent:main:other': { sessionId: 'aaaa-bbbb', updatedAt: FRESH_UPDATED_AT, abortedLastRun: false }
  });
  const r = inspectSession(
    { observable_id: 'uuid-that-does-not-exist', checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'unknown_signal');
  assert.match(r.reason, /not found/i);
  fs.unlinkSync(p);
});

test('inspectSession: session UUID present, fresh updatedAt, no abort -> running', () => {
  const p = mkTmpSessions('running');
  const uuid = 'c989e785-a605-45ed-8348-f447f3ad13e9';
  writeSessionStore(p, {
    'agent:main:telegram': { sessionId: uuid, updatedAt: FRESH_UPDATED_AT, abortedLastRun: false }
  });
  const r = inspectSession(
    { observable_id: uuid, checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'running');
  assert.ok(r.updatedAt);
  fs.unlinkSync(p);
});

test('inspectSession: session UUID present, old updatedAt, no abort -> unknown_signal', () => {
  const p = mkTmpSessions('stale');
  const uuid = 'dead-beef-0000-0000-0000-000000000000';
  writeSessionStore(p, {
    'agent:main:old': { sessionId: uuid, updatedAt: OLD_UPDATED_AT, abortedLastRun: false }
  });
  const r = inspectSession(
    { observable_id: uuid, checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'unknown_signal');
  assert.match(r.reason, /no update/i);
  fs.unlinkSync(p);
});

test('inspectSession: abortedLastRun=true -> failed (even if fresh)', () => {
  const p = mkTmpSessions('aborted');
  const uuid = 'aborted-uuid-0000-0000-0000-0000000000';
  writeSessionStore(p, {
    'agent:main:aborted': { sessionId: uuid, updatedAt: FRESH_UPDATED_AT, abortedLastRun: true }
  });
  const r = inspectSession(
    { observable_id: uuid, checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /abort/i);
  fs.unlinkSync(p);
});

test('inspectSession: session key match (not UUID) -> running', () => {
  const p = mkTmpSessions('keyMatch');
  const key = 'agent:main:cron:abc-123';
  writeSessionStore(p, {
    [key]: { sessionId: 'some-other-uuid', updatedAt: FRESH_UPDATED_AT, abortedLastRun: false }
  });
  // observable_id is the key, not the UUID
  const r = inspectSession(
    { observable_id: key, checkin_every_minutes: 3 },
    { sessionsPath: p }
  );
  assert.equal(r.status, 'running');
  fs.unlinkSync(p);
});

// ─── runWatchdog: session type integration ────────────────────────────────────

test('watchdog observes session task as running when session is fresh', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessPath = mkTmpSessions('wd-run');
  const uuid = 'session-running-uuid-0001';
  try {
    writeSessionStore(sessPath, {
      'agent:main:test': { sessionId: uuid, updatedAt: Date.now() - 1000, abortedLastRun: false }
    });
    insertTask(db, {
      id: 'sess-run-1', title: 'Session Running Task',
      notify_target: 'telegram:999',
      observable_type: 'session',
      observable_id: uuid,
      checkin_every_minutes: 3
    });

    const results = runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(results.length, 1);
    assert.equal(results[0].observedStatus, 'running');

    const t = getTask(db, 'sess-run-1');
    assert.equal(t.last_observed_status, 'running');
    assert.equal(t.unknown_cycle_count, 0);
  } finally {
    cleanup(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

test('watchdog resolves session task as failed when abortedLastRun=true', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessPath = mkTmpSessions('wd-abort');
  const uuid = 'session-aborted-uuid-0002';
  try {
    writeSessionStore(sessPath, {
      'agent:main:aborted': { sessionId: uuid, updatedAt: Date.now() - 1000, abortedLastRun: true }
    });
    insertTask(db, {
      id: 'sess-abort-1', title: 'Session Aborted Task',
      notify_target: 'telegram:999',
      observable_type: 'session',
      observable_id: uuid,
      checkin_every_minutes: 3
    });

    const results = runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(results[0].observedStatus, 'failed');

    const t = getTask(db, 'sess-abort-1');
    assert.equal(t.resolution_status, 'failed');
    assert.ok(t.resolution_at);
  } finally {
    cleanup(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

test('watchdog transitions session task to stale then unknown when session absent', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessPath = mkTmpSessions('wd-absent');
  try {
    // Write a store with no matching session
    writeSessionStore(sessPath, {
      'agent:main:other': { sessionId: 'different-uuid', updatedAt: Date.now(), abortedLastRun: false }
    });
    insertTask(db, {
      id: 'sess-absent-1', title: 'Session Absent Task',
      notify_target: 'telegram:999',
      observable_type: 'session',
      observable_id: 'no-match-uuid',
      checkin_every_minutes: 3
    });

    // Cycle 1 -> stale
    runWatchdog(db, { sessionsPath: sessPath });
    let t = getTask(db, 'sess-absent-1');
    assert.equal(t.unknown_cycle_count, 1);
    assert.equal(t.last_observed_status, 'stale');

    // Cycle 2 -> unknown
    runWatchdog(db, { sessionsPath: sessPath });
    t = getTask(db, 'sess-absent-1');
    assert.equal(t.unknown_cycle_count, 2);
    assert.equal(t.last_observed_status, 'unknown');
  } finally {
    cleanup(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});
