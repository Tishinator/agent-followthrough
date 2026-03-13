'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { openDb, insertTask, getTask, getTaskEvents } = require('../src/db');
const { runWatchdog, inspectMarker, notificationDue, UNKNOWN_THRESHOLD } = require('../src/watchdog');

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
