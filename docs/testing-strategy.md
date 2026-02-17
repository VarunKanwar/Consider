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

### Layer 4: Extension Host integration tests (automated, release/nightly)

- Location: `extension/test/`
- Harness: `@vscode/test-electron` + Mocha
- Scope:
  - setup command scaffolding in fixture workspace
  - add-comment command payload path
  - archive-resolved command workflow
- Run with:
  - `npm run test:extension:host`

Notes:

1. First run may download a VS Code test build from `update.code.visualstudio.com`.
2. In offline environments this suite may fail to launch even if test code is correct.

## Remaining Gaps

1. Click-level UI automation (mouse interactions) is still not part of PR gating.
2. Extension Host scenarios should expand to include watcher-driven reply rendering and reconciliation edit-path assertions.

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
4. Run `npm run test:extension:host` in a network-enabled environment.
