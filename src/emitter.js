'use strict';

const { execSync } = require('child_process');

/**
 * Parse a notify_target string like "telegram:8625301893" into
 * { channel, target }.
 * Also accepts bare numeric/string targets, defaulting channel to "telegram".
 */
function parseTarget(notifyTarget) {
  if (!notifyTarget) throw new Error('notify_target is required');
  const idx = notifyTarget.indexOf(':');
  if (idx > 0) {
    return {
      channel: notifyTarget.slice(0, idx),
      target: notifyTarget.slice(idx + 1)
    };
  }
  return { channel: 'telegram', target: notifyTarget };
}

/**
 * Send a message via openclaw message send.
 * Returns { success: boolean, exitCode: number, output: string }.
 */
function sendNotification(notifyTarget, message, opts = {}) {
  const { channel, target } = parseTarget(notifyTarget);
  const escapedMessage = message.replace(/'/g, "'\\''");
  const cmd = `openclaw message send --channel ${channel} --target ${target} --message '${escapedMessage}'`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: opts.timeoutMs || 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, exitCode: 0, output: output.trim() };
  } catch (err) {
    const exitCode = err.status || 1;
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    return {
      success: false,
      exitCode,
      output: stderr || stdout || err.message
    };
  }
}

/**
 * Format a millisecond duration as "Xh Ym" or "Ym".
 */
function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Build the notification message for a given task and status.
 */
function buildMessage(task, status) {
  const now = new Date().toISOString();
  const interval = task.checkin_every_minutes;

  if (status === 'completed') {
    return `[Agent Follow-Up] Task completed: ${task.title}.\nObserved status: completed.\nCompleted at: ${now}.`;
  }
  if (status === 'failed') {
    return `[Agent Follow-Up] Task failed: ${task.title}.\nObserved status: failed.\nDetected at: ${now}.`;
  }
  if (status === 'unknown') {
    return `[Agent Follow-Up] Task status unknown: ${task.title}.\nObservation source no longer confirms running.\nLast checked: ${now}.\nNext check in: ${interval}m.`;
  }
  if (status === 'stale') {
    return `[Agent Follow-Up] Task stale: ${task.title}.\nNo updates received.\nLast observed: ${task.last_observed_at || 'never'}.\nNext check in: ${interval}m.`;
  }
  if (status === 'checkin') {
    if (task.is_blocked) {
      return `[Agent Follow-Up] [BLOCKED] ${task.title}.\n${task.last_checkin_message}`;
    }
    return `[Agent Follow-Up] Progress: ${task.title}.\n${task.last_checkin_message}`;
  }
  // running — include elapsed time and last checkin context
  const elapsedMs = task.started_at ? (Date.now() - new Date(task.started_at).getTime()) : null;
  const elapsedStr = elapsedMs !== null ? formatDuration(elapsedMs) : 'unknown';

  if (task.is_blocked) {
    const checkinAgeStr = task.last_checkin_at ? formatDuration(Date.now() - new Date(task.last_checkin_at).getTime()) : 'unknown';
    return `[Agent Follow-Up] [BLOCKED] ${task.title}.\nBlocked (${checkinAgeStr} ago): ${task.last_checkin_message}.\nRunning for: ${elapsedStr}. Next check in: ${interval}m.`;
  }

  if (!task.last_checkin_at || !task.last_checkin_message) {
    return `[Agent Follow-Up] Task still running: ${task.title}.\nRunning for: ${elapsedStr}. No progress logged yet.\nNext update cadence: ${interval}m.`;
  }

  const checkinAgeMs = Date.now() - new Date(task.last_checkin_at).getTime();
  const checkinAgeStr = formatDuration(checkinAgeMs);
  return `[Agent Follow-Up] Task still running: ${task.title}.\nRunning for: ${elapsedStr}. Last progress (${checkinAgeStr} ago): ${task.last_checkin_message}.\nNext update cadence: ${interval}m.`;
}

module.exports = { sendNotification, buildMessage, parseTarget, formatDuration };
