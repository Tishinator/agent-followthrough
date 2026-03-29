# agent-followthrough

Proactive task follow-up system for OpenClaw agents, backed by SQLite and cron.

Agents register tasks before launching background work. A watchdog runs on a cron schedule, checks observable state (marker files, session transcripts, or manual signals), and sends Telegram notifications when tasks go stale, complete, or fail. Workers can auto-resolve tasks on exit via `run-worker`.

**Requires Node.js ≥ 22.5.0** (uses `node:sqlite`).

## Install

```sh
npm install
node bin/agent-follow-up.js init-db
```

The default database path is `./data/tasks.db`. All commands accept `--db <path>` to override.

## Commands

### `register`
Register a new task for follow-up.

```sh
agent-follow-up register \
  --id <id> \
  --title <title> \
  --target telegram:<chat-id> \
  --observable-type marker|session|manual \
  --observable-id <path-or-id> \
  [--interval <minutes>]   # default: 3
  [--session <uuid>]
```

### `resolve`
Mark a task as completed or failed.

```sh
agent-follow-up resolve --id <id> --status completed|failed [--message <msg>]
```

### `checkin`
Log a progress milestone for a running task and send a Telegram update.

```sh
agent-follow-up checkin --id <id> --message <msg> [--blocked]
```

### `run-worker`
Run a worker subprocess and auto-resolve the task on exit.

```sh
agent-follow-up run-worker --id <id> -- <command> [args...]
```

- Exit 0 → resolved as `completed`, notification sent
- Non-zero exit → resolved as `failed`, exit code included in notification

### `watchdog`
Run one watchdog cycle. Intended to be called by cron.

```sh
agent-follow-up watchdog [--sessions-path <path>]
```

Checks all active tasks against their observable state and sends notifications for stale, completed, or failed tasks.

### `status`
Show a human-readable or JSON summary of active and recently resolved tasks.

```sh
agent-follow-up status [--json]
```

### `doctor`
Run health and sanity checks: DB reachability, OpenClaw cron registration, watchdog payload alignment, and stale/unknown task warnings.

```sh
agent-follow-up doctor [--json] [--cron-jobs-path <path>]
```

### `list`
List tasks.

```sh
agent-follow-up list [--active] [--json]
```

### `events`
Show the event log for a task.

```sh
agent-follow-up events --id <id> [--json]
```

## Observable types

| Type | `--observable-id` | How watchdog checks it |
|---|---|---|
| `marker` | Path to a marker JSON file | Reads `status` field from file |
| `session` | Claude session UUID | Inspects `sessions.json` for activity |
| `manual` | Arbitrary label | Never auto-resolves; relies on `resolve` or `checkin` |

## CI

GitHub Actions runs the full test suite on push to `master` and on pull requests.
