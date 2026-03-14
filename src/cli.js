#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const {
  openDb,
  init,
  insertTask,
  getTask,
  getAllTasks,
  getActiveTasks,
  updateTaskObservation,
  insertEvent,
  getTaskEvents
} = require('./db');
const { runWatchdog } = require('./watchdog');

function createProgram() {
  const program = new Command();

  program
    .name('agent-follow-up')
    .description('Proactive task follow-up system for OpenClaw background work')
    .version('1.0.0');

  program
    .command('init-db')
    .description('Initialize the SQLite database schema')
    .option('--db <path>', 'Override SQLite database path')
    .action((opts) => {
      init(opts.db);
      console.log(`Initialized DB: ${opts.db || 'default'}`);
    });

  program
    .command('register')
    .description('Register a new task for follow-up')
    .requiredOption('--id <id>', 'Unique task identifier')
    .requiredOption('--title <title>', 'Human-readable task title')
    .requiredOption('--target <target>', 'Notification target (e.g. telegram:8625301893)')
    .requiredOption('--observable-type <type>', 'Observable type: marker | manual | session')
    .requiredOption('--observable-id <id>', 'Observable ID: path to marker file, label, or session id')
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

        const validTypes = ['marker', 'manual', 'session'];
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

        const registrationMessage = opts.observableType === 'session'
          ? `Registered: type=${opts.observableType} observable=${opts.observableId} target=${opts.target}; completion requires explicit resolve --status completed|failed`
          : `Registered: type=${opts.observableType} observable=${opts.observableId} target=${opts.target}`;

        insertEvent(db, opts.id, 'registered', 'running', registrationMessage);

        const task = getTask(db, opts.id);
        console.log(`Registered task: ${opts.id}`);
        console.log(JSON.stringify(task, null, 2));
        if (opts.observableType === 'session') {
          console.log(`Session completion contract: resolve with \`agent-follow-up resolve --id ${opts.id} --status completed\` when work finishes.`);
        }
      } finally {
        db.close();
      }
    });

  program
    .command('resolve')
    .description('Mark a task as completed or failed (official completion path for session/manual tasks)')
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

  program
    .command('watchdog')
    .description('Run one watchdog cycle')
    .option('--db <path>', 'Override SQLite database path')
    .option('--sessions-path <path>', 'Override sessions.json path')
    .action((opts) => {
      const db = openDb(opts.db);
      try {
        const results = runWatchdog(db, { sessionsPath: opts.sessionsPath });
        const ts = new Date().toISOString();
        console.log(`[watchdog] ${ts} processed ${results.length} task(s)`);
        for (const r of results) {
          console.log(`  task=${r.taskId} status=${r.observedStatus} notified=${r.notified} emitOk=${r.emitSuccess ?? 'n/a'}`);
        }
      } finally {
        db.close();
      }
    });

  return program;
}

function run(argv = process.argv) {
  return createProgram().parse(argv);
}

if (require.main === module) {
  run(process.argv);
}

module.exports = { createProgram, run };
