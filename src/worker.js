'use strict';

const { spawnSync } = require('node:child_process');
const { getTask, updateTaskObservation, insertEvent } = require('./db');

function resolveTaskForWorkerExit(db, taskId, status, opts = {}) {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`task '${taskId}' not found`);
  }
  if (task.resolution_status) {
    throw new Error(`task '${taskId}' is already resolved as '${task.resolution_status}'`);
  }

  const now = new Date().toISOString();
  const message = opts.message || `Task resolved as ${status} via worker exit.`;

  updateTaskObservation(db, taskId, {
    resolution_status: status,
    resolution_at: now,
    last_observed_at: now,
    last_observed_status: status
  });
  insertEvent(db, taskId, 'resolved', status, message);

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

  const status = result.status === 0 ? 'completed' : 'failed';
  const exitCode = result.status ?? 'null';
  const defaultMessage = status === 'completed'
    ? `Task resolved as completed via worker exit 0: ${command}`
    : `Task resolved as failed via worker exit ${exitCode}: ${command}`;

  const resolvedTask = resolveTaskForWorkerExit(db, taskId, status, {
    message: opts.resolveMessage || defaultMessage
  });

  return { ...result, autoResolved: true, resolutionStatus: status, resolvedTask };
}

module.exports = { runWorkerAndAutoResolve, resolveTaskForWorkerExit };
