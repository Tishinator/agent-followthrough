#!/usr/bin/env node
'use strict';

/**
 * Deterministic watchdog — no LLM involvement.
 *
 * Observation logic:
 *   observable_type = "marker"   -> check marker file exists + mtime
 *   observable_type = "session"  -> read ~/.openclaw/agents/main/sessions/sessions.json
 *   observable_type = "manual"   -> passive; only updated by CLI resolve
 *
 * State machine:
 *   running  -> marker present, mtime fresh within checkin_every_minutes window
 *   completed -> resolution_status set by CLI
 *   failed    -> resolution_status set by CLI, or marker signals failure
 *   unknown   -> observation source no longer confirms running AND
 *                unknown_cycle_count >= UNKNOWN_THRESHOLD (default 2)
 *   stale     -> observation source no longer confirms running AND
 *                unknown_cycle_count < UNKNOWN_THRESHOLD (transitional)
 *
 * A task in 'completed' or 'failed' resolution_status is skipped.
 *
 * Notification suppression:
 *   A notification is due when:
 *     - no notification has been sent yet, OR
 *     - last_notification_sent_at is older than checkin_every_minutes
 */

const fs = require('fs');
const path = require('path');
const { openDb, getActiveTasks, updateTaskObservation, insertEvent } = require('./db');
const emitter = require('./emitter');
const { inspectSession, STALE_FACTOR } = require('./sessions');

const UNKNOWN_THRESHOLD = 2;

/**
 * Inspect a marker-backed task.
 * Returns { status: 'running'|'failed'|'unknown_signal' }
 */
function inspectMarker(task) {
  const markerPath = task.observable_id;
  if (!fs.existsSync(markerPath)) {
    return { status: 'unknown_signal', reason: `marker absent: ${markerPath}` };
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return { status: 'unknown_signal', reason: 'marker file not valid JSON' };
  }

  if (marker.status === 'completed') return { status: 'completed' };
  if (marker.status === 'failed') return { status: 'failed' };
  return { status: 'running' };
}

/**
 * Determine whether a notification should be sent given the task's
 * current state and last notification time.
 */
function notificationDue(task, currentStatus) {
  if (!task.last_notification_sent_at) return true;

  const lastSent = new Date(task.last_notification_sent_at).getTime();
  const nowMs = Date.now();
  const intervalMs = task.checkin_every_minutes * 60 * 1000;
  return (nowMs - lastSent) >= intervalMs;
}

/**
 * Run one watchdog cycle.
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.sessionsPath] - override path to sessions.json (for tests)
 * Returns an array of result objects for observability/testing.
 */
function runWatchdog(db, opts = {}) {
  const tasks = getActiveTasks(db);
  const results = [];

  for (const task of tasks) {
    const result = processTask(db, task, opts);
    results.push(result);
  }

  return results;
}

