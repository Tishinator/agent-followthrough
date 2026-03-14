# Agent Follow-Up — Agent Integration Guide

**Purpose:** how an OpenClaw agent should use Agent Follow-Up correctly without reading the source.

---

## Choose the right pattern

Use one of these three patterns depending on what kind of work you are tracking.

### 1. Marker-backed task
Use when your process can write a JSON marker file.

Best for:
- scripts
- builds
- jobs that can explicitly write `running/completed/failed`

Register:

```sh
agent-follow-up register \
  --id my-task \
  --title "Build release artifacts" \
  --target telegram:8625301893 \
  --observable-type marker \
  --observable-id /tmp/my-task.marker.json \
  --interval 3
```

Marker file shape:

```json
{"status":"running"}
```

Later:

```json
{"status":"completed","updatedAt":"2026-03-14T14:00:00Z"}
```

Important:
- `status` is the authoritative field the watchdog reads
- extra fields like `updatedAt` are optional metadata for humans/other tools
- the watchdog does **not** currently interpret `updatedAt` for marker tasks

Use this when you want the watchdog to infer progress and terminal state directly from a deterministic artifact.

---

### 2. Session-backed task
Use when the work is happening in an OpenClaw session and you want liveness/abort observation.

Best for:
- long-running agent work
- coding sessions
- delegated session tasks

Register:

```sh
agent-follow-up register \
  --id my-session-task \
  --title "Refactor auth module" \
  --target telegram:8625301893 \
  --observable-type session \
  --observable-id <session-uuid> \
  --interval 5
```

Important:
- session observation can confirm recent activity
- session observation can detect aborts
- session observation **cannot** prove successful completion by itself

To finish successfully, use either:
- explicit `resolve`
- or `run-worker` if the work is being wrapped as a command

---

### 3. run-worker wrapper
Use when you want the command exit code itself to close the lifecycle.

Best for:
- deterministic command-based work
- agents launching a concrete worker process
- when exit status should define success/failure

Run:

```sh
agent-follow-up run-worker --id my-task -- <command> [args...]
```

Behavior:
- exit `0` -> resolves task as `completed` and sends notification
- non-zero exit -> resolves task as `failed`, includes exit code in event message, and sends notification

Example:

```sh
node /home/tish/projects/agent-follow-up/bin/agent-follow-up.js run-worker \
  --db ./data/tasks.db \
  --id my-task \
  -- sh -c 'npm test'
```

This is the preferred path when the worker command itself is the authoritative success/failure signal.

---

## Recommended defaults

- If a job can write a marker file reliably -> use **marker**
- If a task is fundamentally tied to an OpenClaw session -> use **session**
- If you are launching a concrete command and trust its exit code -> use **run-worker**

---

## Canonical watchdog command

For cron / operational automation use:

```sh
node /home/tish/projects/agent-follow-up/bin/agent-follow-up.js watchdog
```

---

## Operator expectations

- terminal paths should notify the user
- resolved tasks should drop out of the active set
- unresolved stale/unknown tasks need operator attention
- deterministic signals are preferred over transcript inference
