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

test('session register prints explicit completion contract note', () => {
  const { dbPath } = makeTempDb();

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-session-contract-1', '--title', 'CLI Session Contract',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'session', '--observable-id', 'session-contract-uuid-1'
  ]);

  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);
  assert.match(reg.stdout, /Session completion contract:/);
  assert.match(reg.stdout, /resolve --id cli-session-contract-1 --status completed/);
});

test('run-worker auto-resolves a session task when worker exits 0', () => {
  const { dbPath } = makeTempDb();

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-worker-complete-1', '--title', 'CLI Worker Completion',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'session', '--observable-id', 'session-worker-uuid-1'
  ]);
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const run = cli([
    'run-worker', '--db', dbPath, '--id', 'cli-worker-complete-1',
    process.execPath, '-e', 'process.stdout.write("worker-ok")'
  ]);

  assert.equal(run.status, 0, `run-worker failed: ${run.stderr}`);
  assert.match(run.stdout, /worker-ok/);
  assert.match(run.stdout, /Auto-resolved task 'cli-worker-complete-1' as completed/);

  const list = cli(['list', '--active', '--db', dbPath]);
  assert.equal(list.status, 0, `list failed: ${list.stderr}`);
  assert.doesNotMatch(list.stdout, /cli-worker-complete-1/);

  const events = cli(['events', '--db', dbPath, '--id', 'cli-worker-complete-1']);
  assert.equal(events.status, 0, `events failed: ${events.stderr}`);
  assert.match(events.stdout, /resolved/);
  assert.match(events.stdout, /worker success/);
});

test('run-worker leaves task unresolved when worker exits non-zero', () => {
  const { dbPath } = makeTempDb();

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-worker-fail-1', '--title', 'CLI Worker Failure',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'session', '--observable-id', 'session-worker-uuid-2'
  ]);
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const run = cli([
    'run-worker', '--db', dbPath, '--id', 'cli-worker-fail-1',
    process.execPath, '-e', 'process.stderr.write("worker-fail"); process.exit(7)'
  ]);

  assert.equal(run.status, 7, `expected worker exit code 7, stderr: ${run.stderr}`);
  assert.match(run.stderr, /worker-fail/);
  assert.doesNotMatch(run.stdout, /Auto-resolved/);

  const list = cli(['list', '--active', '--db', dbPath]);
  assert.equal(list.status, 0, `list failed: ${list.stderr}`);
  assert.match(list.stdout, /cli-worker-fail-1/);
});
