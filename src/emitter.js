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
  // running / reminder
  return `[Agent Follow-Up] Task still running: ${task.title}.\nObserved status: running.\nLast observed: ${task.last_observed_at || now}.\nNext update cadence: ${interval}m.`;
}

module.exports = { sendNotification, buildMessage, parseTarget };
