'use strict';

/**
 * External review tests: bin/agent-follow-up.js CLI binary (Phase 2).
 *
 * The Phase 2 refactor introduces a proper binary entry point at
 * bin/agent-follow-up.js, replacing direct invocation of src/cli.js.
 *
 * New Phase 2 CLI contract:
 *   node bin/agent-follow-up.js init-db --db <path>        — initialize the database
 *   node bin/agent-follow-up.js register --observable-type session ...  — session task
 *   node bin/agent-follow-up.js watchdog --db <path> [--sessions-path <path>]
 *
 * Existing Phase 1 commands (register/resolve/list/events) remain intact.
 * Error messages may differ slightly from Phase 1 — tests use regex matching.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync, execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'agent-follow-up.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ext-cli-'));
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    ...opts
  });
}

function runOk(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: PROJECT_ROOT
  });
}

function writeMarker(p, status = 'running') {
  fs.writeFileSync(p, JSON.stringify({ status, updatedAt: new Date().toISOString() }));
}

// ─── init-db ─────────────────────────────────────────────────────────────────

test('cli init-db: exits 0 and creates the database file', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    const r = run(['init-db', '--db', dbPath]);
    assert.equal(r.status, 0, `expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(dbPath), 'database file should be created');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli init-db: is idempotent — calling twice exits 0 both times', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    const r1 = run(['init-db', '--db', dbPath]);
    const r2 = run(['init-db', '--db', dbPath]);
    assert.equal(r1.status, 0, 'first init-db should exit 0');
    assert.equal(r2.status, 0, 'second init-db should exit 0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── register: session observable type ───────────────────────────────────────

test('cli register: accepts --observable-type session', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const sessUuid = 'cli-sess-uuid-0001';
  try {
    runOk(['init-db', '--db', dbPath]);
    const r = run([
      'register',
      '--db', dbPath,
      '--id', 'cli-sess-1',
      '--title', 'CLI Session Task',
      '--interval', '3',
      '--target', 'telegram:8625301893',
      '--observable-type', 'session',
      '--observable-id', sessUuid
    ]);
    assert.equal(r.status, 0, `expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('cli-sess-1'), 'stdout should include task id');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli register: session task persisted with correct observable_type', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const sessUuid = 'cli-sess-uuid-0002';
  try {
    runOk(['init-db', '--db', dbPath]);
    runOk([
      'register',
      '--db', dbPath,
      '--id', 'cli-sess-2',
      '--title', 'Persisted Session',
      '--interval', '3',
      '--target', 'telegram:999',
      '--observable-type', 'session',
      '--observable-id', sessUuid
    ]);

    const db = require('../../../src/db');
    const task = db.getTask(dbPath, 'cli-sess-2');
    assert.equal(task.observable_type, 'session');
    assert.equal(task.observable_id, sessUuid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── register: duplicate error message ───────────────────────────────────────

test('cli register: duplicate id exits 1 with informative message', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const marker = path.join(dir, 'marker.json');
  try {
    writeMarker(marker);
    runOk(['init-db', '--db', dbPath]);
    const args = ['register', '--db', dbPath, '--id', 'dup-sess', '--title', 'Dup', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'marker', '--observable-id', marker];
    runOk(args);
    const r = run(args);
    assert.equal(r.status, 1, 'second register should exit 1');
    assert.match(r.stderr, /already (exists|registered)|duplicate/i, `stderr: ${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── resolve: unknown task ────────────────────────────────────────────────────

test('cli resolve: unknown task id exits 1 with informative message', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    runOk(['init-db', '--db', dbPath]);
    const r = run(['resolve', '--db', dbPath, '--id', 'no-such-task', '--status', 'completed']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found|unknown|no such/i, `stderr: ${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── list ─────────────────────────────────────────────────────────────────────

test('cli list: shows marker and session tasks together', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const marker = path.join(dir, 'marker.json');
  try {
    writeMarker(marker);
    runOk(['init-db', '--db', dbPath]);
    runOk(['register', '--db', dbPath, '--id', 'list-marker', '--title', 'Marker Task', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'marker', '--observable-id', marker]);
    runOk(['register', '--db', dbPath, '--id', 'list-session', '--title', 'Session Task', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'session', '--observable-id', 'some-session-uuid']);

    const out = runOk(['list', '--db', dbPath]);
    assert.match(out, /list-marker/);
    assert.match(out, /list-session/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli list --active: excludes resolved tasks', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const marker = path.join(dir, 'marker.json');
  try {
    writeMarker(marker);
    runOk(['init-db', '--db', dbPath]);
    runOk(['register', '--db', dbPath, '--id', 'active-keep', '--title', 'Active', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'marker', '--observable-id', marker]);
    runOk(['register', '--db', dbPath, '--id', 'active-drop', '--title', 'Resolved', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'session', '--observable-id', 'resolved-uuid']);
    runOk(['resolve', '--db', dbPath, '--id', 'active-drop', '--status', 'completed']);

    const out = runOk(['list', '--active', '--db', dbPath]);
    assert.match(out, /active-keep/);
    assert.ok(!out.includes('active-drop'), 'resolved task should not appear in --active list');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── watchdog command ─────────────────────────────────────────────────────────

test('cli watchdog: exits 0 and reports processed count', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'tasks.db');
  const marker = path.join(dir, 'marker.json');
  writeMarker(marker);

  // Stub emitter by providing a fake openclaw on PATH
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'openclaw'),
    '#!/usr/bin/env bash\necho "✅ Sent via Telegram. Message ID: 99"\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'openclaw'), 0o755);

  try {
    runOk(['init-db', '--db', dbPath]);
    runOk(['register', '--db', dbPath, '--id', 'wd-cli-1', '--title', 'WD CLI Task', '--interval', '3', '--target', 'telegram:1', '--observable-type', 'marker', '--observable-id', marker]);

    const r = run(['watchdog', '--db', dbPath], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
    assert.equal(r.status, 0, `watchdog command should exit 0\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /processed|task/i, 'output should mention processed tasks');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
