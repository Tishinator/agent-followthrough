'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { openDb, insertTask, getTask, getAllTasks, getActiveTasks,
        updateTaskObservation, insertEvent, getTaskEvents } = require('../src/db');

let db;
let dbPath;

before(() => {
  dbPath = path.join(os.tmpdir(), `test-tasks-${process.pid}.db`);
  db = openDb(dbPath);
});

after(() => {
  db.close();
  fs.unlinkSync(dbPath);
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
});

test('openDb creates schema tables', () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name).filter(n => !n.startsWith('sqlite_'));
  assert.deepEqual(tables, ['task_events', 'tasks']);
});

test('insertTask inserts a task and getTask retrieves it', () => {
  insertTask(db, {
    id: 'task-001',
    title: 'Test Task One',
    notify_target: 'telegram:123456',
    observable_type: 'marker',
    observable_id: '/tmp/test.marker.json'
  });
  const t = getTask(db, 'task-001');
  assert.equal(t.id, 'task-001');
  assert.equal(t.title, 'Test Task One');
  assert.equal(t.observable_type, 'marker');
  assert.equal(t.last_observed_status, 'running');
  assert.equal(t.unknown_cycle_count, 0);
});

test('insertTask rejects duplicate id', () => {
  assert.throws(() => {
    insertTask(db, {
      id: 'task-001',
      title: 'Duplicate',
      notify_target: 'telegram:1',
      observable_type: 'manual',
      observable_id: 'label'
    });
  });
});

test('getActiveTasks returns only unresolved tasks', () => {
  insertTask(db, {
    id: 'task-002',
    title: 'Active Task',
    notify_target: 'telegram:2',
    observable_type: 'manual',
    observable_id: 'label-2'
  });
  insertTask(db, {
    id: 'task-003',
    title: 'Resolved Task',
    notify_target: 'telegram:3',
    observable_type: 'manual',
    observable_id: 'label-3'
  });
  updateTaskObservation(db, 'task-003', {
    resolution_status: 'completed',
    resolution_at: new Date().toISOString()
  });
  const active = getActiveTasks(db);
  const ids = active.map(t => t.id);
  assert.ok(ids.includes('task-001'));
  assert.ok(ids.includes('task-002'));
  assert.ok(!ids.includes('task-003'));
});

test('getAllTasks returns all tasks including resolved', () => {
  const all = getAllTasks(db);
  const ids = all.map(t => t.id);
  assert.ok(ids.includes('task-003'));
});

test('updateTaskObservation updates fields', () => {
  const now = new Date().toISOString();
  updateTaskObservation(db, 'task-001', {
    last_observed_at: now,
    last_observed_status: 'running',
    unknown_cycle_count: 1
  });
  const t = getTask(db, 'task-001');
  assert.equal(t.last_observed_at, now);
  assert.equal(t.last_observed_status, 'running');
  assert.equal(t.unknown_cycle_count, 1);
});

test('insertEvent and getTaskEvents', () => {
  insertEvent(db, 'task-001', 'observation', 'running', 'all good');
  insertEvent(db, 'task-001', 'notification', 'running', 'sent ok');
  const events = getTaskEvents(db, 'task-001');
  assert.ok(events.length >= 2);
  const types = events.map(e => e.event_type);
  assert.ok(types.includes('observation'));
  assert.ok(types.includes('notification'));
});
