'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, DEFAULT_DB_PATH, getActiveTasks, getAllTasks } = require('./db');

const DEFAULT_CRON_JOBS_PATH = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
const DEFAULT_RECENT_RESOLVED_LIMIT = 5;

function canonicalWatchdogEntrypoint() {
  return `node ${path.join(__dirname, '..', 'bin', 'agent-follow-up.js')} watchdog`;
}

function summarizeTasks(dbOrPath, opts = {}) {
  const dbPath = typeof dbOrPath === 'string' || dbOrPath === undefined ? (dbOrPath || DEFAULT_DB_PATH) : null;
  const db = dbPath ? openDb(dbPath) : dbOrPath;
  const shouldClose = Boolean(dbPath);

  try {
    const activeTasks = getActiveTasks(db);
    const allTasks = getAllTasks(db);
    const recentResolvedLimit = opts.recentResolvedLimit || DEFAULT_RECENT_RESOLVED_LIMIT;

    const activeByState = {};
    for (const task of activeTasks) {
      const state = task.last_observed_status || 'unknown';
      activeByState[state] = (activeByState[state] || 0) + 1;
    }

    const recentResolvedTasks = allTasks
      .filter((task) => task.resolution_status)
      .sort((a, b) => {
        const aTs = Date.parse(a.resolution_at || a.started_at || 0);
        const bTs = Date.parse(b.resolution_at || b.started_at || 0);
        return bTs - aTs;
      })
      .slice(0, recentResolvedLimit)
      .map((task) => ({
        id: task.id,
        title: task.title,
        resolution_status: task.resolution_status,
        resolution_at: task.resolution_at,
        last_observed_status: task.last_observed_status
      }));

    const tasksNeedingAttention = activeTasks
      .filter((task) => {
        const state = task.last_observed_status || 'unknown';
        return state === 'stale' || state === 'unknown' || task.last_notification_status === 'failed';
      })
      .map((task) => ({
        id: task.id,
        title: task.title,
        state: task.last_observed_status || 'unknown',
        last_notification_status: task.last_notification_status,
        observable_type: task.observable_type,
        observable_id: task.observable_id,
        unknown_cycle_count: task.unknown_cycle_count
      }));

    return {
      dbPath: dbPath || null,
      generatedAt: new Date().toISOString(),
      activeTaskCount: activeTasks.length,
      resolvedTaskCount: allTasks.filter((task) => task.resolution_status).length,
      activeTasksByState: activeByState,
      recentResolvedTasks,
      tasksNeedingAttention
    };
  } finally {
    if (shouldClose) db.close();
  }
}

function readCronJobs(cronJobsPath = DEFAULT_CRON_JOBS_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(cronJobsPath, 'utf8');
  } catch (err) {
    return { ok: false, path: cronJobsPath, error: `cron jobs file not readable: ${err.code || err.message}` };
  }

  try {
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return { ok: true, path: cronJobsPath, jobs };
  } catch (err) {
    return { ok: false, path: cronJobsPath, error: `cron jobs file parse error: ${err.message}` };
  }
}

function runDoctor(dbOrPath, opts = {}) {
  const dbPath = typeof dbOrPath === 'string' || dbOrPath === undefined ? (dbOrPath || DEFAULT_DB_PATH) : null;
  const db = dbPath ? openDb(dbPath) : dbOrPath;
  const shouldClose = Boolean(dbPath);
  const cronJobsPath = opts.cronJobsPath || DEFAULT_CRON_JOBS_PATH;
  const expectedPayload = opts.expectedPayload || canonicalWatchdogEntrypoint();

  try {
    const checks = [];
    const warnings = [];

    let taskCount = 0;
    try {
      taskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
      checks.push({ name: 'db_reachable', ok: true, details: `tasks=${taskCount}` });
    } catch (err) {
      checks.push({ name: 'db_reachable', ok: false, details: err.message });
    }

    const cron = readCronJobs(cronJobsPath);
    if (!cron.ok) {
      checks.push({ name: 'cron_jobs_readable', ok: false, details: cron.error });
      checks.push({ name: 'watchdog_cron_present', ok: false, details: 'cron jobs unavailable' });
      checks.push({ name: 'watchdog_cron_payload_canonical', ok: false, details: 'cron jobs unavailable' });
    } else {
      checks.push({ name: 'cron_jobs_readable', ok: true, details: `jobs=${cron.jobs.length}` });
      const watchdogJob = cron.jobs.find((job) => job && job.name === 'agent-follow-up-watchdog');
      if (!watchdogJob) {
        checks.push({ name: 'watchdog_cron_present', ok: false, details: 'job agent-follow-up-watchdog not found' });
        checks.push({ name: 'watchdog_cron_payload_canonical', ok: false, details: 'watchdog job missing' });
      } else {
        const actualPayload = watchdogJob.payload && watchdogJob.payload.text;
        checks.push({ name: 'watchdog_cron_present', ok: true, details: `id=${watchdogJob.id || watchdogJob.jobId || 'unknown'} enabled=${watchdogJob.enabled !== false}` });
        checks.push({
          name: 'watchdog_cron_payload_canonical',
          ok: actualPayload === expectedPayload,
          details: `expected=${expectedPayload}; actual=${actualPayload || 'missing'}`
        });
      }
    }

    const activeTasks = getActiveTasks(db);
    const staleOrUnknown = activeTasks.filter((task) => ['stale', 'unknown'].includes(task.last_observed_status));
    if (staleOrUnknown.length > 0) {
      warnings.push({
        name: 'tasks_needing_attention',
        details: staleOrUnknown.map((task) => `${task.id}:${task.last_observed_status || 'unknown'}`)
      });
    }

    const unknownTypeTasks = activeTasks.filter((task) => !['marker', 'manual', 'session'].includes(task.observable_type));
    if (unknownTypeTasks.length > 0) {
      warnings.push({
        name: 'unsupported_observable_types',
        details: unknownTypeTasks.map((task) => `${task.id}:${task.observable_type}`)
      });
    }

    const ok = checks.every((check) => check.ok);
    return {
      ok,
      dbPath: dbPath || null,
      cronJobsPath,
      expectedWatchdogPayload: expectedPayload,
      checks,
      warnings,
      taskCount
    };
  } finally {
    if (shouldClose) db.close();
  }
}

module.exports = {
  summarizeTasks,
  runDoctor,
  canonicalWatchdogEntrypoint,
  readCronJobs,
  DEFAULT_CRON_JOBS_PATH,
  DEFAULT_RECENT_RESOLVED_LIMIT
};
