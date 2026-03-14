'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, insertTask, updateTaskObservation } = require('../src/db');
const {
  summarizeTasks,
  runDoctor,
  canonicalWatchdogEntrypoint,
  readCronJobs
} = require('../src/observability');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-observe-'));
  const dbPath = path.join(dir, 'tasks.db');
  const db = openDb(dbPath);
  db._dir = dir;
  db._path = dbPath;
  return db;
}

function cleanupDb(db) {
  db.close();
  fs.rmSync(db._dir, { recursive: true, force: true });
}

function makeCronJobsFile(jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-cron-'));
  const jobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsPath, JSON.stringify({ version: 1, jobs }, null, 2));
  return { dir, jobsPath };
}

test('summarizeTasks returns active counts, attention items, and recent resolved tasks', () => {
  const db = makeDb();
  try {
    insertTask(db, {
      id: 'run-1', title: 'Running task', notify_target: 'telegram:1',
      observable_type: 'manual', observable_id: 'manual-1'
    });
    insertTask(db, {
      id: 'stale-1', title: 'Stale task', notify_target: 'telegram:2',
      observable_type: 'marker', observable_id: '/tmp/stale-marker.json'
    });
    insertTask(db, {
      id: 'done-1', title: 'Done task', notify_target: 'telegram:3',
      observable_type: 'manual', observable_id: 'manual-3'
    });

    updateTaskObservation(db, 'run-1', { last_observed_status: 'running' });
    updateTaskObservation(db, 'stale-1', { last_observed_status: 'stale', last_notification_status: 'failed', unknown_cycle_count: 1 });
    updateTaskObservation(db, 'done-1', {
      resolution_status: 'completed',
      resolution_at: '2026-03-14T13:00:00.000Z',
      last_observed_status: 'completed'
    });

    const summary = summarizeTasks(db, { recentResolvedLimit: 3 });
    assert.equal(summary.activeTaskCount, 2);
    assert.equal(summary.resolvedTaskCount, 1);
    assert.equal(summary.activeTasksByState.running, 1);
    assert.equal(summary.activeTasksByState.stale, 1);
    assert.equal(summary.tasksNeedingAttention.length, 1);
    assert.equal(summary.tasksNeedingAttention[0].id, 'stale-1');
    assert.equal(summary.recentResolvedTasks.length, 1);
    assert.equal(summary.recentResolvedTasks[0].id, 'done-1');
  } finally {
    cleanupDb(db);
  }
});

test('readCronJobs reads jobs array from object payload', () => {
  const { dir, jobsPath } = makeCronJobsFile([{ name: 'agent-follow-up-watchdog' }]);
  try {
    const result = readCronJobs(jobsPath);
    assert.equal(result.ok, true);
    assert.equal(result.jobs.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctor passes when DB is reachable and cron payload is canonical', () => {
  const db = makeDb();
  const expectedPayload = canonicalWatchdogEntrypoint();
  const { dir, jobsPath } = makeCronJobsFile([
    {
      id: 'job-1',
      name: 'agent-follow-up-watchdog',
      enabled: true,
      payload: { kind: 'systemEvent', text: expectedPayload }
    }
  ]);

  try {
    insertTask(db, {
      id: 'run-1', title: 'Healthy task', notify_target: 'telegram:1',
      observable_type: 'manual', observable_id: 'manual-1'
    });

    const report = runDoctor(db, { cronJobsPath: jobsPath });
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.name === 'db_reachable').ok, true);
    assert.equal(report.checks.find((c) => c.name === 'watchdog_cron_present').ok, true);
    assert.equal(report.checks.find((c) => c.name === 'watchdog_cron_payload_canonical').ok, true);
    assert.equal(report.warnings.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    cleanupDb(db);
  }
});

test('runDoctor fails on missing cron job and warns on stale or unknown tasks', () => {
  const db = makeDb();
  const { dir, jobsPath } = makeCronJobsFile([]);
  try {
    insertTask(db, {
      id: 'stale-1', title: 'Needs help', notify_target: 'telegram:1',
      observable_type: 'manual', observable_id: 'manual-1'
    });
    updateTaskObservation(db, 'stale-1', { last_observed_status: 'unknown', unknown_cycle_count: 2 });

    const report = runDoctor(db, { cronJobsPath: jobsPath });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'watchdog_cron_present').ok, false);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0].details.join(','), /stale-1:unknown/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    cleanupDb(db);
  }
});
