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

Current jobs:
- `node-test` — unit/integration suite
- `e2e-smoke` — end-to-end validation script (`test/e2e.sh --skip-restart`)
