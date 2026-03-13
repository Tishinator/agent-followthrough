#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { openDb, insertTask, getTask, getAllTasks, getActiveTasks,
        updateTaskObservation, insertEvent, getTaskEvents } = require('./db');

const program = new Command();

program
  .name('agent-follow-up')
  .description('Proactive task follow-up system for OpenClaw background work')
  .version('1.0.0');

// ─── register ────────────────────────────────────────────────────────────────
program
  .command('register')
  .description('Register a new task for follow-up')
  .requiredOption('--id <id>', 'Unique task identifier')
  .requiredOption('--title <title>', 'Human-readable task title')
  .requiredOption('--target <target>', 'Notification target (e.g. telegram:8625301893)')
  .requiredOption('--observable-type <type>', 'Observable type: marker | manual')
  .requiredOption('--observable-id <id>', 'Observable ID: path to marker file or label')
  .option('--interval <minutes>', 'Check-in interval in minutes', '3')
  .option('--session <uuid>', 'Owner session UUID')
  .option('--db <path>', 'Override SQLite database path')
  .action((opts) => {
    const db = openDb(opts.db);
    try {
      const existing = getTask(db, opts.id);
      if (existing) {
        console.error(`Error: task id '${opts.id}' already registered.`);
        process.exit(1);
      }

      const interval = parseInt(opts.interval, 10);
      if (isNaN(interval) || interval < 1) {
        console.error('Error: --interval must be a positive integer (minutes).');
        process.exit(1);
      }

      const validTypes = ['marker', 'manual'];
      if (!validTypes.includes(opts.observableType)) {
        console.error(`Error: --observable-type must be one of: ${validTypes.join(', ')}`);
        process.exit(1);
      }

      insertTask(db, {
        id: opts.id,
        title: opts.title,
        notify_target: opts.target,
        observable_type: opts.observableType,
        observable_id: opts.observableId,
        checkin_every_minutes: interval,
        owner_session_uuid: opts.session || null
      });

      insertEvent(db, opts.id, 'registered', 'running',
        `Registered: type=${opts.observableType} observable=${opts.observableId} target=${opts.target}`);

      const task = getTask(db, opts.id);
      console.log(`Registered task: ${opts.id}`);
      console.log(JSON.stringify(task, null, 2));
    } finally {
      db.close();
    }
  });

// ─── resolve ─────────────────────────────────────────────────────────────────
program
  .command('resolve')
  .description('Mark a task as completed or failed')
  .requiredOption('--id <id>', 'Task identifier')
  .requiredOption('--status <status>', 'Resolution status: completed | failed')
  .option('--message <msg>', 'Optional resolution message')
  .option('--db <path>', 'Override SQLite database path')
  .action((opts) => {
    const db = openDb(opts.db);
    try {
      const task = getTask(db, opts.id);
      if (!task) {
        console.error(`Error: task '${opts.id}' not found.`);
        process.exit(1);
      }
      if (task.resolution_status) {
        console.error(`Error: task '${opts.id}' is already resolved as '${task.resolution_status}'.`);
        process.exit(1);
      }

      const validStatuses = ['completed', 'failed'];
      if (!validStatuses.includes(opts.status)) {
        console.error(`Error: --status must be one of: ${validStatuses.join(', ')}`);
        process.exit(1);
      }

      const now = new Date().toISOString();
      updateTaskObservation(db, opts.id, {
        resolution_status: opts.status,
        resolution_at: now,
        last_observed_at: now,
        last_observed_status: opts.status
      });
      insertEvent(db, opts.id, 'resolved', opts.status,
        opts.message || `Task resolved as ${opts.status} via CLI.`);

      const updated = getTask(db, opts.id);
      console.log(`Resolved task '${opts.id}' as ${opts.status}.`);
      console.log(JSON.stringify(updated, null, 2));
    } finally {
      db.close();
    }
  });

// ─── list ─────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List tasks')
  .option('--active', 'Show only active (unresolved) tasks', false)
  .option('--json', 'Output as JSON', false)
  .option('--db <path>', 'Override SQLite database path')
  .action((opts) => {
    const db = openDb(opts.db);
    try {
      const tasks = opts.active ? getActiveTasks(db) : getAllTasks(db);
      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }
        for (const t of tasks) {
          const resolved = t.resolution_status ? ` [${t.resolution_status}]` : '';
          const status = t.last_observed_status || 'unknown';
          console.log(`${t.id}${resolved}  title="${t.title}"  status=${status}  target=${t.notify_target}  type=${t.observable_type}`);
        }
      }
    } finally {
      db.close();
    }
  });

// ─── events ──────────────────────────────────────────────────────────────────
program
  .command('events')
  .description('Show event log for a task')
  .requiredOption('--id <id>', 'Task identifier')
  .option('--json', 'Output as JSON', false)
  .option('--db <path>', 'Override SQLite database path')
  .action((opts) => {
    const db = openDb(opts.db);
    try {
      const task = getTask(db, opts.id);
      if (!task) {
        console.error(`Error: task '${opts.id}' not found.`);
        process.exit(1);
      }
      const events = getTaskEvents(db, opts.id);
      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
      } else {
        for (const e of events) {
          console.log(`${e.created_at}  [${e.event_type}]  status=${e.observed_status || '-'}  ${e.message || ''}`);
        }
      }
    } finally {
      db.close();
    }
  });

program.parse(process.argv);
