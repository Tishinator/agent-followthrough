const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dbModule = require('../src/db');
const emitter = require('../src/emitter');
const { runWatchdog } = require('../src/watchdog');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-concurrency-'));
  const dbPath = path.join(dir, 'tasks.db');
  return { dir, dbPath };
}

test('concurrent register attempts leave one task row', async () => {
  const { dir, dbPath } = makeTempDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  const args = ['register', '--db', dbPath, '--id', 'same-task', '--title', 'Same Task',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'marker', '--observable-id', marker];

  const results = await Promise.allSettled([
    Promise.resolve().then(() => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })),
    Promise.resolve().then(() => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })),
  ]);

  // Both processes ran; check DB directly
  const db = dbModule.openDb(dbPath);
  const rows = dbModule.getAllTasks(db);
  db.close();

  assert.equal(rows.filter(r => r.id === 'same-task').length, 1,
    'exactly one row for same-task should exist');

  const statuses = results.map(r => r.value.status);
  assert.equal(statuses.filter(s => s === 0).length, 1, 'exactly one should succeed');
  assert.equal(statuses.filter(s => s === 1).length, 1, 'exactly one should fail with exit 1');
});

test('watchdog processes multiple due tasks without corrupting state', () => {
  const { dir, dbPath } = makeTempDb();
  const markerA = path.join(dir, 'a.json');
  const markerB = path.join(dir, 'b.json');
  fs.writeFileSync(markerA, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));
  fs.writeFileSync(markerB, JSON.stringify({ status: 'completed', updatedAt: new Date().toISOString(), exitCode: 0 }));

  const db = dbModule.openDb(dbPath);
  dbModule.insertTask(db, { id: 'a', title: 'A', notify_target: 'telegram:8625301893', observable_type: 'marker', observable_id: markerA, checkin_every_minutes: 0 });
  dbModule.insertTask(db, { id: 'b', title: 'B', notify_target: 'telegram:8625301893', observable_type: 'marker', observable_id: markerB, checkin_every_minutes: 0 });

  // Stub emitter to avoid real network calls
  const origSend = emitter.sendNotification;
  emitter.sendNotification = () => ({ success: true, exitCode: 0, output: 'stubbed' });
  try {
    const results = runWatchdog(db);
    assert.ok(results.length >= 2, `expected >= 2 results, got ${results.length}`);
  } finally {
    emitter.sendNotification = origSend;
  }

  const rows = dbModule.getAllTasks(db);
  db.close();

  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => r.id === 'b' && r.resolution_status === 'completed'),
    'task b should be resolved as completed');
});
