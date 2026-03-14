# Agent Follow-Up — Session Completion Contract Draft

**Date:** 2026-03-13
**Status:** Proposed next phase

---

## Problem

Phase 2A can deterministically answer:
- is a watched session recently active?
- did the session abort?

Phase 2A cannot deterministically answer:
- did the work complete successfully?

That is the main remaining product gap for `observable_type=session`.

---

## Recommendation

Do **not** try to infer success from transcript shape, silence, or heuristics.
Use an explicit completion signal.

Preferred order:
1. explicit `resolve` call from the worker/agent at the end of work
2. companion marker file written by the worker/launcher
3. only later, optional heuristic/LLM interpretation as advisory, not authoritative

---

## Proposed Contract

### Registration

Keep Phase 2A registration unchanged:

```sh
agent-follow-up register \
  --id my-task \
  --title "Refactor auth module" \
  --target telegram:8625301893 \
  --observable-type session \
  --observable-id <session-uuid> \
  --interval 5
```

### Completion path A — explicit resolve

The spawned worker/session calls:

```sh
agent-follow-up resolve --id my-task --status completed --message "All requested work finished"
```

Properties:
- deterministic
- low ambiguity
- no schema change required
- works with current model

### Completion path B — companion marker

Optional registration extension in a later phase:

```sh
agent-follow-up register \
  --id my-task \
  --title "Refactor auth module" \
  --target telegram:8625301893 \
  --observable-type session \
  --observable-id <session-uuid> \
  --completion-marker /tmp/my-task.done.json
```

Marker shape:

```json
{
  "status": "completed",
  "updatedAt": "2026-03-13T23:00:00Z",
  "message": "All requested work finished"
}
```

Watchdog precedence:
1. if completion marker says `completed` or `failed`, trust marker terminal state
2. else fall back to session liveness/abort logic

This yields:
- session = liveness
- marker = completion

---

## What Not To Do

Avoid these as authoritative success signals:
- session disappeared from `sessions.json`
- session has been quiet for a long time
- transcript “looks complete”
- last message contains something completion-like

Those may be useful as advisory hints later, but not as proof.

---

## Minimal Next Implementation

If we want the smallest useful next slice, do this:

1. document `resolve` as the required completion path for session tasks
2. teach launcher/integration code to resolve terminal worker exits deterministically
3. add tests proving:
   - session task stays active while running
   - `resolve completed` ends it deterministically
   - `abortedLastRun=true` still resolves as failed
   - `run-worker` exit `0` resolves `completed`
   - `run-worker` non-zero exit resolves `failed` with the exit code recorded in the event message

This gives a complete lifecycle without adding schema complexity.

---

## Suggested Phase Name

- **Phase 2B — Session Completion Contract**

Not:
- transcript intelligence
- heuristic completion guessing
- LLM interpretation first

The core need is lifecycle closure, not more observation ambiguity.
