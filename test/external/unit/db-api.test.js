'use strict';

/**
 * External review tests: path-based db API (Phase 2 refactor).
 *
 * The agent's Phase 2 refactor introduces a higher-level, path-based db API
 * alongside the existing low-level connection-based functions:
 *
 *   db.init(dbPath)                  — create schema without returning a connection
 *   db.registerTask(dbPath, opts)    — open, insert, close
 *   db.listTasks(dbPath)             — open, select all, close
 *   db.getTask(dbPath, id)           — open, select one, close; null if missing
 *   db.resolveTask(dbPath, id, opts) — open, mark resolved, close
 *
 * These functions are what the refactored cli.test.js and concurrency.test.js
 * call. This file verifies they exist and behave correctly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const db = require('../../../src/db');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-db-api-'));
  return { dir, dbPath: path.join(dir, 'tasks.db') };
}

function cleanup({ dir }) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── db.init ─────────────────────────────────────────────────────────────────

test('db.init: creates tasks and task_events tables', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    // Use low-level openDb to inspect the schema
    const conn = db.openDb(dbPath);
    const tables = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    conn.close();
    assert.ok(tables.includes('tasks'), 'tasks table missing');
    assert.ok(tables.includes('task_events'), 'task_events table missing');
  } finally { cleanup({ dir }); }
});

test('db.init: is idempotent — safe to call twice on same path', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    assert.doesNotThrow(() => db.init(dbPath), 'second init should not throw');
  } finally { cleanup({ dir }); }
});

test('db.init: enables WAL mode', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    const conn = db.openDb(dbPath);
    const row = conn.prepare('PRAGMA journal_mode').get();
    conn.close();
    assert.equal(row.journal_mode, 'wal');
  } finally { cleanup({ dir }); }
});

// ─── db.registerTask ─────────────────────────────────────────────────────────

test('db.registerTask: inserts a row with expected defaults', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, {
      id: 'reg-1',
      title: 'Registration Test',
      notify_target: 'telegram:999',
      observable_type: 'marker',
      observable_id: '/tmp/marker.json',
      checkin_every_minutes: 5
    });

    const task = db.getTask(dbPath, 'reg-1');
    assert.ok(task, 'task should exist');
    assert.equal(task.id, 'reg-1');
    assert.equal(task.title, 'Registration Test');
    assert.equal(task.notify_target, 'telegram:999');
    assert.equal(task.observable_type, 'marker');
    assert.equal(task.observable_id, '/tmp/marker.json');
    assert.equal(task.checkin_every_minutes, 5);
    assert.equal(task.last_observed_status, 'running');
    assert.equal(task.unknown_cycle_count, 0);
    assert.ok(task.started_at, 'started_at should be set');
    assert.equal(task.resolution_status, null);
  } finally { cleanup({ dir }); }
});

test('db.registerTask: accepts observable_type=session', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, {
      id: 'sess-reg-1',
      title: 'Session Task',
      notify_target: 'telegram:999',
      observable_type: 'session',
      observable_id: 'deadbeef-0000-0000-0000-000000000001',
      checkin_every_minutes: 3
    });

    const task = db.getTask(dbPath, 'sess-reg-1');
    assert.equal(task.observable_type, 'session');
    assert.equal(task.observable_id, 'deadbeef-0000-0000-0000-000000000001');
  } finally { cleanup({ dir }); }
});

test('db.registerTask: throws on duplicate id', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    const opts = {
      id: 'dup-id',
      title: 'Dup',
      notify_target: 'telegram:1',
      observable_type: 'manual',
      observable_id: 'label'
    };
    db.registerTask(dbPath, opts);
    assert.throws(() => db.registerTask(dbPath, opts), 'duplicate id should throw');
  } finally { cleanup({ dir }); }
});

test('db.registerTask: uses default checkin_every_minutes when omitted', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, {
      id: 'default-interval',
      title: 'Default Interval Task',
      notify_target: 'telegram:1',
      observable_type: 'manual',
      observable_id: 'label'
    });

    const task = db.getTask(dbPath, 'default-interval');
    assert.ok(task.checkin_every_minutes >= 1, 'default interval should be at least 1');
  } finally { cleanup({ dir }); }
});

// ─── db.listTasks ─────────────────────────────────────────────────────────────

test('db.listTasks: returns empty array on fresh db', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    const tasks = db.listTasks(dbPath);
    assert.ok(Array.isArray(tasks), 'listTasks should return an array');
    assert.equal(tasks.length, 0);
  } finally { cleanup({ dir }); }
});

test('db.listTasks: returns all tasks including resolved', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, { id: 'list-1', title: 'A', notify_target: 'telegram:1', observable_type: 'manual', observable_id: 'x' });
    db.registerTask(dbPath, { id: 'list-2', title: 'B', notify_target: 'telegram:2', observable_type: 'manual', observable_id: 'y' });
    db.resolveTask(dbPath, 'list-2', { resolution_status: 'completed' });

    const tasks = db.listTasks(dbPath);
    assert.equal(tasks.length, 2);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('list-1'));
    assert.ok(ids.includes('list-2'));
  } finally { cleanup({ dir }); }
});

test('db.listTasks: includes session-type tasks', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, {
      id: 'sess-list-1',
      title: 'Session Task',
      notify_target: 'telegram:1',
      observable_type: 'session',
      observable_id: 'some-session-uuid'
    });

    const tasks = db.listTasks(dbPath);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].observable_type, 'session');
  } finally { cleanup({ dir }); }
});

// ─── db.getTask ───────────────────────────────────────────────────────────────

test('db.getTask: returns null for missing id', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    const task = db.getTask(dbPath, 'ghost');
    assert.equal(task, null);
  } finally { cleanup({ dir }); }
});

// ─── db.resolveTask ───────────────────────────────────────────────────────────

test('db.resolveTask: marks task as completed', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, { id: 'res-1', title: 'Resolve Me', notify_target: 'telegram:1', observable_type: 'manual', observable_id: 'label' });
    db.resolveTask(dbPath, 'res-1', { resolution_status: 'completed' });

    const task = db.getTask(dbPath, 'res-1');
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at, 'resolution_at should be set');
  } finally { cleanup({ dir }); }
});

test('db.resolveTask: resolved task is excluded from active list', () => {
  const { dir, dbPath } = tmpDb();
  try {
    db.init(dbPath);
    db.registerTask(dbPath, { id: 'res-active-1', title: 'Active', notify_target: 'telegram:1', observable_type: 'manual', observable_id: 'x' });
    db.registerTask(dbPath, { id: 'res-active-2', title: 'Resolved', notify_target: 'telegram:1', observable_type: 'manual', observable_id: 'y' });
    db.resolveTask(dbPath, 'res-active-2', { resolution_status: 'failed' });

    // Use low-level getActiveTasks to check
    const conn = db.openDb(dbPath);
    const active = db.getActiveTasks(conn);
    conn.close();

    const ids = active.map(t => t.id);
    assert.ok(ids.includes('res-active-1'));
    assert.ok(!ids.includes('res-active-2'));
  } finally { cleanup({ dir }); }
});
