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

function makeFakeOpenClaw(dir, logPath) {
  const binPath = path.join(dir, 'openclaw');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + "\\n");
process.stdout.write('fake-openclaw-ok');
`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
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

test('run-worker auto-resolves a session task when worker exits 0 and sends completion notification', () => {
  const { dir, dbPath } = makeTempDb();
  const logPath = path.join(dir, 'openclaw.log');
  makeFakeOpenClaw(dir, logPath);

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-worker-complete-1', '--title', 'CLI Worker Completion',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'session', '--observable-id', 'session-worker-uuid-1'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const run = cli([
    'run-worker', '--db', dbPath, '--id', 'cli-worker-complete-1',
    process.execPath, '-e', 'process.stdout.write("worker-ok")'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });

  assert.equal(run.status, 0, `run-worker failed: ${run.stderr}`);
  assert.match(run.stdout, /worker-ok/);
  assert.match(run.stdout, /Auto-resolved task 'cli-worker-complete-1' as completed after worker exit 0/);
  assert.match(run.stdout, /Resolution notification sent: fake-openclaw-ok/);

  const list = cli(['list', '--active', '--db', dbPath]);
  assert.equal(list.status, 0, `list failed: ${list.stderr}`);
  assert.doesNotMatch(list.stdout, /cli-worker-complete-1/);

  const events = cli(['events', '--db', dbPath, '--id', 'cli-worker-complete-1']);
  assert.equal(events.status, 0, `events failed: ${events.stderr}`);
  assert.match(events.stdout, /resolved/);
  assert.match(events.stdout, /worker exit 0/);
  assert.match(events.stdout, /\[notification\].*emitter=ok: fake-openclaw-ok/);

  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /message send --channel telegram --target 8625301893 --message/);
  assert.match(log, /Task completed: CLI Worker Completion/);
});

test('resolve sends a completion notification when it closes a task', () => {
  const { dir, dbPath } = makeTempDb();
  const logPath = path.join(dir, 'openclaw.log');
  makeFakeOpenClaw(dir, logPath);

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-resolve-notify-1', '--title', 'CLI Resolve Notification',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'manual', '--observable-id', 'manual-label-1'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const resolved = cli([
    'resolve', '--db', dbPath, '--id', 'cli-resolve-notify-1', '--status', 'completed'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });

  assert.equal(resolved.status, 0, `resolve failed: ${resolved.stderr}`);
  assert.match(resolved.stdout, /Resolved task 'cli-resolve-notify-1' as completed/);
  assert.match(resolved.stdout, /Completion notification sent: fake-openclaw-ok/);

  const events = cli(['events', '--db', dbPath, '--id', 'cli-resolve-notify-1']);
  assert.equal(events.status, 0, `events failed: ${events.stderr}`);
  assert.match(events.stdout, /\[resolved\].*Task resolved as completed via CLI/);
  assert.match(events.stdout, /\[notification\].*emitter=ok: fake-openclaw-ok/);

  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /message send --channel telegram --target 8625301893 --message/);
  assert.match(log, /Task completed: CLI Resolve Notification/);
});

test('run-worker auto-resolves a session task as failed when worker exits non-zero and sends failure notification', () => {
  const { dir, dbPath } = makeTempDb();
  const logPath = path.join(dir, 'openclaw.log');
  makeFakeOpenClaw(dir, logPath);

  const reg = cli([
    'register', '--db', dbPath, '--id', 'cli-worker-fail-1', '--title', 'CLI Worker Failure',
    '--interval', '3', '--target', 'telegram:8625301893',
    '--observable-type', 'session', '--observable-id', 'session-worker-uuid-2'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });
  assert.equal(reg.status, 0, `register failed: ${reg.stderr}`);

  const run = cli([
    'run-worker', '--db', dbPath, '--id', 'cli-worker-fail-1',
    process.execPath, '-e', 'process.stderr.write("worker-fail"); process.exit(7)'
  ], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });

  assert.equal(run.status, 7, `expected worker exit code 7, stderr: ${run.stderr}`);
  assert.match(run.stderr, /worker-fail/);
  assert.match(run.stdout, /Auto-resolved task 'cli-worker-fail-1' as failed after worker exit 7/);
  assert.match(run.stdout, /Resolution notification sent: fake-openclaw-ok/);

  const list = cli(['list', '--active', '--db', dbPath]);
  assert.equal(list.status, 0, `list failed: ${list.stderr}`);
  assert.doesNotMatch(list.stdout, /cli-worker-fail-1/);

  const events = cli(['events', '--db', dbPath, '--id', 'cli-worker-fail-1']);
  assert.equal(events.status, 0, `events failed: ${events.stderr}`);
  assert.match(events.stdout, /\[resolved\].*failed/);
  assert.match(events.stdout, /worker exit 7/);
  assert.match(events.stdout, /\[notification\].*emitter=ok: fake-openclaw-ok/);

  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /message send --channel telegram --target 8625301893 --message/);
  assert.match(log, /Task failed: CLI Worker Failure/);
});

test('status reports summary in human and json form', () => {
  const { dir, dbPath } = makeTempDb();
  const marker = path.join(dir, 'marker.json');
  fs.writeFileSync(marker, JSON.stringify({ status: 'running' }));

  assert.equal(cli([
    'register', '--db', dbPath, '--id', 'status-run-1', '--title', 'Status Running',
    '--interval', '3', '--target', 'telegram:1', '--observable-type', 'marker', '--observable-id', marker
  ]).status, 0);

  assert.equal(cli([
    'register', '--db', dbPath, '--id', 'status-manual-1', '--title', 'Status Manual',
    '--interval', '3', '--target', 'telegram:2', '--observable-type', 'manual', '--observable-id', 'manual-1'
  ]).status, 0);

  const watchdog = cli(['watchdog', '--db', dbPath]);
  assert.equal(watchdog.status, 0, `watchdog failed: ${watchdog.stderr}`);
  const human = cli(['status', '--db', dbPath]);
  assert.equal(human.status, 0, `status failed: ${human.stderr}`);
  assert.match(human.stdout, /Agent Follow-Up status/);
  assert.match(human.stdout, /DB: /);
  assert.match(human.stdout, /Active tasks: 2/);
  assert.match(human.stdout, /Recent resolved tasks:/);

  const json = cli(['status', '--db', dbPath, '--json']);
  assert.equal(json.status, 0, `status --json failed: ${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.activeTaskCount, 2);
  assert.equal(parsed.activeTasksByState.running, 2);
  assert.equal(Array.isArray(parsed.tasksNeedingAttention), true);
});

test('doctor reports failures for missing cron job path in human and json form', () => {
  const { dbPath } = makeTempDb();
  const cronJobsPath = path.join(os.tmpdir(), `afu-cron-missing-${process.pid}-${Date.now()}.json`);

  const human = cli(['doctor', '--db', dbPath, '--cron-jobs-path', cronJobsPath]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /Agent Follow-Up doctor/);
  assert.match(human.stdout, /\[fail\] cron_jobs_readable/);

  const json = cli(['doctor', '--db', dbPath, '--cron-jobs-path', cronJobsPath, '--json']);
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.find((c) => c.name === 'cron_jobs_readable').ok, false);
});
