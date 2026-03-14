# External Test Area

This directory is for externally authored challenge/review tests (for example, Claude Code).

Purpose:
- keep external tests separate from the primary project-owned test suite
- allow review and promotion of useful tests into the main suite later
- preserve fixtures and notes used during external validation

Suggested layout:
- `unit/` — unit/integration-style external tests
- `e2e/` — end-to-end external tests/scripts
- `fixtures/` — external test fixtures
- `notes/` — reviewer notes, expectations, or execution guidance

Promotion rule:
- external tests should not be treated as canonical project tests until reviewed and intentionally integrated
