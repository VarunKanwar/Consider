# Testing Strategy

This document defines the repository-wide testing strategy so implementation and review standards stay consistent across agents, sessions, and contributors.

This strategy is formalized across **Phase 6: Testing hardening** and **Phase 10: UI smoke automation** in the project build order.

## Goals

1. Protect the advertised workflow end-to-end:
   - developer adds inline comment in VS Code,
   - agent reads/replies via CLI,
   - reply renders inline,
   - anchors remain correct after file edits.
2. Keep daily feedback cycles fast for development.
3. Maintain one explicit quality bar for merge and release decisions.

## Language Policy

1. Use TypeScript for extension runtime code (`extension/src/**`) and non-host automated tests (`test/**`), compiled with strict mode in `test/tsconfig.json` (with `noImplicitAny` intentionally relaxed for fixture-oriented helpers).
2. Keep CLI/shared runtime code in JavaScript (`cli/**`, `shared/**`) to preserve C5 zero-dependency deploy constraints.
3. Keep Extension Host harness files in JavaScript (`extension/test/**`) to avoid extra transpilation/bootstrap complexity inside the `@vscode/test-electron` launched process.

## Current Test Layers

### Layer 1: CLI + store contract tests (automated, required)

- Location: `test/cli/*.test.ts` (compiled to `test/out/cli/*.test.js`)
- Scope:
  - store read/write and atomic writes
  - CLI command behavior and error handling
  - reconciliation outcomes and state transitions
- Run with:
  - `npm run test:cli`

### Layer 2: Extension logic tests (automated, required)

- Location: `test/extension/*.test.ts` (compiled to `test/out/extension/*.test.js`)
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

### Layer 4: Extension Host integration tests (automated, required in CI)

- Location: `extension/test/`
- Harness: `@vscode/test-electron` + Mocha
- Scope:
  - setup command scaffolding in fixture workspace
  - add-comment command payload path
  - archive-resolved command workflow
- Run with:
  - `npm run test:extension:host`

### Layer 5: UI smoke tests (automated, local/manual gate)

- Location: `extension/test-ui/`
- Harness: `vscode-extension-tester` (Selenium WebDriver over VS Code desktop)
- Scope:
  - guided setup flow (setup webview submit + scaffold verification)
  - add-comment flow via command palette + inline editor thread rendering
  - watcher-driven external CLI reply rendering
  - resolve/unresolve lifecycle across UI and CLI transitions
  - archive resolved + uninstall command workflows
- Run with:
  - `npm run test:extension:ui:smoke`
- CI policy:
  - `ui-smoke` is intentionally not part of push/PR CI gating.
  - Run this suite locally for UI-affecting changes and before release candidates.

Isolation policy:

1. Host tests run against a temporary copy of `extension/test/fixtures/workspace/` (never against tracked fixture files directly).
2. Host tests use temporary VS Code `--user-data-dir` and `--extensions-dir` paths per run.
3. Temporary host-test directories are cleaned up after each run.
4. UI smoke runs against a copied fixture workspace plus a dedicated extensions directory (`extension/test-ui/.cache/extensions`) so user-installed extensions do not affect results.

Notes:

1. First run may download a VS Code test build from `update.code.visualstudio.com`.
2. In offline environments this suite may fail to launch even if test code is correct.
3. UI smoke first run also downloads ChromeDriver via `vscode-extension-tester`; use prewarmed caches or a network-enabled environment.
4. UI smoke uses persistent cache directory `extension/test-ui/.cache` to avoid repeated VS Code/ChromeDriver downloads.

## Remaining Gaps

1. UI smoke covers the primary lifecycle paths, but should still expand incrementally for additional high-risk UX interactions (filter toggles, comments panel edge cases, and heavy reconciliation edit flows).
2. Extension Host scenarios should expand to include watcher-driven reply rendering and reconciliation edit-path assertions.
3. Known upstream/editor limitations are tracked in `docs/known-limitations.md` and should be treated as non-regressions unless the upstream behavior changes.

## Merge Gate

Before merging:

1. Required GitHub status checks `CI / fast-tests` and `CI / host-integration` must pass.
2. `npm test` must pass locally before opening/updating PR.
3. If extension UX behavior changed, execute relevant checks in `docs/manual-testing.md`.
4. If extension UX behavior changed, run `npm run test:extension:ui:smoke` locally in a network-enabled environment.
5. Update `docs/progress.md` for phase-level changes and testing evidence.

## Branch Protection

Protect `main` with:

1. Require a pull request before merging.
2. Require status checks to pass before merging: `CI / fast-tests`, `CI / host-integration`.
3. Require branches to be up to date before merging.
4. Require at least one approving review.

Note: GitHub branch protection availability depends on repository visibility/plan. Keep `CI / fast-tests` configured regardless, and enable protection as soon as the repository supports it.

## Release Gate

Before a release candidate:

1. Run full manual test guide.
2. Validate setup idempotency (`Consider: Setup` run multiple times).
3. Validate full loop in a clean workspace:
   - setup,
   - add comment,
   - CLI list/context/reply/resolve/unresolve (including workflow+anchor filters),
   - extension renders updates.
4. Run `npm run test:extension:host` in a network-enabled environment.
5. Run `npm run test:extension:ui:smoke` in a network-enabled environment.