function processTask(db, task, opts = {}) {
  const now = new Date().toISOString();
  let observedStatus;
  let observationNote;

  if (task.observable_type === 'marker') {
    const inspection = inspectMarker(task);
    observedStatus = inspection.status;
    observationNote = inspection.reason || null;
  } else if (task.observable_type === 'session') {
    const inspection = inspectSession(task, { sessionsPath: opts.sessionsPath });
    observedStatus = inspection.status;
    observationNote = inspection.reason || null;
  } else if (task.observable_type === 'manual') {
    // Manual tasks are only updated via CLI resolve; watchdog just checks
    // for elapsed time without an explicit resolution.
    const lastObs = task.last_observed_at ? new Date(task.last_observed_at).getTime() : new Date(task.started_at).getTime();
    const elapsed = Date.now() - lastObs;
    const intervalMs = task.checkin_every_minutes * 60 * 1000;
    observedStatus = elapsed > intervalMs * 2 ? 'unknown_signal' : 'running';
    observationNote = 'manual task';
  } else {
    observedStatus = 'unknown_signal';
    observationNote = `unsupported observable_type: ${task.observable_type}`;
  }

  // Resolve terminal states immediately
  if (observedStatus === 'completed' || observedStatus === 'failed') {
    updateTaskObservation(db, task.id, {
      last_observed_at: now,
      last_observed_status: observedStatus,
      observation_source: task.observable_id,
      resolution_status: observedStatus,
      resolution_at: now,
      unknown_cycle_count: 0
    });
    insertEvent(db, task.id, 'resolution', observedStatus,
      `Task resolved as ${observedStatus}.`);

    // Notify immediately on terminal state
    const msg = emitter.buildMessage(task, observedStatus);
    const emitResult = emitter.sendNotification(task.notify_target, msg);
    insertEvent(db, task.id, 'notification', observedStatus,
      `emitter=${emitResult.success ? 'ok' : 'failed'}: ${emitResult.output}`);

    updateTaskObservation(db, task.id, {
      last_notification_sent_at: now,
      last_notification_status: emitResult.success ? 'sent' : 'failed'
    });

    return { taskId: task.id, observedStatus, notified: true, emitSuccess: emitResult.success };
  }

  if (observedStatus === 'unknown_signal') {
    const newCount = (task.unknown_cycle_count || 0) + 1;
    const effectiveStatus = newCount >= UNKNOWN_THRESHOLD ? 'unknown' : 'stale';

    updateTaskObservation(db, task.id, {
      last_observed_at: now,
      last_observed_status: effectiveStatus,
      observation_source: task.observable_id,
      unknown_cycle_count: newCount
    });
    insertEvent(db, task.id, 'observation', effectiveStatus,
      observationNote || `cycle ${newCount}/${UNKNOWN_THRESHOLD}`);

    if (notificationDue(task, effectiveStatus)) {
      const msg = emitter.buildMessage(task, effectiveStatus);
      const emitResult = emitter.sendNotification(task.notify_target, msg);
      insertEvent(db, task.id, 'notification', effectiveStatus,
        `emitter=${emitResult.success ? 'ok' : 'failed'}: ${emitResult.output}`);
      updateTaskObservation(db, task.id, {
        last_notification_sent_at: now,
        last_notification_status: emitResult.success ? 'sent' : 'failed'
      });
      return { taskId: task.id, observedStatus: effectiveStatus, notified: true, emitSuccess: emitResult.success };
    }

    return { taskId: task.id, observedStatus: effectiveStatus, notified: false };
  }

  // observedStatus === 'running'
  updateTaskObservation(db, task.id, {
    last_observed_at: now,
    last_observed_status: 'running',
    observation_source: task.observable_id,
    unknown_cycle_count: 0
  });
  insertEvent(db, task.id, 'observation', 'running', null);

  if (notificationDue(task, 'running')) {
    const msg = emitter.buildMessage(task, 'running');
    const emitResult = emitter.sendNotification(task.notify_target, msg);
    insertEvent(db, task.id, 'notification', 'running',
      `emitter=${emitResult.success ? 'ok' : 'failed'}: ${emitResult.output}`);
    updateTaskObservation(db, task.id, {
      last_notification_sent_at: now,
      last_notification_status: emitResult.success ? 'sent' : 'failed'
    });
    return { taskId: task.id, observedStatus: 'running', notified: true, emitSuccess: emitResult.success };
  }

  return { taskId: task.id, observedStatus: 'running', notified: false };
}

// When run directly (via cron), open the default DB and run.
if (require.main === module) {
  const db = openDb();
  try {
    const results = runWatchdog(db);
    const ts = new Date().toISOString();
    console.log(`[watchdog] ${ts} processed ${results.length} task(s)`);
    for (const r of results) {
      console.log(`  task=${r.taskId} status=${r.observedStatus} notified=${r.notified} emitOk=${r.emitSuccess ?? 'n/a'}`);
    }
  } finally {
    db.close();
  }
}

module.exports = { runWatchdog, processTask, inspectMarker, notificationDue, UNKNOWN_THRESHOLD, inspectSession, STALE_FACTOR };
