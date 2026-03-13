'use strict';

/**
 * CLI integration tests.
 * Invokes src/cli.js as a subprocess to verify the full command contract
 * defined in the registration contract (requirements §3) and architecture §3.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function mkTmpDb() {
  return path.join(os.tmpdir(), `cli-test-${process.pid}-${Date.now()}.db`);
}

function mkTmpMarker() {
  const p = path.join(os.tmpdir(), `cli-marker-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ status: 'running' }));
  return p;
}

function run(args, dbPath) {
  const allArgs = [...args];
  if (dbPath) allArgs.push('--db', dbPath);
  return spawnSync(process.execPath, [CLI, ...allArgs], { encoding: 'utf8' });
}

function openTestDb(dbPath) {
  return new DatabaseSync(dbPath);
}

// ─── register ────────────────────────────────────────────────────────────────

test('cli register: succeeds and prints task id', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    const r = run([
      'register',
      '--id', 'cli-001',
      '--title', 'CLI Test Task',
      '--target', 'telegram:8625301893',
      '--observable-type', 'marker',
      '--observable-id', markerPath,
      '--interval', '3'
    ], dbPath);

    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('cli-001'), 'stdout should include task id');
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: persists row to SQLite with correct fields', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run([
      'register',
      '--id', 'cli-002',
      '--title', 'Persistence Check',
      '--target', 'telegram:999',
      '--observable-type', 'marker',
      '--observable-id', markerPath,
      '--interval', '5',
      '--session', 'test-uuid-abc'
    ], dbPath);

    const db = openTestDb(dbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('cli-002');
    db.close();

    assert.equal(task.title, 'Persistence Check');
    assert.equal(task.notify_target, 'telegram:999');
    assert.equal(task.observable_type, 'marker');
    assert.equal(task.observable_id, markerPath);
    assert.equal(task.checkin_every_minutes, 5);
    assert.equal(task.owner_session_uuid, 'test-uuid-abc');
    assert.equal(task.last_observed_status, 'running');
    assert.equal(task.unknown_cycle_count, 0);
    assert.ok(task.started_at);
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: writes a registered event row', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run([
      'register',
      '--id', 'cli-003',
      '--title', 'Event Row Check',
      '--target', 'telegram:1',
      '--observable-type', 'marker',
      '--observable-id', markerPath
    ], dbPath);

    const db = openTestDb(dbPath);
    const events = db.prepare("SELECT * FROM task_events WHERE task_id = 'cli-003'").all();
    db.close();

    assert.ok(events.length >= 1, 'should have at least one event');
    assert.equal(events[0].event_type, 'registered');
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: rejects duplicate task id with exit 1', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    const baseArgs = [
      'register', '--id', 'cli-dup',
      '--title', 'Dup Task', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath
    ];
    run(baseArgs, dbPath);
    const r = run(baseArgs, dbPath);
    assert.equal(r.status, 1, 'duplicate registration should exit 1');
    assert.ok(r.stderr.includes('already registered'));
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: rejects invalid observable-type with exit 1', () => {
  const dbPath = mkTmpDb();
  try {
    const r = run([
      'register', '--id', 'cli-badtype',
      '--title', 'Bad', '--target', 'telegram:1',
      '--observable-type', 'unsupported',
      '--observable-id', '/tmp/x'
    ], dbPath);
    assert.equal(r.status, 1);
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: rejects non-integer interval with exit 1', () => {
  const dbPath = mkTmpDb();
  try {
    const r = run([
      'register', '--id', 'cli-badint',
      '--title', 'Bad', '--target', 'telegram:1',
      '--observable-type', 'marker',
      '--observable-id', '/tmp/x',
      '--interval', 'abc'
    ], dbPath);
    assert.equal(r.status, 1);
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli register: rejects interval of 0 with exit 1', () => {
  const dbPath = mkTmpDb();
  try {
    const r = run([
      'register', '--id', 'cli-zeroint',
      '--title', 'Bad', '--target', 'telegram:1',
      '--observable-type', 'marker',
      '--observable-id', '/tmp/x',
      '--interval', '0'
    ], dbPath);
    assert.equal(r.status, 1);
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

// ─── resolve ─────────────────────────────────────────────────────────────────

test('cli resolve: marks task completed and exits 0', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-res-1', '--title', 'T', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);

    const r = run(['resolve', '--id', 'cli-res-1', '--status', 'completed'], dbPath);
    assert.equal(r.status, 0, `exit status: ${r.status}\nstderr: ${r.stderr}`);

    const db = openTestDb(dbPath);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'cli-res-1'").get();
    db.close();
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at);
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli resolve: marks task failed and exits 0', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-res-2', '--title', 'T', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);

    const r = run(['resolve', '--id', 'cli-res-2', '--status', 'failed',
      '--message', 'build error'], dbPath);
    assert.equal(r.status, 0);

    const db = openTestDb(dbPath);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'cli-res-2'").get();
    const events = db.prepare("SELECT * FROM task_events WHERE task_id = 'cli-res-2'").all();
    db.close();

    assert.equal(task.resolution_status, 'failed');
    const resolveEvent = events.find(e => e.event_type === 'resolved');
    assert.ok(resolveEvent, 'should have a resolved event');
    assert.ok(resolveEvent.message.includes('build error'));
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli resolve: rejects already-resolved task with exit 1', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-res-3', '--title', 'T', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);
    run(['resolve', '--id', 'cli-res-3', '--status', 'completed'], dbPath);

    const r = run(['resolve', '--id', 'cli-res-3', '--status', 'failed'], dbPath);
    assert.equal(r.status, 1, 'second resolve should fail');
    assert.ok(r.stderr.includes('already resolved'));
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli resolve: rejects non-existent task with exit 1', () => {
  const dbPath = mkTmpDb();
  // Create empty db
  const { openDb } = require('../src/db');
  const db = openDb(dbPath);
  db.close();
  try {
    const r = run(['resolve', '--id', 'no-such-task', '--status', 'completed'], dbPath);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('not found'));
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli resolve: rejects invalid status with exit 1', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-res-4', '--title', 'T', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);
    const r = run(['resolve', '--id', 'cli-res-4', '--status', 'unknown'], dbPath);
    assert.equal(r.status, 1);
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

// ─── list ────────────────────────────────────────────────────────────────────

test('cli list: shows registered tasks', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-list-1', '--title', 'List Task', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);

    const r = run(['list'], dbPath);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('cli-list-1'));
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli list --json: outputs valid JSON array', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-list-2', '--title', 'JSON Task', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);

    const r = run(['list', '--json'], dbPath);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.find(t => t.id === 'cli-list-2'));
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli list --active: omits resolved tasks', () => {
  const dbPath = mkTmpDb();
  const m1 = mkTmpMarker();
  const m2 = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-active-1', '--title', 'Active', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', m1], dbPath);
    run(['register', '--id', 'cli-active-2', '--title', 'Resolved', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', m2], dbPath);
    run(['resolve', '--id', 'cli-active-2', '--status', 'completed'], dbPath);

    const r = run(['list', '--active', '--json'], dbPath);
    const tasks = JSON.parse(r.stdout);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('cli-active-1'));
    assert.ok(!ids.includes('cli-active-2'));
  } finally {
    [m1, m2].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

// ─── events ──────────────────────────────────────────────────────────────────

test('cli events: shows event log for task', () => {
  const dbPath = mkTmpDb();
  const markerPath = mkTmpMarker();
  try {
    run(['register', '--id', 'cli-ev-1', '--title', 'Events Task', '--target', 'telegram:1',
      '--observable-type', 'marker', '--observable-id', markerPath], dbPath);

    const r = run(['events', '--id', 'cli-ev-1', '--json'], dbPath);
    assert.equal(r.status, 0);
    const events = JSON.parse(r.stdout);
    assert.ok(Array.isArray(events));
    assert.ok(events.length >= 1);
    assert.equal(events[0].event_type, 'registered');
  } finally {
    fs.unlinkSync(markerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('cli events: exits 1 for unknown task id', () => {
  const dbPath = mkTmpDb();
  const { openDb } = require('../src/db');
  const db = openDb(dbPath);
  db.close();
  try {
    const r = run(['events', '--id', 'ghost-task'], dbPath);
    assert.equal(r.status, 1);
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});
