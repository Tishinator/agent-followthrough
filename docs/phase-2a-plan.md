# Agent Follow-Up — Phase 2A Plan

**Date:** 2026-03-13
**Standard:** WORK_STANDARD.md Engineering Provability Standard
**Status:** DRAFT — in progress

---

## Goal

Extend the deterministic watchdog with session-backed observation (`observable_type=session`).
No LLM-driven evaluation in Phase 2A. If LLM-assisted interpretation ever becomes useful, that is a later optional Phase 2B path, and only with a local model (e.g. qwen3.5:9b) — not planned here.

---

## What Phase 1 Delivered

- `observable_type=marker`: JSON file `{"status":"running|completed|failed"}` → deterministic
- `observable_type=manual`: elapsed-time heuristic only; resolved by CLI
- 32 tests passing; OpenClaw cron active every 3m
- **Gap:** No session-backed liveness; tasks spawned via coding-agent/sessions have no first-class observation path

---

## Phase 2A Scope

**In scope:**
- `observable_type=session`: observe an OpenClaw session UUID via `sessions.json`
- New module `src/sessions.js`: reads and parses sessions store deterministically
- `inspectSession()` in `src/watchdog.js`: session observation logic
- CLI update: add `session` to valid `--observable-type` values
- Full unit test coverage for `inspectSession()` with fixture-based tests
- Fix 5 pre-existing failing tests (cli.test.js + concurrency.test.js) that reference a non-existent entry point

**Out of scope (Phase 2B / later):**
- LLM-driven interpretation of session content
- JSONL conversation parsing (too fragile; not deterministic enough for Phase 2A)
- Non-default agent sessions (multi-agent setup); Phase 2A assumes agent `main`
- Automatic `resolve` injection into running agents

---

## Session-Backed Registration Contract

### Registration call

```sh
agent-follow-up register \
  --id my-coding-task \
  --title "Refactor auth module" \
  --target telegram:8625301893 \
  --observable-type session \
  --observable-id <session-uuid> \
  --interval 5 \
  --session <owner-session-uuid>   # optional: the registering session's own UUID
```

### What `observable-id` contains

The **session UUID** (e.g. `c989e785-a605-45ed-8348-f447f3ad13e9`) of the session being watched.
This UUID maps to the `sessionId` field in `sessions.json`.

Alternatively, a full **session key** (e.g. `agent:main:cron:xxx`) can be supplied — the reader supports both.
UUID match is tried first; key match is tried as fallback.

### Stored artifacts (no schema changes)

| DB column | What is stored |
|-----------|---------------|
| `observable_type` | `'session'` |
| `observable_id` | session UUID or session key |
| `observation_source` | path to sessions.json file used (set on first observation) |

No new columns are needed. Existing schema handles this.

---

## How Session Artifacts Are Observed Deterministically

### Sessions store location

Default: `~/.openclaw/agents/main/sessions/sessions.json`
Overridable via `opts.sessionsPath` in watchdog (for test isolation).

### Format of sessions.json (observed 2026-03-13)

```json
{
  "agent:main:<key>": {
    "sessionId": "<uuid>",
    "updatedAt": <epoch-ms>,
    "abortedLastRun": false,
    "kind": "direct",
    ...
  }
}
```

### `inspectSession(task, opts)` logic

```
1. Read sessions.json from opts.sessionsPath or DEFAULT_SESSIONS_PATH
   → fail: return { status: 'unknown_signal', reason: 'sessions.json not readable' }

2. Find entry where entry.sessionId === task.observable_id (UUID match)
   OR where entry key === task.observable_id (key match)
   → not found: return { status: 'unknown_signal', reason: 'session not found' }

3. If entry.abortedLastRun === true
   → return { status: 'failed', reason: 'abortedLastRun=true' }

4. Compute ageMs = Date.now() - entry.updatedAt
   Compute staleThresholdMs = task.checkin_every_minutes * 60 * 1000 * STALE_FACTOR
   (STALE_FACTOR default = 3: session must be silent for 3x the check interval to be stale)

5. If ageMs < staleThresholdMs
   → return { status: 'running', reason: `updated <N>s ago`, updatedAt: entry.updatedAt }

6. Otherwise
   → return { status: 'unknown_signal', reason: `no update for <N>s` }
```

STALE_FACTOR is exported as a constant for test visibility.

---

## Terminal Markers / Stale / Unknown Rules

These rules apply to `observable_type=session` and feed into the existing state machine in `processTask()`:

| Signal | Returned status | Watchdog interpretation |
|--------|-----------------|------------------------|
| sessions.json unreadable | `unknown_signal` | stale/unknown path |
| session UUID absent from store | `unknown_signal` | stale/unknown path |
| `abortedLastRun: true` | `failed` | immediate terminal resolution |
| `updatedAt` within stale threshold | `running` | active observation |
| `updatedAt` beyond stale threshold | `unknown_signal` | stale/unknown path |
| `resolve --status completed` via CLI | `completed` | terminal (same as Phase 1) |

The existing `UNKNOWN_THRESHOLD=2` cycle logic applies unchanged:
- cycle 1 of `unknown_signal` → `stale`
- cycle 2+ → `unknown`

---

## What Is Observed vs Inferred vs Unsupported

### Observed (directly read from files)
- Session present or absent in `sessions.json`
- `abortedLastRun` flag (boolean, directly from store)
- `updatedAt` timestamp (epoch ms, directly from store)

### Inferred (conclusion drawn from evidence)
- "still running" → inferred from `updatedAt` being recent (STALE_FACTOR * interval)
  - Does NOT confirm active work; a long-running tool call won't update `updatedAt` until complete
  - A dormant session that was recently active will also look "running"
