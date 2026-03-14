'use strict';

/**
 * External review tests: run-worker CLI command (Phase 2b).
 *
 * The run-worker command is entirely new in Phase 2b:
 *   node bin/agent-follow-up.js run-worker --id <id> [--db <path>] <command> [args...]
 *
 * Contract:
 *   - Runs <command> synchronously
 *   - If command exits 0: resolves task as completed, exits 0
 *   - If command exits non-zero: does NOT resolve task, exits with command's code
 *   - stdout/stderr from the command are passed through
 *   - Missing task: exits 1 with error on stderr
 *   - Already-resolved task: exits 1 with error on stderr
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync, execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'agent-follow-up.js');
const ROOT = path.join(__dirname, '..', '..', '..');
const { openDb, insertTask, getTask } = require('../../../src/db');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ext-rw-cli-'));
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    ...opts
  });
}

function setupDb(dir) {
  const dbPath = path.join(dir, 'tasks.db');
  const db = openDb(dbPath);
  insertTask(db, {
    id: 'rw-task-1',
    title: 'Run Worker Test Task',
    notify_target: 'telegram:1',
    observable_type: 'manual',
    observable_id: 'label'
  });
  db.close();
  return dbPath;
}

// ─── exit 0: auto-resolve ─────────────────────────────────────────────────────

test('run-worker: exit-0 command exits 0 and resolves task', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath, 'true']);

    assert.equal(r.status, 0, `expected exit 0\nstderr: ${r.stderr}`);

    const db = openDb(dbPath);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'rw-task-1'").get();
    db.close();
    assert.equal(task.resolution_status, 'completed');
    assert.ok(task.resolution_at);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run-worker: exit-0 prints auto-resolved confirmation', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath, 'true']);

    assert.match(r.stdout, /auto-resolved|completed/i, `stdout: ${r.stdout}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run-worker: exit-0 passes command stdout through', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath,
      'sh', '-c', 'echo rw-stdout-marker']);

    assert.ok(r.stdout.includes('rw-stdout-marker'), `stdout: ${r.stdout}`);
    assert.equal(r.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── non-zero exit: no auto-resolve ──────────────────────────────────────────

test('run-worker: exit-1 command exits 1 and does NOT resolve task', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath, 'false']);

    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}`);

    const db = openDb(dbPath);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'rw-task-1'").get();
    db.close();
    assert.equal(task.resolution_status, null, 'task should remain unresolved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run-worker: exit code from command is preserved', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath,
      'sh', '-c', 'exit 42']);

    assert.equal(r.status, 42);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run-worker: exit-1 passes command stderr through', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath,
      'sh', '-c', 'echo rw-stderr-marker >&2; exit 1']);

    assert.ok(r.stderr.includes('rw-stderr-marker'), `stderr: ${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── error cases ─────────────────────────────────────────────────────────────

test('run-worker: missing task id exits 1 with error', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);
    const r = run(['run-worker', '--id', 'no-such-task', '--db', dbPath, 'true']);

    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found|no such|missing/i, `stderr: ${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run-worker: already-resolved task exits 1 with error', () => {
  const dir = tmpDir();
  try {
    const dbPath = setupDb(dir);

    // First run resolves it
    run(['run-worker', '--id', 'rw-task-1', '--db', dbPath, 'true']);

    // Second run should fail — already resolved
    const r = run(['run-worker', '--id', 'rw-task-1', '--db', dbPath, 'true']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already resolved/i, `stderr: ${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── Integration: register → run-worker → events ─────────────────────────────

test('run-worker: full register → run-worker → events flow', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    // Register
    execFileSync(process.execPath, [BIN, 'register',
      '--db', dbPath,
      '--id', 'rw-flow-1',
      '--title', 'RW Flow Task',
      '--interval', '3',
      '--target', 'telegram:1',
      '--observable-type', 'manual',
      '--observable-id', 'flow-label'
    ], { cwd: ROOT, encoding: 'utf8' });

    // Run worker (succeeds)
    const rw = spawnSync(process.execPath, [BIN, 'run-worker',
      '--id', 'rw-flow-1',
      '--db', dbPath,
      'sh', '-c', 'echo workflow-done'
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(rw.status, 0, `run-worker failed: ${rw.stderr}`);

    // Events should show registered + resolved
    const evts = execFileSync(process.execPath, [BIN, 'events',
      '--id', 'rw-flow-1', '--json', '--db', dbPath
    ], { cwd: ROOT, encoding: 'utf8' });
    const events = JSON.parse(evts);
    const types = events.map(e => e.event_type);
    assert.ok(types.includes('registered'), `events: ${types}`);
    assert.ok(types.includes('resolved'), `events: ${types}`);

    const resolved = events.find(e => e.event_type === 'resolved');
    assert.equal(resolved.observed_status, 'completed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
