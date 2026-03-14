# Phase 2 External Review Notes

**Reviewer:** Claude Code
**Date:** 2026-03-13
**Standard:** agent-follow-up V&V Plan Rev3 (extended for Phase 2)

---

## What Phase 2 Is Expected to Deliver

Based on the Rev3 planning docs, the refactored Phase 1 test files, and the
agent's existing `watchdog.test.js` (which already contains Phase 2 test stubs):

| Feature | Contract |
|---------|----------|
| `db.init(dbPath)` | Creates schema without returning a connection. Idempotent. |
| `db.registerTask(dbPath, opts)` | Path-based insert. Throws on duplicate. |
| `db.listTasks(dbPath)` | Path-based select-all. Returns all tasks including resolved. |
| `db.getTask(dbPath, id)` | Path-based select-one. Returns null for missing. |
| `db.resolveTask(dbPath, id, opts)` | Path-based resolve. Sets resolution_status + resolution_at. |
| `bin/agent-follow-up.js` | New binary entry point replacing direct `src/cli.js` invocation. |
| `init-db` CLI command | Initializes database. Idempotent. Exits 0. |
| `register --observable-type session` | Session-backed task type. |
| `watchdog` CLI command | Runs a watchdog cycle. Accepts `--sessions-path`. Exits 0. |
| `inspectSession(task, { sessionsPath })` | Exported from watchdog.js. Reads sessions JSON file. |
| `STALE_FACTOR` | Exported constant. Positive number. Used as multiplier on checkin_every_minutes. |
| `runWatchdog(db, { sessionsPath })` | Options-based second arg. Passes sessionsPath to inspectSession. |

---

## Sessions Store Format

OpenClaw stores sessions as an object (not array) keyed by a string identifier.
Each entry has:

```json
{
  "agent:main:telegram": {
    "sessionId": "<uuid>",
    "updatedAt": <epoch_ms>,
    "abortedLastRun": false
  }
}
```

`inspectSession` matches `observable_id` against either:
- The `sessionId` field of any entry, OR
- The key string itself

Staleness is determined by: `Date.now() - updatedAt > STALE_FACTOR * checkin_every_minutes * 60_000`

---

## Test File Map

| File | What It Covers | Key Assertions |
|------|----------------|----------------|
| `unit/db-api.test.js` | New path-based db API | init/registerTask/listTasks/getTask/resolveTask exist and behave correctly |
| `unit/session-edge-cases.test.js` | inspectSession edge cases | STALE_FACTOR math, multiple sessions, empty store, missing fields |
| `unit/watchdog-sessions-integration.test.js` | Watchdog + session tasks | Mixed cycles, suppression, emitter failure, result shape, event log |
| `unit/cli-binary.test.js` | bin/agent-follow-up.js | init-db, session register, watchdog command, list with mixed types |
| `e2e/phase2-session-e2e.sh` | Live OpenClaw | Real sessions path, full lifecycle, stale→unknown threshold, cron check |

---

## Key Contracts for the Agent to Implement

### 1. `db.init(dbPath)` — no return value
```js
db.init('/path/to/tasks.db');  // creates schema, enables WAL
db.init('/path/to/tasks.db');  // safe to call again — must not throw
```

### 2. `db.registerTask(dbPath, opts)` — throws on duplicate
```js
db.registerTask(dbPath, {
  id, title, notify_target, observable_type, observable_id,
  checkin_every_minutes  // optional, defaults to 3
});
```

### 3. `db.resolveTask(dbPath, id, opts)`
```js
db.resolveTask(dbPath, 'task-id', { resolution_status: 'completed' });
// sets resolution_status, resolution_at; excludes from getActiveTasks
```

### 4. `inspectSession(task, opts)` — reads sessions file
```js
const { inspectSession, STALE_FACTOR } = require('./src/watchdog');
inspectSession({ observable_id: uuid, checkin_every_minutes: 3 }, { sessionsPath: '/path/to/sessions.json' });
// returns { status: 'running'|'unknown_signal'|'failed', reason?: string, updatedAt?: number }
```

### 5. `runWatchdog(db, opts)` — second arg is options
```js
runWatchdog(db, { sessionsPath: '/path/to/sessions.json' });
```

### 6. `bin/agent-follow-up.js watchdog --db <path> [--sessions-path <path>]`
The `watchdog` subcommand should:
- Accept `--sessions-path` to override the default sessions file location
- Exit 0 and print a summary of processed tasks
- Be suitable for use in OpenClaw cron (replaces `node src/watchdog.js`)

---

## Notes on the `sessions-active.json` Fixture

The `test/external/fixtures/sessions-active.json` fixture has `"updatedAt": 0`
which will always be stale. Tests that need a fresh session must generate the
`updatedAt` timestamp at runtime:

```js
const store = { 'k': { sessionId: uuid, updatedAt: Date.now() - 2000, abortedLastRun: false } };
fs.writeFileSync(sessionsPath, JSON.stringify(store));
```

The fixtures are reference examples for the store format, not intended for
direct use in freshness-sensitive tests.

---

## Residual Risks / Open Questions

1. **Default sessionsPath**: What is the default path the watchdog uses when
   `--sessions-path` is not provided? Likely `~/.openclaw/data/sessions.json`
   or similar. The E2E script probes known locations.

2. **`db.resolveTask` on missing task**: Should it throw or return false/null?
   The CLI test expects exit 1 with an error message — the underlying function
   behavior should be consistent with this.

3. **`sessionId` vs key matching priority**: If `observable_id` matches both
   a `sessionId` in one entry AND the key of another entry, which wins?
   The `session-edge-cases.test.js` has a test for this that accepts either
   outcome but notes it for review.

4. **dryRun mode**: The refactored `concurrency.test.js` calls
   `watchdog.runWatchdog({ dbPath, dryRun: true })` with a path-based API
   (not a db connection). This suggests the watchdog may also grow a
   path-based variant. Not covered in external tests to avoid
   over-constraining the implementation.

---

## How to Run

```bash
# Unit + integration tests (once Phase 2 is implemented)
node --test \
  test/external/unit/db-api.test.js \
  test/external/unit/session-edge-cases.test.js \
  test/external/unit/watchdog-sessions-integration.test.js \
  test/external/unit/cli-binary.test.js

# E2E (requires live OpenClaw environment)
bash test/external/e2e/phase2-session-e2e.sh

# Full suite including Phase 1 tests
node --test test/db.test.js test/emitter.test.js test/watchdog.test.js test/cli.test.js test/concurrency.test.js \
  test/external/unit/db-api.test.js \
  test/external/unit/session-edge-cases.test.js \
  test/external/unit/watchdog-sessions-integration.test.js \
  test/external/unit/cli-binary.test.js
```
