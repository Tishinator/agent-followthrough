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
  updateTaskCheckin,
  insertEvent,
  getTaskEvents
} = require('./db');
const { runWatchdog } = require('./watchdog');
const { runWorkerAndAutoResolve } = require('./worker');
const { summarizeTasks, runDoctor } = require('./observability');
const emitter = require('./emitter');

function sendResolutionNotification(db, task, status, now) {
  const message = emitter.buildMessage(task, status);
  const emitResult = emitter.sendNotification(task.notify_target, message);
  insertEvent(db, task.id, 'notification', status,
    `emitter=${emitResult.success ? 'ok' : 'failed'}: ${emitResult.output}`);
  updateTaskObservation(db, task.id, {
    last_notification_sent_at: now,
    last_notification_status: emitResult.success ? 'sent' : 'failed'
  });
  return emitResult;
}

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
        const emitResult = sendResolutionNotification(db, updated, opts.status, now);
        console.log(`Resolved task '${opts.id}' as ${opts.status}.`);
        console.log(`Completion notification ${emitResult.success ? 'sent' : 'failed'}: ${emitResult.output}`);
        console.log(JSON.stringify(getTask(db, opts.id), null, 2));
      } finally {
        db.close();
      }
    });

  program
    .command('checkin')
    .description('Log a progress milestone for a running task and send a Telegram update')
    .requiredOption('--id <id>', 'Task identifier')
    .requiredOption('--message <msg>', 'Progress note (what was done / what is next)')
    .option('--blocked', 'Mark this task as blocked on the stated issue', false)
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

        const now = new Date().toISOString();
        updateTaskCheckin(db, opts.id, { message: opts.message, timestamp: now, is_blocked: opts.blocked });
        insertEvent(db, opts.id, 'checkin', 'running', opts.message);

        const updated = getTask(db, opts.id);
        const msg = emitter.buildMessage(updated, 'checkin');
        const emitResult = emitter.sendNotification(task.notify_target, msg);
        insertEvent(db, opts.id, 'notification', 'running',
          `emitter=${emitResult.success ? 'ok' : 'failed'}: ${emitResult.output}`);
        updateTaskObservation(db, opts.id, {
          last_notification_sent_at: now,
          last_notification_status: emitResult.success ? 'sent' : 'failed'
        });

        console.log(`Checkin recorded for task '${opts.id}'.`);
        console.log(`Notification ${emitResult.success ? 'sent' : 'failed'}: ${emitResult.output}`);
      } finally {
        db.close();
      }
    });

  program
    .command('run-worker')
    .description('Run a worker command and auto-resolve the task as completed on exit 0 or failed on non-zero exit; both paths send a notification')
    .requiredOption('--id <id>', 'Task identifier')
    .option('--db <path>', 'Override SQLite database path')
    .allowUnknownOption(true)
    .argument('<command>', 'Worker command to execute')
    .argument('[args...]', 'Arguments passed to the worker command')
    .action((command, args, opts) => {
      const db = openDb(opts.db);
      try {
        const result = runWorkerAndAutoResolve(db, opts.id, command, args, {
          cwd: process.cwd(),
          env: process.env
        });

        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);

        if (result.autoResolved) {
          const now = new Date().toISOString();
          const emitResult = sendResolutionNotification(db, result.resolvedTask, result.resolutionStatus, now);
          const exitSummary = result.status === 0 ? 'exit 0' : `exit ${result.status}`;
          console.log(`Auto-resolved task '${opts.id}' as ${result.resolutionStatus} after worker ${exitSummary}.`);
          console.log(`Resolution notification ${emitResult.success ? 'sent' : 'failed'}: ${emitResult.output}`);
        }

        process.exit(result.status ?? 0);
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

  program
    .command('status')
    .description('Show operator-focused task summary')
    .option('--json', 'Output as JSON', false)
    .option('--db <path>', 'Override SQLite database path')
    .action((opts) => {
      const summary = summarizeTasks(opts.db);
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`Agent Follow-Up status`);
      console.log(`DB: ${summary.dbPath}`);
      console.log(`Generated: ${summary.generatedAt}`);
      console.log(`Active tasks: ${summary.activeTaskCount}`);
      console.log(`Resolved tasks: ${summary.resolvedTaskCount}`);

      const states = Object.keys(summary.activeTasksByState).sort();
      if (states.length === 0) {
        console.log('Active by state: none');
      } else {
        console.log('Active by state:');
        for (const state of states) {
          console.log(`  - ${state}: ${summary.activeTasksByState[state]}`);
        }
      }

      console.log('Tasks needing attention:');
      if (summary.tasksNeedingAttention.length === 0) {
        console.log('  - none');
      } else {
        for (const task of summary.tasksNeedingAttention) {
          console.log(`  - ${task.id} (${task.state}) title="${task.title}" notif=${task.last_notification_status || 'none'}`);
        }
      }

      console.log('Recent resolved tasks:');
      if (summary.recentResolvedTasks.length === 0) {
        console.log('  - none');
      } else {
        for (const task of summary.recentResolvedTasks) {
          console.log(`  - ${task.id} [${task.resolution_status}] ${task.title} @ ${task.resolution_at}`);
        }
      }
    });

  program
    .command('doctor')
    .description('Run health and sanity checks for Agent Follow-Up')
    .option('--json', 'Output as JSON', false)
    .option('--db <path>', 'Override SQLite database path')
    .option('--cron-jobs-path <path>', 'Override OpenClaw cron jobs.json path')
    .action((opts) => {
      const report = runDoctor(opts.db, { cronJobsPath: opts.cronJobsPath });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('Agent Follow-Up doctor');
        console.log(`DB: ${report.dbPath}`);
        console.log(`Cron jobs: ${report.cronJobsPath}`);
        for (const check of report.checks) {
          console.log(`  [${check.ok ? 'ok' : 'fail'}] ${check.name}: ${check.details}`);
        }
        if (report.warnings.length === 0) {
          console.log('Warnings: none');
        } else {
          console.log('Warnings:');
          for (const warning of report.warnings) {
            console.log(`  [warn] ${warning.name}: ${warning.details.join(', ')}`);
          }
        }
      }

      if (!report.ok) {
        process.exitCode = 1;
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
