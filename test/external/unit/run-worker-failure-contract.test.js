'use strict';

/**
 * External review tests: run-worker failure contract (Phase 2b commit cc18e2f).
 *
 * Team decision (Michael + Larry, Slack):
 *   - Non-zero exit ALWAYS resolves task as 'failed' (not left unresolved)
 *   - Both exit-0 and non-zero: autoResolved=true, notification sent
 *   - Exit code appears in the resolved event message
 *
 * These four tests target the exact contract Larry shipped:
 *   1. non-zero exit resolves task as failed
 *   2. exit code appears in event message
 *   3. failure path emits a notification event
 *   4. task is no longer active (has resolution_status) after failed resolution
 *
 * Notification stubbing: a fake `openclaw` script is placed at the front of PATH
 * so emitter.sendNotification() exits 0 without hitting the real gateway.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'agent-follow-up.js');
const ROOT = path.join(__dirname, '..', '..', '..');
const { openDb, insertTask, getTask, getActiveTasks, getTaskEvents } = require('../../../src/db');

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ext-fc-'));
}

/**
 * Write a stub `openclaw` script to dir/bin so emitter calls succeed without
 * hitting the real gateway. Returns the stub bin directory path.
 */
function makeStubBin(dir) {
  const binDir = path.join(dir, 'stub-bin');
  fs.mkdirSync(binDir);
  const stub = path.join(binDir, 'openclaw');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  return binDir;
}

function setupDb(dir) {
  const dbPath = path.join(dir, 'tasks.db');
  const db = openDb(dbPath);
  insertTask(db, {
    id: 'fc-task-1',
    title: 'Failure Contract Task',
    notify_target: 'telegram:1',
    observable_type: 'manual',
    observable_id: 'label'
  });
  db.close();
  return dbPath;
}

function run(args, dir) {
  const stubBin = makeStubBin(dir);
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env
  });
}

// ─── 1. non-zero exit resolves task as failed ─────────────────────────────────

test('failure contract: non-zero exit resolves task as failed', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'fc-task-1', '--db', dbPath, 'false'], dir);

    assert.equal(r.status, 1, `CLI should exit 1\nstderr: ${r.stderr}`);

    const db = openDb(dbPath);
    const task = getTask(db, 'fc-task-1');
    db.close();

    assert.equal(task.resolution_status, 'failed',
      'task should be resolved as failed after non-zero worker exit');
    assert.ok(task.resolution_at, 'resolution_at must be set');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── 2. exit code appears in event message ────────────────────────────────────

test('failure contract: exit code appears in resolved event message', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    run(['run-worker', '--id', 'fc-task-1', '--db', dbPath, 'sh', '-c', 'exit 42'], dir);

    const db = openDb(dbPath);
    const events = getTaskEvents(db, 'fc-task-1');
    db.close();

    const resolved = events.find(e => e.event_type === 'resolved');
    assert.ok(resolved, 'resolved event must exist');
    assert.match(resolved.message, /42/, 'exit code 42 should appear in event message');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── 3. failure path emits a notification event ───────────────────────────────

test('failure contract: failure path writes a notification event', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'fc-task-1', '--db', dbPath, 'false'], dir);

    // CLI should print "Resolution notification" line
    assert.match(r.stdout, /auto-resolved|completed|failed/i,
      `stdout should mention resolution: ${r.stdout}`);

    const db = openDb(dbPath);
    const events = getTaskEvents(db, 'fc-task-1');
    db.close();

    const notifEvent = events.find(e => e.event_type === 'notification');
    assert.ok(notifEvent, 'a notification event must be written after failure resolution');
    assert.equal(notifEvent.observed_status, 'failed',
      'notification event observed_status should be failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── 4. task is no longer active after failed resolution ─────────────────────

test('failure contract: task is no longer active (has resolution) after failed resolution', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    run(['run-worker', '--id', 'fc-task-1', '--db', dbPath, 'false'], dir);

    const db = openDb(dbPath);
    const active = getActiveTasks(db);
    const task = getTask(db, 'fc-task-1');
    db.close();

    assert.ok(
      !active.some(t => t.id === 'fc-task-1'),
      'fc-task-1 should not appear in active tasks after failed resolution'
    );
    assert.equal(task.resolution_status, 'failed');
    assert.ok(task.resolution_at);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
