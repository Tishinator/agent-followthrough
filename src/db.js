'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'tasks.db');

/**
 * Open (or create) the SQLite database and apply the schema.
 * Returns the DatabaseSync instance.
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL for better concurrency
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_session_uuid TEXT,
      notify_target TEXT NOT NULL,
      observable_type TEXT NOT NULL,
      observable_id TEXT NOT NULL,
      checkin_every_minutes INTEGER NOT NULL DEFAULT 3,
      started_at TEXT NOT NULL,
      last_observed_at TEXT,
      last_observed_status TEXT,
      observation_source TEXT,
      last_notification_sent_at TEXT,
      last_notification_status TEXT,
      resolution_status TEXT,
      resolution_at TEXT,
      unknown_cycle_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      observed_status TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  return db;
}

/**
 * Insert a new task. Throws if task id already exists.
 */
function insertTask(db, task) {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, title, owner_session_uuid, notify_target,
      observable_type, observable_id, checkin_every_minutes,
      started_at, last_observed_status, unknown_cycle_count
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, 'running', 0
    )
  `);
  stmt.run(
    task.id,
    task.title,
    task.owner_session_uuid || null,
    task.notify_target,
    task.observable_type,
    task.observable_id,
    task.checkin_every_minutes || 3,
    task.started_at || new Date().toISOString()
  );
}

/**
 * Fetch all active (non-resolved) tasks.
 */
function getActiveTasks(db) {
  return db.prepare(
    'SELECT * FROM tasks WHERE resolution_status IS NULL ORDER BY started_at ASC'
  ).all();
}

/**
 * Fetch a single task by id.
 */
function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
}

/**
 * Fetch all tasks (for list command).
 */
function getAllTasks(db) {
  return db.prepare('SELECT * FROM tasks ORDER BY started_at DESC').all();
}

/**
 * Update task observation fields and reset/increment unknown_cycle_count.
 * All updates happen inside a single write.
 */
function updateTaskObservation(db, id, fields) {
  const allowed = [
    'last_observed_at', 'last_observed_status', 'observation_source',
    'last_notification_sent_at', 'last_notification_status',
    'resolution_status', 'resolution_at', 'unknown_cycle_count'
  ];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...vals, id);
}

/**
 * Append a task event row.
 */
function insertEvent(db, taskId, eventType, observedStatus, message) {
  db.prepare(`
    INSERT INTO task_events (task_id, event_type, observed_status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, eventType, observedStatus || null, message || null, new Date().toISOString());
}

/**
 * Fetch events for a task.
 */
function getTaskEvents(db, taskId) {
  return db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC'
  ).all(taskId);
}

module.exports = {
  openDb,
  DEFAULT_DB_PATH,
  insertTask,
  getActiveTasks,
  getTask,
  getAllTasks,
  updateTaskObservation,
  insertEvent,
  getTaskEvents
};
