const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-cli-'));
  return { dir, dbPath: path.join(dir, 'tasks.db') };
}

function cli(args, opts = {}) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

test('register then list shows the task', () => {
  const { dir, dbPath } = makeTempDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  const reg = cli(['register', '--db', dbPath, '--id', 'cli-1', '--title', 'CLI Task',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'marker', '--observable-id', marker]);
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const out = cli(['list', '--db', dbPath]);
  assert.equal(out.status, 0, `list failed: ${out.stderr}`);
  assert.match(out.stdout, /cli-1/);
  assert.match(out.stdout, /CLI Task/);
});

test('duplicate register exits 1', () => {
  const { dir, dbPath } = makeTempDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running', updatedAt: new Date().toISOString() }));

  const args = ['register', '--db', dbPath, '--id', 'dup-1', '--title', 'Dup Task',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'marker', '--observable-id', marker];
  cli(args); // first registration
  const second = cli(args); // duplicate
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already registered/i);
});

test('resolve of unknown task exits 1', () => {
  const { dbPath } = makeTempDb();
  const result = cli(['resolve', '--db', dbPath, '--id', 'missing', '--status', 'completed']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found/i);
});
