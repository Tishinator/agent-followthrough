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
agent-follow-up run-worker --db ./data/tasks.db --id my-task -- node ./worker.js
```

Behavior:
- runs the worker command deterministically
- if the worker exits `0`, the task is auto-resolved as `completed`
- if the worker exits non-zero, the task is left unresolved for explicit handling

This closes the success path without inferring completion from session transcripts or silence.
