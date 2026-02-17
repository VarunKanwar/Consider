# Testing Strategy

This document defines the repository-wide testing strategy so implementation and review standards stay consistent across agents, sessions, and contributors.

This strategy is formalized as **Phase 6: Testing hardening** in the project build order.

## Goals

1. Protect the advertised workflow end-to-end:
   - developer adds inline comment in VS Code,
   - agent reads/replies via CLI,
   - reply renders inline,
   - anchors remain correct after file edits.
2. Keep feedback loops fast for daily development.
3. Maintain one explicit quality bar for merge and release decisions.

## Current Test Layers

### Layer 1: CLI + store contract tests (automated, required)

- Location: `test/cli/`
- Scope:
  - store read/write and atomic writes
  - CLI command behavior and error handling
  - reconciliation outcomes and state transitions
- Run with:
  - `npm run test:cli`

### Layer 2: Extension logic tests (automated, required)

- Location: `test/extension/`
- Scope:
  - shared reconciliation parity for extension wrappers
  - setup/integration file generation behavior
- Run with:
  - `npm run test:extension`

### Layer 3: Manual extension UX checks (required for UX-affecting changes)

- Location: `docs/manual-testing.md`
- Scope:
  - comment affordances and thread interactions
  - setup command outcomes
  - file-watcher rendering for agent replies
- Required whenever a change touches extension interaction/UI behavior.

## Gap and Planned Addition

We do **not** yet have a VS Code Extension Host integration-test harness (`@vscode/test-electron` / `@vscode/test-cli`) for command-level end-to-end automation inside a real Extension Development Host.

Planned addition:

1. Add extension-host test runner scaffolding under `extension/`.
2. Add automated scenarios for:
   - setup command full run in fixture workspace,
   - add comment via command path,
   - CLI reply reflected in extension state via store watcher,
   - reconcile behavior after fixture edits.
3. Keep UI click-level automation as optional/nightly smoke tests, not PR gating.

## Merge Gate

Before merging:

1. `npm test` must pass.
2. If extension UX behavior changed, execute relevant checks in `docs/manual-testing.md`.
3. Update `docs/progress.md` for phase-level changes and testing evidence.

## Release Gate

Before a release candidate:

1. Run full manual test guide.
2. Validate setup idempotency (`Feedback: Setup Agent Integration` run multiple times).
3. Validate full loop in a clean workspace:
   - setup,
   - add comment,
   - CLI list/context/reply/resolve,
   - extension renders updates.
