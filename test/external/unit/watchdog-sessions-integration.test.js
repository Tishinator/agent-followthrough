'use strict';

/**
 * External review tests: watchdog integration with session-type tasks (Phase 2).
 *
 * The agent's watchdog.test.js covers the basic session stale/unknown/aborted
 * paths in isolation. This file covers integration scenarios:
 *
 *   - Mixed marker + session tasks in a single watchdog cycle
 *   - Session task notification content includes session context
 *   - Resolved session task is excluded from subsequent cycles
 *   - Notification suppression still applies to session tasks
 *   - Emitter failure on a session task is recorded correctly
 *   - runWatchdog result objects include correct fields for session tasks
 *
 * Depends on: src/watchdog.js exports { runWatchdog }
 *             runWatchdog(db, { sessionsPath }) — second arg is options
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDb, insertTask, getTask, getTaskEvents } = require('../../../src/db');
const { runWatchdog } = require('../../../src/watchdog');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb() {
  const p = path.join(os.tmpdir(), `ext-wd-sess-${process.pid}-${Date.now()}.db`);
  const conn = openDb(p);
  conn._testPath = p;
  return conn;
}

function cleanupDb(conn) {
  conn.close();
  const p = conn._testPath;
  [p, `${p}-wal`, `${p}-shm`].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
}

function writeSessionsFile(content, suffix = '') {
  const p = path.join(os.tmpdir(), `ext-sess-${process.pid}-${Date.now()}${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

function writeMarker(p, status) {
  fs.writeFileSync(p, JSON.stringify({ status }));
}

function stubEmitter(outcome = { success: true, exitCode: 0, output: 'stubbed' }) {
  const mod = require('../../../src/emitter');
  const orig = mod.sendNotification;
  mod.sendNotification = () => outcome;
  return () => { mod.sendNotification = orig; };
}

function captureEmitter() {
  const calls = [];
  const mod = require('../../../src/emitter');
  const orig = mod.sendNotification;
  mod.sendNotification = (target, msg) => {
    calls.push({ target, msg });
    return { success: true, exitCode: 0, output: 'ok' };
  };
  return { calls, restore: () => { mod.sendNotification = orig; } };
}

const FRESH_MS = Date.now() - 2_000;

// ─── Mixed marker + session cycle ─────────────────────────────────────────────

test('watchdog: marker task and session task processed in same cycle', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const markerPath = path.join(os.tmpdir(), `ext-mix-marker-${Date.now()}.json`);
  const sessUuid = 'mix-session-uuid-0001';
  const sessPath = writeSessionsFile({
    'agent:main:mix': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'mix');

  try {
    writeMarker(markerPath, 'running');
    insertTask(db, { id: 'mix-marker', title: 'Marker Task', notify_target: 'telegram:1', observable_type: 'marker', observable_id: markerPath });
    insertTask(db, { id: 'mix-session', title: 'Session Task', notify_target: 'telegram:2', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    const results = runWatchdog(db, { sessionsPath: sessPath });

    assert.equal(results.length, 2);
    const byId = Object.fromEntries(results.map(r => [r.taskId, r]));
    assert.equal(byId['mix-marker'].observedStatus, 'running');
    assert.equal(byId['mix-session'].observedStatus, 'running');
  } finally {
    cleanupDb(db);
    restore();
    [markerPath, sessPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  }
});

test('watchdog: marker completed + session absent in same cycle', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const markerPath = path.join(os.tmpdir(), `ext-mix2-marker-${Date.now()}.json`);
  const sessUuid = 'mix2-session-uuid-0002';
  // Session NOT in the store
  const sessPath = writeSessionsFile({ 'other': { sessionId: 'unrelated', updatedAt: FRESH_MS, abortedLastRun: false } }, 'mix2');

  try {
    writeMarker(markerPath, 'completed');
    insertTask(db, { id: 'mix2-marker', title: 'Completed Marker', notify_target: 'telegram:1', observable_type: 'marker', observable_id: markerPath });
    insertTask(db, { id: 'mix2-session', title: 'Absent Session', notify_target: 'telegram:2', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    const results = runWatchdog(db, { sessionsPath: sessPath });

    const byId = Object.fromEntries(results.map(r => [r.taskId, r]));
    assert.equal(byId['mix2-marker'].observedStatus, 'completed');
    assert.equal(byId['mix2-session'].observedStatus, 'stale');

    // Marker task resolved, session task still active
    const marker = getTask(db, 'mix2-marker');
    const session = getTask(db, 'mix2-session');
    assert.equal(marker.resolution_status, 'completed');
    assert.equal(session.resolution_status, null);
  } finally {
    cleanupDb(db);
    restore();
    [markerPath, sessPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  }
});

// ─── Resolved session excluded from next cycle ────────────────────────────────

test('watchdog: resolved session task is excluded from subsequent cycles', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessUuid = 'resolved-session-uuid-0003';
  const sessPath = writeSessionsFile({
    'k': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: true } // aborted → failed
  }, 'resolved-excl');

  try {
    insertTask(db, { id: 'sess-excl-1', title: 'Excl Session', notify_target: 'telegram:1', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    // Cycle 1: aborted → resolved as failed
    const results1 = runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(results1[0].observedStatus, 'failed');
    assert.equal(getTask(db, 'sess-excl-1').resolution_status, 'failed');

    // Cycle 2: task should not appear in results (it is resolved)
    const results2 = runWatchdog(db, { sessionsPath: sessPath });
    const found = results2.find(r => r.taskId === 'sess-excl-1');
    assert.equal(found, undefined, 'resolved task should not be processed in subsequent cycle');
  } finally {
    cleanupDb(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

// ─── Notification suppression for session tasks ───────────────────────────────

test('watchdog: notification suppressed within interval for session task', () => {
  const { calls, restore } = captureEmitter();
  const db = makeDb();
  const sessUuid = 'supp-session-uuid-0004';
  const sessPath = writeSessionsFile({
    'k': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'supp');

  try {
    insertTask(db, { id: 'sess-supp-1', title: 'Suppressed Session', notify_target: 'telegram:1', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    // Cycle 1: notifies
    runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(calls.length, 1, 'should notify on first cycle');

    // Cycle 2 (immediate): suppressed
    runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(calls.length, 1, 'should suppress notification within interval');
  } finally {
    cleanupDb(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

// ─── Emitter failure on session task ─────────────────────────────────────────

test('watchdog: emitter failure on session task recorded without crashing', () => {
  const restore = stubEmitter({ success: false, exitCode: 1, output: 'timeout' });
  const db = makeDb();
  const sessUuid = 'emit-fail-session-uuid-0005';
  const sessPath = writeSessionsFile({
    'k': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'emitfail');

  try {
    insertTask(db, { id: 'sess-emitfail-1', title: 'Emit Fail Session', notify_target: 'telegram:1', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    const results = runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(results[0].emitSuccess, false);

    const t = getTask(db, 'sess-emitfail-1');
    assert.equal(t.last_notification_status, 'failed');

    const events = getTaskEvents(db, 'sess-emitfail-1');
    const notifEvent = events.find(e => e.event_type === 'notification');
    assert.ok(notifEvent, 'notification event should be recorded');
    assert.ok(notifEvent.message.includes('failed'), 'notification event should record failure');
  } finally {
    cleanupDb(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

// ─── Result object shape for session tasks ────────────────────────────────────

test('watchdog result: session task result has correct shape', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessUuid = 'shape-session-uuid-0006';
  const sessPath = writeSessionsFile({
    'k': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'shape');

  try {
    insertTask(db, { id: 'sess-shape-1', title: 'Shape Test', notify_target: 'telegram:1', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    const results = runWatchdog(db, { sessionsPath: sessPath });
    assert.equal(results.length, 1);
    const r = results[0];

    assert.ok('taskId' in r, 'result should have taskId');
    assert.ok('observedStatus' in r, 'result should have observedStatus');
    assert.ok('notified' in r, 'result should have notified');
    assert.equal(r.taskId, 'sess-shape-1');
    assert.equal(typeof r.notified, 'boolean');
  } finally {
    cleanupDb(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});

// ─── Session event log ────────────────────────────────────────────────────────

test('watchdog: session task cycle writes observation event to task_events', () => {
  const restore = stubEmitter();
  const db = makeDb();
  const sessUuid = 'events-session-uuid-0007';
  const sessPath = writeSessionsFile({
    'k': { sessionId: sessUuid, updatedAt: FRESH_MS, abortedLastRun: false }
  }, 'events');

  try {
    insertTask(db, { id: 'sess-events-1', title: 'Events Session', notify_target: 'telegram:1', observable_type: 'session', observable_id: sessUuid, checkin_every_minutes: 3 });

    runWatchdog(db, { sessionsPath: sessPath });

    const events = getTaskEvents(db, 'sess-events-1');
    assert.ok(events.length >= 1, 'should have at least one event after watchdog cycle');
    const types = events.map(e => e.event_type);
    assert.ok(
      types.includes('observation') || types.includes('notification') || types.includes('resolution'),
      `events should include observation, notification, or resolution — got: ${types.join(', ')}`
    );
  } finally {
    cleanupDb(db);
    restore();
    if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath);
  }
});
