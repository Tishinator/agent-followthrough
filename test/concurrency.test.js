const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../src/db');
const watchdog = require('../src/watchdog');

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-concurrency-'));
  const dbPath = path.join(dir, 'tasks.db');
  db.init(dbPath);
  return { dir, dbPath };
}

test('concurrent register attempts leave one task row', async () => {
  const { dir, dbPath } = makeTempDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  const script = path.join(__dirname, '..', 'bin', 'agent-follow-up.js');
  const args = ['register', '--db', dbPath, '--id', 'same-task', '--title', 'Same Task', '--interval', '3', '--target', 'telegram:8625301893', '--observable-type', 'marker', '--observable-id', marker];

  const results = await Promise.allSettled([
    Promise.resolve().then(() => execFileSync('node', [script, ...args], { encoding: 'utf8' })),
    Promise.resolve().then(() => execFileSync('node', [script, ...args], { encoding: 'utf8' })),
  ]);

  const rows = db.listTasks(dbPath);
  assert.equal(rows.filter(r => r.id === 'same-task').length, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('watchdog processes multiple due tasks without corrupting state', async () => {
  const { dir, dbPath } = makeTempDb();
  const markerA = path.join(dir, 'a.json');
  const markerB = path.join(dir, 'b.json');
  fs.writeFileSync(markerA, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));
  fs.writeFileSync(markerB, JSON.stringify({ status: 'completed', updatedAt: new Date().toISOString(), exitCode: 0 }));

  db.registerTask(dbPath, { id: 'a', title: 'A', notify_target: 'telegram:8625301893', observable_type: 'marker', observable_id: markerA, checkin_every_minutes: 0 });
  db.registerTask(dbPath, { id: 'b', title: 'B', notify_target: 'telegram:8625301893', observable_type: 'marker', observable_id: markerB, checkin_every_minutes: 0 });

  const result = await watchdog.runWatchdog({ dbPath, dryRun: true });
  assert.equal(result.processed >= 2, true);

  const rows = db.listTasks(dbPath);
  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => r.id === 'b' && r.resolution_status === 'completed'));
});
