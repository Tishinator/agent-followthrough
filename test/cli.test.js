const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-cli-'));
  const dbPath = path.join(dir, 'tasks.db');
  execFileSync('node', ['bin/agent-follow-up.js', 'init-db', '--db', dbPath], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8'
  });
  return { dir, dbPath };
}

test('register then list shows the task', () => {
  const { dir, dbPath } = setupDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  execFileSync('node', ['bin/agent-follow-up.js', 'register', '--db', dbPath, '--id', 'cli-1', '--title', 'CLI Task', '--interval', '3', '--target', 'telegram:8625301893', '--observable-type', 'marker', '--observable-id', marker], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8'
  });

  const out = execFileSync('node', ['bin/agent-follow-up.js', 'list', '--db', dbPath], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8'
  });
  assert.match(out, /cli-1/);
  assert.match(out, /CLI Task/);
});

test('duplicate register exits 1', () => {
  const { dir, dbPath } = setupDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  const args = ['bin/agent-follow-up.js', 'register', '--db', dbPath, '--id', 'dup-1', '--title', 'Dup Task', '--interval', '3', '--target', 'telegram:8625301893', '--observable-type', 'marker', '--observable-id', marker];
  spawnSync('node', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const second = spawnSync('node', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists|duplicate/i);
});

test('resolve of unknown task exits 1', () => {
  const { dbPath } = setupDb();
  const result = spawnSync('node', ['bin/agent-follow-up.js', 'resolve', '--db', dbPath, '--id', 'missing', '--status', 'completed'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found|unknown/i);
});
