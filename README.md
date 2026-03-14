# Agent Follow-Up

Planning project for a reliable background-task follow-up/check-in system for OpenClaw agents.

This project contains the initial SLC-style planning package for review:

- Software / Program Plan
- Requirements
- Architecture
- Design
- Verification & Validation Plan

Generated review PDFs are placed in `pdf/`.

## CI

This repo uses Gitea Actions with the local `linux` runner.

Current blocking job:
- `node-test` — deterministic unit/integration suite via `npm test`

Non-blocking internal proof:
- live/environment-dependent E2E validation remains a required internal proof step for Larry when appropriate, but is not a merge-blocking CI gate

## Session worker integration

Phase 2B adds a minimal launcher-side seam for session-backed tasks:

```sh
node /home/tish/projects/agent-follow-up/bin/agent-follow-up.js run-worker --db ./data/tasks.db --id my-task -- node ./worker.js
```

Behavior:
- runs the worker command deterministically
- if the worker exits `0`, the task is auto-resolved as `completed` and immediately sends a notification
- if the worker exits non-zero, the task is auto-resolved as `failed`, the event message includes the exit code, and it immediately sends a notification

This closes both terminal paths without inferring completion from session transcripts or silence.

## Canonical watchdog entrypoint

Use the binary entrypoint for operational automation / cron:

```sh
node /home/tish/projects/agent-follow-up/bin/agent-follow-up.js watchdog
```
