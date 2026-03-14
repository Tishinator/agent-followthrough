'use strict';

/**
 * External review tests: src/worker.js (Phase 2b).
 *
 * worker.js is entirely new in Phase 2b and has no coverage in the existing
 * test suite. This file covers both exported functions:
 *
 *   resolveTaskForWorkerSuccess(db, taskId, opts)
 *     - marks a task completed via the db layer
 *     - throws on missing task
 *     - throws on already-resolved task
 *
 *   runWorkerAndAutoResolve(db, taskId, command, args, opts)
 *     - spawns the command synchronously
 *     - auto-resolves task as completed when command exits 0
 *     - does NOT auto-resolve when command exits non-zero
 *     - passes stdout/stderr through in result
 *     - throws when command is missing
 *     - throws (or surfaces error) when task is missing
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDb, insertTask, getTask, getTaskEvents } = require('../../../src/db');
const { runWorkerAndAutoResolve, resolveTaskForWorkerSuccess } = require('../../../src/worker');

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

// ─── resolveTaskForWorkerSuccess ─────────────────────────────────────────────

test('resolveTaskForWorkerSuccess: marks task as completed', () => {
  const db = makeDb();
  try {
    seedTask(db, 'resolve-success-1');
    resolveTaskForWorkerSuccess(db, 'resolve-success-1');

    const task = getTask(db, 'resolve-success-1');
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at, 'resolution_at should be set');
    assert.equal(task.last_observed_status, 'completed');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerSuccess: returns the updated task row', () => {
  const db = makeDb();
  try {
    seedTask(db, 'resolve-success-2');
    const result = resolveTaskForWorkerSuccess(db, 'resolve-success-2');

    assert.ok(result, 'should return the updated task');
    assert.equal(result.id, 'resolve-success-2');
    assert.equal(result.resolution_status, 'completed');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerSuccess: inserts a resolved event row', () => {
  const db = makeDb();
  try {
    seedTask(db, 'resolve-success-3');
    resolveTaskForWorkerSuccess(db, 'resolve-success-3', { message: 'test worker done' });

    const events = getTaskEvents(db, 'resolve-success-3');
    const resolvedEvent = events.find(e => e.event_type === 'resolved');
    assert.ok(resolvedEvent, 'should have a resolved event');
    assert.equal(resolvedEvent.observed_status, 'completed');
    assert.ok(resolvedEvent.message.includes('test worker done'));
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerSuccess: uses default message when none provided', () => {
  const db = makeDb();
  try {
    seedTask(db, 'resolve-success-4');
    resolveTaskForWorkerSuccess(db, 'resolve-success-4');

    const events = getTaskEvents(db, 'resolve-success-4');
    const resolvedEvent = events.find(e => e.event_type === 'resolved');
    assert.ok(resolvedEvent.message, 'should have a non-empty default message');
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerSuccess: throws when task does not exist', () => {
  const db = makeDb();
  try {
    assert.throws(
      () => resolveTaskForWorkerSuccess(db, 'ghost-task'),
      /not found/i
    );
  } finally { cleanupDb(db); }
});

test('resolveTaskForWorkerSuccess: throws when task is already resolved', () => {
  const db = makeDb();
  try {
    seedTask(db, 'resolve-already-done');
    resolveTaskForWorkerSuccess(db, 'resolve-already-done');

    assert.throws(
      () => resolveTaskForWorkerSuccess(db, 'resolve-already-done'),
      /already resolved/i
    );
  } finally { cleanupDb(db); }
});

// ─── runWorkerAndAutoResolve: exit 0 ─────────────────────────────────────────

test('runWorkerAndAutoResolve: exit-0 command auto-resolves task as completed', () => {
  const db = makeDb();
  try {
    seedTask(db, 'auto-resolve-1');
    const result = runWorkerAndAutoResolve(db, 'auto-resolve-1', 'true', []);

    assert.equal(result.status, 0);
    assert.equal(result.autoResolved, true);

    const task = getTask(db, 'auto-resolve-1');
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit-0 result includes resolvedTask', () => {
  const db = makeDb();
  try {
    seedTask(db, 'auto-resolve-2');
    const result = runWorkerAndAutoResolve(db, 'auto-resolve-2', 'true', []);

    assert.ok(result.resolvedTask, 'result should include resolvedTask');
    assert.equal(result.resolvedTask.resolution_status, 'completed');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit-0 writes resolved event to task_events', () => {
  const db = makeDb();
  try {
    seedTask(db, 'auto-resolve-3');
    runWorkerAndAutoResolve(db, 'auto-resolve-3', 'true', []);

    const events = getTaskEvents(db, 'auto-resolve-3');
    const resolvedEvent = events.find(e => e.event_type === 'resolved');
    assert.ok(resolvedEvent, 'resolved event should be written');
    assert.equal(resolvedEvent.observed_status, 'completed');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit-0 captures stdout in result', () => {
  const db = makeDb();
  try {
    seedTask(db, 'auto-resolve-stdout');
    const result = runWorkerAndAutoResolve(db, 'auto-resolve-stdout', 'sh', ['-c', 'echo hello-output']);

    assert.ok(result.stdout.includes('hello-output'), `stdout: ${result.stdout}`);
    assert.equal(result.autoResolved, true);
  } finally { cleanupDb(db); }
});

// ─── runWorkerAndAutoResolve: non-zero exit ───────────────────────────────────

test('runWorkerAndAutoResolve: exit-1 command does NOT auto-resolve task', () => {
  const db = makeDb();
  try {
    seedTask(db, 'no-resolve-1');
    const result = runWorkerAndAutoResolve(db, 'no-resolve-1', 'false', []);

    assert.equal(result.status, 1);
    assert.equal(result.autoResolved, false);

    const task = getTask(db, 'no-resolve-1');
    assert.equal(task.resolution_status, null, 'task should remain unresolved');
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: exit-1 result has no resolvedTask', () => {
  const db = makeDb();
  try {
    seedTask(db, 'no-resolve-2');
    const result = runWorkerAndAutoResolve(db, 'no-resolve-2', 'false', []);

    assert.equal(result.resolvedTask, undefined);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: non-zero exit code is preserved in result', () => {
  const db = makeDb();
  try {
    seedTask(db, 'no-resolve-exitcode');
    const result = runWorkerAndAutoResolve(db, 'no-resolve-exitcode', 'sh', ['-c', 'exit 42']);

    assert.equal(result.status, 42);
    assert.equal(result.autoResolved, false);
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: stderr captured when command fails', () => {
  const db = makeDb();
  try {
    seedTask(db, 'no-resolve-stderr');
    const result = runWorkerAndAutoResolve(
      db, 'no-resolve-stderr',
      'sh', ['-c', 'echo err-output >&2; exit 1']
    );

    assert.ok(result.stderr.includes('err-output'), `stderr: ${result.stderr}`);
    assert.equal(result.autoResolved, false);
  } finally { cleanupDb(db); }
});

// ─── runWorkerAndAutoResolve: error cases ────────────────────────────────────

test('runWorkerAndAutoResolve: throws when command is empty string', () => {
  const db = makeDb();
  try {
    seedTask(db, 'err-no-cmd');
    assert.throws(
      () => runWorkerAndAutoResolve(db, 'err-no-cmd', '', []),
      /command/i
    );
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: throws when task does not exist', () => {
  const db = makeDb();
  try {
    assert.throws(
      () => runWorkerAndAutoResolve(db, 'ghost-task', 'true', []),
      /not found/i
    );
  } finally { cleanupDb(db); }
});

test('runWorkerAndAutoResolve: custom resolveMessage stored in event', () => {
  const db = makeDb();
  try {
    seedTask(db, 'custom-msg-1');
    runWorkerAndAutoResolve(db, 'custom-msg-1', 'true', [], {
      resolveMessage: 'build pipeline finished successfully'
    });

    const events = getTaskEvents(db, 'custom-msg-1');
    const resolvedEvent = events.find(e => e.event_type === 'resolved');
    assert.ok(resolvedEvent.message.includes('build pipeline finished successfully'));
  } finally { cleanupDb(db); }
});
