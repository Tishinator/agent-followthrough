'use strict';

/**
 * External review tests: src/worker.js (updated for Phase 2b failure contract).
 *
 * Breaking changes from original Phase 2b implementation:
 *   - resolveTaskForWorkerSuccess() → resolveTaskForWorkerExit(db, taskId, status, opts)
 *   - runWorkerAndAutoResolve() now ALWAYS auto-resolves (both exit 0 and non-zero)
 *   - result.autoResolved is always true
 *   - result.resolutionStatus indicates 'completed' or 'failed'
 *   - Notification is sent at CLI layer (cli.js), not in worker.js
 *
 * Contract under test (approved product decision):
 *   exit 0  → resolve as completed
 *   non-zero → resolve as failed
 *   both paths → autoResolved: true, resolvedTask present, exit code in event message
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDb, insertTask, getTask, getTaskEvents } = require('../../../src/db');
const { runWorkerAndAutoResolve, resolveTaskForWorkerExit } = require('../../../src/worker');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb() {
  const p = path.join(os.tmpdir(), `ext-worker-${process.pid}-${Date.now()}.db`);
  const db = openDb(p);
  db._testPath = p;
  return db;
}

function cleanupDb(db) {
  db.close();
  const p = db._testPath;
  [p, `${p}-wal`, `${p}-shm`].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
}

function seedTask(db, id = 'worker-task-1') {
  insertTask(db, {
    id,
    title: `Worker Test Task ${id}`,
    notify_target: 'telegram:1',
    observable_type: 'manual',
    observable_id: 'label'
  });
  return id;
}

// ─── resolveTaskForWorkerExit ─────────────────────────────────────────────────

test('resolveTaskForWorkerExit: marks task as completed when status=completed', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-completed-1');
    resolveTaskForWorkerExit(db, 'rte-completed-1', 'completed');
    const task = getTask(db, 'rte-completed-1');
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at);
    assert.equal(task.last_observed_status, 'completed');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: marks task as failed when status=failed', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-failed-1');
    resolveTaskForWorkerExit(db, 'rte-failed-1', 'failed');
    const task = getTask(db, 'rte-failed-1');
    assert.equal(task.resolution_status, 'failed');
    assert.ok(task.resolution_at);
    assert.equal(task.last_observed_status, 'failed');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: returns the updated task row', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-return-1');
    const result = resolveTaskForWorkerExit(db, 'rte-return-1', 'completed');
    assert.ok(result, 'should return updated task');
    assert.equal(result.id, 'rte-return-1');
    assert.equal(result.resolution_status, 'completed');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: inserts a resolved event with provided message', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-event-1');
    resolveTaskForWorkerExit(db, 'rte-event-1', 'failed', { message: 'worker exit 42: npm test' });
    const events = getTaskEvents(db, 'rte-event-1');
    const resolved = events.find(e => e.event_type === 'resolved');
    assert.ok(resolved);
    assert.equal(resolved.observed_status, 'failed');
    assert.ok(resolved.message.includes('worker exit 42'));
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: uses default message when none provided', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-default-msg-1');
    resolveTaskForWorkerExit(db, 'rte-default-msg-1', 'failed');
    const events = getTaskEvents(db, 'rte-default-msg-1');
    const resolved = events.find(e => e.event_type === 'resolved');
    assert.ok(resolved.message, 'should have a non-empty default message');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: throws when task does not exist', () => {
  const db = makeDb();
  try {
    assert.throws(() => resolveTaskForWorkerExit(db, 'ghost-task', 'completed'), /not found/i);
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerExit: throws when task is already resolved', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rte-already-done');
    resolveTaskForWorkerExit(db, 'rte-already-done', 'completed');
    assert.throws(() => resolveTaskForWorkerExit(db, 'rte-already-done', 'failed'), /already resolved/i);
  } finally { cleanupDb(db); }
});

// ─── runWorkerAndAutoResolve: exit 0 ─────────────────────────────────────────

test('runWorkerAndAutoResolve: exit 0 → resolutionStatus=completed, autoResolved=true', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-exit0-1');
    const result = runWorkerAndAutoResolve(db, 'rw-exit0-1', 'true', []);
    assert.equal(result.status, 0);
    assert.equal(result.autoResolved, true);
    assert.equal(result.resolutionStatus, 'completed');
    assert.ok(result.resolvedTask);
    assert.equal(getTask(db, 'rw-exit0-1').resolution_status, 'completed');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit 0 event message mentions worker exit 0', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-exit0-msg');
    runWorkerAndAutoResolve(db, 'rw-exit0-msg', 'true', []);
    const events = getTaskEvents(db, 'rw-exit0-msg');
    const resolved = events.find(e => e.event_type === 'resolved');
    assert.ok(resolved);
    assert.match(resolved.message, /worker exit 0/i);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit 0 captures stdout in result', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-stdout-1');
    const result = runWorkerAndAutoResolve(db, 'rw-stdout-1', 'sh', ['-c', 'echo hello-output']);
    assert.ok(result.stdout.includes('hello-output'));
    assert.equal(result.resolutionStatus, 'completed');
  } finally { cleanupDb(db); }
});

// ─── runWorkerAndAutoResolve: non-zero exit ───────────────────────────────────

test('runWorkerAndAutoResolve: non-zero exit → resolutionStatus=failed, autoResolved=true', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-fail-1');
    const result = runWorkerAndAutoResolve(db, 'rw-fail-1', 'false', []);
    assert.equal(result.status, 1);
    assert.equal(result.autoResolved, true);
    assert.equal(result.resolutionStatus, 'failed');
    assert.ok(result.resolvedTask);
    assert.equal(getTask(db, 'rw-fail-1').resolution_status, 'failed');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: non-zero exit → task has resolution_at set', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-fail-2');
    runWorkerAndAutoResolve(db, 'rw-fail-2', 'false', []);
    const task = getTask(db, 'rw-fail-2');
    assert.ok(task.resolution_at, 'resolution_at should be set on failure');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: non-zero exit code is in event message', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-fail-exitcode');
    runWorkerAndAutoResolve(db, 'rw-fail-exitcode', 'sh', ['-c', 'exit 42']);
    const events = getTaskEvents(db, 'rw-fail-exitcode');
    const resolved = events.find(e => e.event_type === 'resolved');
    assert.ok(resolved, 'should have resolved event');
    assert.match(resolved.message, /42/, 'exit code 42 should appear in event message');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: non-zero exit preserves exit code in result.status', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-fail-status');
    const result = runWorkerAndAutoResolve(db, 'rw-fail-status', 'sh', ['-c', 'exit 7']);
    assert.equal(result.status, 7);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: non-zero exit stderr captured in result', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-fail-stderr');
    const result = runWorkerAndAutoResolve(db, 'rw-fail-stderr', 'sh', ['-c', 'echo err-text >&2; exit 1']);
    assert.ok(result.stderr.includes('err-text'));
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: both paths produce resolvedTask with correct id', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-both-1');
    const result = runWorkerAndAutoResolve(db, 'rw-both-1', 'sh', ['-c', 'exit 1']);
    assert.ok(result.resolvedTask, 'resolvedTask should be present on failure');
    assert.equal(result.resolvedTask.id, 'rw-both-1');
    assert.equal(result.resolvedTask.resolution_status, 'failed');
  } finally { cleanupDb(db); }
});

// ─── error cases ─────────────────────────────────────────────────────────────

test('runWorkerAndAutoResolve: throws when command is empty', () => {
  const db = makeDb();
  try {
    seedTask(db, 'rw-no-cmd');
    assert.throws(() => runWorkerAndAutoResolve(db, 'rw-no-cmd', '', []), /command/i);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: throws when task does not exist', () => {
  const db = makeDb();
  try {
    assert.throws(() => runWorkerAndAutoResolve(db, 'ghost', 'true', []), /not found/i);
  } finally { cleanupDb(db); }
});
