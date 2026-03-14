'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, insertTask, getTask, getTaskEvents } = require('../src/db');
const { runWorkerAndAutoResolve } = require('../src/worker');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-worker-'));
  const dbPath = path.join(dir, 'tasks.db');
  const db = openDb(dbPath);
  db._dir = dir;
  return db;
}

function cleanup(db) {
  const dir = db._dir;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('runWorkerAndAutoResolve marks task completed after worker exit 0', () => {
  const db = makeDb();
  try {
    insertTask(db, {
      id: 'worker-complete-1',
      title: 'Worker Complete',
      notify_target: 'telegram:1',
      observable_type: 'session',
      observable_id: 'worker-session-uuid-1'
    });

    const result = runWorkerAndAutoResolve(db, 'worker-complete-1', process.execPath, [
      '-e',
      'process.stdout.write("done")'
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.autoResolved, true);
    assert.equal(result.resolutionStatus, 'completed');
    assert.match(result.stdout, /done/);

    const task = getTask(db, 'worker-complete-1');
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at);

    const events = getTaskEvents(db, 'worker-complete-1');
    const resolved = events.find((event) => event.event_type === 'resolved');
    assert.ok(resolved);
    assert.match(resolved.message, /worker exit 0/);
  } finally {
    cleanup(db);
  }
});

test('runWorkerAndAutoResolve marks task failed after worker non-zero exit', () => {
  const db = makeDb();
  try {
    insertTask(db, {
      id: 'worker-fail-1',
      title: 'Worker Fail',
      notify_target: 'telegram:1',
      observable_type: 'session',
      observable_id: 'worker-session-uuid-2'
    });

    const result = runWorkerAndAutoResolve(db, 'worker-fail-1', process.execPath, [
      '-e',
      'process.exit(5)'
    ]);

    assert.equal(result.status, 5);
    assert.equal(result.autoResolved, true);
    assert.equal(result.resolutionStatus, 'failed');

    const task = getTask(db, 'worker-fail-1');
    assert.equal(task.resolution_status, 'failed');
    assert.ok(task.resolution_at);

    const events = getTaskEvents(db, 'worker-fail-1');
    const resolved = events.find((event) => event.event_type === 'resolved');
    assert.ok(resolved);
    assert.match(resolved.message, /worker exit 5/);
  } finally {
    cleanup(db);
  }
});
