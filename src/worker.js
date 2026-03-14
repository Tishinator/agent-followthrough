'use strict';

const { spawnSync } = require('node:child_process');
const { getTask, updateTaskObservation, insertEvent } = require('./db');

function resolveTaskForWorkerSuccess(db, taskId, opts = {}) {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`task '${taskId}' not found`);
  }
  if (task.resolution_status) {
    throw new Error(`task '${taskId}' is already resolved as '${task.resolution_status}'`);
  }

  const now = new Date().toISOString();
  const message = opts.message || 'Task resolved as completed via worker success.';

  updateTaskObservation(db, taskId, {
    resolution_status: 'completed',
    resolution_at: now,
    last_observed_at: now,
    last_observed_status: 'completed'
  });
  insertEvent(db, taskId, 'resolved', 'completed', message);

  return getTask(db, taskId);
}

function runWorkerAndAutoResolve(db, taskId, command, args = [], opts = {}) {
  if (!command) {
    throw new Error('worker command is required');
  }

  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const resolvedTask = resolveTaskForWorkerSuccess(db, taskId, {
      message: opts.resolveMessage || `Task resolved as completed via worker success: ${command}`
    });
    return { ...result, autoResolved: true, resolvedTask };
  }

  return { ...result, autoResolved: false };
}

module.exports = { runWorkerAndAutoResolve, resolveTaskForWorkerSuccess };