- "stale/stopped" → inferred from absence of recent `updatedAt` update

### Unsupported in Phase 2A
- "completed successfully" — no deterministic signal; requires explicit `resolve` via CLI or a companion marker
- Reason for stopping — session observation cannot distinguish intentional completion from silent crash
- Sub-session / delegated activity — only the top-level session key is observed; tool calls in-flight are not visible

### Explicit documentation for users
When registering with `observable_type=session`, add to `--title` or documentation:
> "Session observation can confirm liveness (recent `updatedAt`) and abort detection (`abortedLastRun`),
> but CANNOT confirm successful completion. For reliable completion detection, either:
> (a) call `agent-follow-up resolve --id <task-id> --status completed` from the agent's final step, or
> (b) use `observable_type=marker` with a companion marker file."

---

## Test Strategy

### Unit tests (fast, isolated, fixture-based)

File: `test/watchdog.test.js` (extend existing)

Fixtures: written as inline temp files or in-memory strings
No real `openclaw sessions` calls in unit tests.

Tests for `inspectSession`:

| Test | Fixture | Expected |
|------|---------|----------|
| sessions.json not readable | missing path | `{ status: 'unknown_signal', reason: includes 'readable' }` |
| sessions.json malformed JSON | bad content | `{ status: 'unknown_signal', reason: includes 'parse' }` |
| session UUID absent | store with different sessions | `{ status: 'unknown_signal', reason: includes 'not found' }` |
| session UUID present, recent updatedAt, no abort | fresh timestamp | `{ status: 'running' }` |
| session UUID present, old updatedAt, no abort | stale timestamp | `{ status: 'unknown_signal', reason: includes 'no update' }` |
| session UUID present, abortedLastRun=true | aborted flag set | `{ status: 'failed', reason: includes 'aborted' }` |
| session key match (not UUID) | key match fallback | `{ status: 'running' }` |
| session aborted takes precedence over recency | recent + aborted | `{ status: 'failed' }` |

Tests for `processTask` with session type (integration-level, uses existing watchdog infrastructure):

| Test | Setup | Expected |
|------|-------|----------|
| watchdog observes session task as running | fresh session fixture | task status=running |
| watchdog resolves session task as failed on abort | abortedLastRun=true | task resolved as failed, event logged |
| watchdog transitions session task to stale/unknown | old session fixture | stale→unknown after 2 cycles |

### Integration / fixture tests

- Write a temp `sessions.json` file and point `opts.sessionsPath` at it
- This isolates unit tests from the live OpenClaw sessions store

### Live validation (E2E)

- Register a task with `--observable-type session --observable-id <current-session-uuid>`
- Get a current session UUID from `openclaw sessions --json`
- Run watchdog against real `sessions.json` and verify:
  - Task observed as `running` (session is fresh)
  - Event log shows `observation_source` = path to real sessions.json
- Resolve via CLI and verify `completed`

### Proof strategy

Red→Green test cycle:
1. Write failing tests for `inspectSession` (no implementation yet)
2. Run tests → fail (documented)
3. Implement `inspectSession` in watchdog.js + `src/sessions.js`
4. Run tests → green (documented with actual output)
5. E2E validation with real sessions.json

---

## Pre-existing Failing Tests (Fix Backlog)

5 tests currently fail from work-in-progress Phase 2 API exploration:

| File | Issue | Fix |
|------|-------|-----|
| `test/cli.test.js` (3 tests) | References `bin/agent-follow-up.js` + `init-db` command that don't exist | Update to use `src/cli.js`; remove `init-db` (DB auto-initializes on `openDb()`) |
| `test/concurrency.test.js` (test 4) | Uses `db.init()`, `db.listTasks()`, `db.registerTask()` API not in db.js | Update to use actual `openDb()`, `insertTask()`, `getAllTasks()` API |
| `test/concurrency.test.js` (test 5) | Uses `watchdog.runWatchdog({ dbPath, dryRun: true })` signature | Update to use actual `runWatchdog(db)` with emitter stub |

These do not block Phase 2A implementation but will be fixed as part of this phase to restore a clean baseline.

---

## Unresolved / Open Questions

1. **Multi-agent installs**: `DEFAULT_SESSIONS_PATH` is hardcoded to `~/.openclaw/agents/main/sessions/sessions.json`. If users run multiple agents, they'd need to pass a custom path. Not addressed in Phase 2A — documented as a limitation.

2. **Session eviction**: OpenClaw may evict old sessions from `sessions.json`. The absence of a session is ambiguous (evicted vs. never existed). Phase 2A treats absence as `unknown_signal` (not an error), which feeds into the normal stale/unknown cycle. This is honest but imprecise.

3. **`updatedAt` vs. activity**: A session that's been opened but has a long-running tool call will have a stale `updatedAt` even though work is in progress. STALE_FACTOR=3 mitigates this somewhat but doesn't eliminate false staleness. Documented as a known limitation.

4. **Completion signal**: Phase 2A cannot confirm "completed successfully" from session observation alone. This is a fundamental limitation, not a bug.

---

## Definition of Done for Phase 2A

- [ ] `src/sessions.js` module exists and is covered by unit tests
- [ ] `inspectSession()` implemented in `src/watchdog.js`, exported
- [ ] All 8 `inspectSession` unit tests pass
- [ ] All `processTask` session integration tests pass
- [ ] 5 pre-existing failing tests fixed (clean baseline)
- [ ] CLI accepts `observable-type=session`
- [ ] E2E: register a real session task, watchdog observes it correctly against live `sessions.json`
- [ ] All tests GREEN (total count rises from 32 to ≥ 40)
- [ ] Proof package updated with real execution evidence
