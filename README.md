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
