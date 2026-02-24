# Progress Log

## Phase 1: Store Format + CLI Skeleton

**Status:** Complete

### What was built

1. **Shared store module** (`shared/store.js`)
   - `readStore(projectRoot)` — reads `.consider/store.json`, returns empty store if absent.
   - `writeStore(projectRoot, store)` — atomic write via temp file + rename.
   - `findProjectRoot(startDir)` — walks up directory tree looking for `.consider/`.
   - `generateCommentId()` / `generateReplyId()` — `c_` / `r_` prefix + 8 random hex chars.
   - `findComment(store, id)` — lookup by comment ID.

2. **CLI tool** (`cli/consider-cli.js` + `cli/consider-cli` shell wrapper)
   - `list [--status <s>] [--file <path>] [--json]` — lists comments filtered by status (default: open) and file path prefix.
   - `get <id> [--json]` — shows a comment with its full thread.
   - `reply <id> --message "..."` — adds a reply as `author: "agent"`.
   - `resolve <id>` — sets status to `resolved`.
   - `summary [--json]` — shows open count, file count, and breakdown by status.
   - `context <id> [--lines N] [--json]` — shows the comment with surrounding code from the actual file, target lines marked with `>>>`.

3. **Automated tests** (`test/cli/store.test.ts`, `test/cli/cli.test.ts`)
   - 39 tests covering all commands, flags, edge cases (empty store, missing IDs, orphaned comments, nonexistent files).
   - Uses `node:test` and `node:assert` — no dependencies.

4. **Project scaffolding**
   - `package.json` with `npm test` / `npm run test:cli` scripts.
   - `CLAUDE.md` symlinked to `AGENTS.md`.
   - Directory structure: `cli/`, `shared/`, `test/cli/`, `extension/src/`.

### Implementation decisions not in the spec

- **File path filtering uses prefix match:** `--file src/auth/` matches all files under that directory. This supports both exact file paths and directory-level filtering.
- **`--lines` flag on `context`:** Defaults to 10 lines of context before/after the target range. Configurable per invocation.
- **`summary` includes breakdown:** Beyond the spec's "N open comments across M files," the summary also shows a count-by-status breakdown and lists files with open comments.
- **Truncation in `list`:** Comment bodies are truncated to 80 chars in the `list` output for readability.

### What's known to be incomplete

- **No reconciliation** — Phase 1 uses static line numbers. The re-anchoring algorithm is deferred to Phase 3.
- **No extension** — Phase 2.
- **No agent setup command** — Phase 4.
- **`context` command does not verify anchor accuracy** — it reads the stored line numbers directly. Once Phase 3 adds reconciliation, `context` will reconcile before showing output.

---

## Phase 2: Extension Skeleton

**Status:** Complete

### What was built

1. **Extension scaffolding** (`extension/`)
   - `package.json` manifest with VS Code engine `^1.82.0`, all command registrations, and `menus` contributions for Comments API actions.
   - `tsconfig.json` with strict mode, ES2020 target.
   - `.vscode/launch.json` for F5 debugging.
   - Dev dependencies: `@types/vscode`, `@types/node`, `typescript`.

2. **TypeScript store adapter** (`extension/src/store.ts`)
   - Full TypeScript re-implementation of the store read/write logic from `shared/store.js`.
   - Defines all data model types: `FeedbackComment`, `Reply`, `Anchor`, `FeedbackStore`, `CommentStatus`.
   - Same atomic write pattern (temp file + rename), same JSON schema.

3. **Extension controller** (`extension/src/extension.ts`)
   - `CommentController` with `CommentingRangeProvider` — all lines in all files are commentable.
   - **Add Comment** — creates a comment thread at the cursor/selection, saves to store with anchor data (startLine, endLine, contextBefore, contextAfter, targetContent).
   - **Reply** — adds a reply to an existing thread, persists to store.
   - **Resolve/Unresolve** — toggles comment status between `open` and `resolved`, updates both the store and the visual thread state.
   - **Delete** — removes a root comment (entire thread) or a single reply.
   - **File watcher** — watches `.consider/store.json` for changes. When the agent writes a reply via CLI, the store changes, and the extension re-renders affected threads. Agent replies appear inline with "Agent" author label.
   - **Startup load** — reads all comments from the store on activation and creates visual threads.
   - **Watcher suppression** — the extension suppresses its own file watcher during writes to avoid re-reading its own changes.
   - **Graceful no-workspace handling** — if no workspace folder is open, commands show a warning message.
   - **Phase 3/4/5 stubs** — Reconcile All, Setup (basic), Show All Comments, and Archive Resolved are registered as commands with placeholder behavior.

4. **Manual testing guide** (`docs/manual-testing.md`)
   - 12 step-by-step test scenarios covering: extension launch, add/reply/resolve/delete comments, agent reply via CLI (bidirectional communication), startup load, multi-file, and no-workspace edge case.

### Implementation decisions not in the spec

- **Author display:** "Developer" for human author, "Agent" for agent author. No icon paths (the VS Code CommentAuthorInformation `iconPath` field requires a `Uri`, not a `ThemeIcon`, so we omit it for simplicity — author names are sufficient for distinguishing).
- **Context capture on comment creation:** 2 lines of context before/after are captured at comment creation time. This will feed into the Phase 3 re-anchoring algorithm.
- **Watcher suppression timeout:** 500ms timeout after writing to store before re-enabling the file watcher. This prevents spurious re-reads from our own writes while still catching agent writes that arrive shortly after.
- **Comment thread `contextValue`:** Used to control menu visibility. Open threads show "Resolve", resolved threads show "Reopen". Format: `consider-thread-<status>`.
- **Store adapter is a separate TypeScript file,** not a direct import of `shared/store.js`. This keeps the extension's TypeScript strict mode working and avoids require-path issues at runtime. Both implementations follow the same schema and must stay in sync.

### What was tested

- Extension compiles cleanly with `tsc` in strict mode.
- All 39 Phase 1 CLI tests still pass.
- Manual testing guide provided for all extension features.

### What's known to be incomplete

- **No reconciliation** — Phase 3. Comments use static line numbers.
- **No agent setup command** — Phase 4. Current stub only creates `.consider/` directory.
- **No tree view panel** — Phase 5.
- **No archive resolved** — Phase 5.
- **Extension unit tests** — the VS Code Comments API cannot be unit-tested outside the extension host. Pure store logic is tested via the CLI tests. Extension behavior is covered by the manual testing guide.

---

## Phase 3: Content-Based Anchoring

**Status:** Complete

### What was built

1. **Shared reconciliation core** (`shared/reconcile.js`)
   - Added content-based re-anchoring algorithm shared by CLI and extension.
   - Implemented the required fallback chain:
     - fast-path match at stored line range,
     - exact `targetContent` search (unique match only),
     - fuzzy matching with `contextBefore`/`contextAfter` + target similarity + proximity.
   - Added staleness/orphan handling for open comments:
     - `open -> stale` when no confident match,
     - `open -> orphaned` when file is missing.
   - Added mtime-gated checks via `anchor.lastAnchorCheck` so unchanged files are skipped.
   - Added anchor snapshot refresh on successful re-anchor (`startLine`, `endLine`, contexts, `targetContent`, `contentHash`, `lastAnchorCheck`).

2. **CLI lazy reconciliation on reads** (`cli/consider-cli.js`)
   - Read commands now reconcile before returning output:
     - `list`
     - `get`
     - `summary`
     - `context`
   - If reconciliation mutates comments, CLI persists the updated store atomically before rendering output.
   - `context` now correctly fails for comments that became orphaned during reconciliation in that same invocation.

3. **Extension reconciliation wiring** (`extension/src/extension.ts`, `extension/src/reconcile.ts`)
   - Added extension wrapper module over shared reconciliation to keep behavior aligned with CLI.
   - Implemented `Consider: Reconcile All` command using `force` reconciliation.
   - Implemented automatic file-scoped reconciliation triggers:
     - on file open,
     - on save,
     - on document changes (debounced).
   - For active editing, added thread-range persistence back to store (updates line range + anchor snapshot for open comments).
   - Added consistent thread presentation updates (status-driven labels/context values) for open/resolved/stale/orphaned states.

4. **Automated Phase 3 tests**
   - Added reconciliation scenario tests (`test/cli/reconcile.test.ts`) covering:
     - insertion above target,
     - content changes requiring fuzzy match,
     - stale detection,
     - orphan detection,
     - force-based stale reopening.
   - Added extension parity tests (`test/extension/reconcile.test.ts`) comparing shared vs extension reconciliation outputs for the same fixtures.
   - Updated root scripts (`package.json`) to run CLI + extension test suites:
     - `npm test`
     - `npm run test:cli`
     - `npm run test:extension`

### What was tested

- `npm run test:cli` (all CLI + store + reconciliation tests pass)
- `npm run test:extension` (extension compile + reconciliation parity tests pass)
- `npm test` (full combined run passes)

### Implementation decisions not in the spec

- **Shared implementation chosen:** reconciler lives in `shared/reconcile.js` and is called by both CLI and extension to eliminate drift.
- **Status transition scope:** automatic reconciliation changes status only for non-resolved comments. Resolved comments are not auto-transitioned to stale/orphaned.
- **Auto vs force behavior:** non-force reconciliation processes only `open` comments; force mode (used by `Reconcile All`) includes stale/orphaned and can reopen them to `open` on a confident match.
- **Fuzzy scoring:** weighted score uses context match, target-content similarity, and proximity to prior anchor with a threshold + ambiguity guard.
- **Active editing strategy in extension:** document-change handling is debounced and persists VS Code thread range movement back to store so anchors stay aligned while typing.

### What's known to be incomplete

- **Manual stale/orphan re-anchor UX** in extension is still minimal (no dedicated interactive re-anchor flow yet; only force reconcile and automatic open-file updates exist).
- **Phase 4 items remain:** full Setup (CLI deployment + skill generation).
- **Phase 5 items remain:** tree view, archive-resolved workflow, and polish UX.

---

## Phase 4: Agent Integration Setup

**Status:** Complete

### What was built

1. **Setup module for agent integration** (`extension/src/setup.ts`)
   - Added `runSetupAgentIntegration(projectRoot, { cliSourceDir })` as the Phase 4 implementation core.
   - Creates `.consider/` and `.consider/bin/` if missing.
   - Creates `.consider/store.json` if missing (using existing atomic store write path).
   - Copies CLI artifacts into project-local deploy target:
     - `.consider/bin/consider-cli`
     - `.consider/bin/consider-cli.js`
   - Ensures shell wrapper remains executable (`chmod 755`).
   - Updates `.gitignore` with `.consider/` exactly once (no duplicates).
   - Detects agent footprints and installs integrations per spec behavior:
     - Claude Code skill: `.claude/skills/consider/SKILL.md`
     - OpenCode skill: `.opencode/skills/consider/SKILL.md`
     - Codex skill: `.codex/skills/consider/SKILL.md`.

2. **Extension command wiring** (`extension/src/extension.ts`)
   - Replaced Setup command stub with full setup execution.
   - Setup command now reports an actionable summary (CLI deployed, gitignore updated, skills written).
   - Added explicit error handling with clear surfaced message if setup fails.

3. **Skill-file idempotency handling**
   - Setup rewrites target skill files in place; reruns do not create duplicate files.
   - `.gitignore` entry insertion remains duplicate-safe.

4. **Phase 4 test coverage** (`test/extension/setup.test.ts`)
   - Added automated tests for setup behavior in four scenarios:
     - detected agents present,
     - no agents detected,
     - partial detection behavior,
     - idempotency for `.gitignore` and skill files.

5. **Manual testing guide updates** (`docs/manual-testing.md`)
   - Updated setup expectations to reflect full Phase 4 behavior.
   - Switched CLI invocation examples to deployed wrapper (`.consider/bin/consider-cli`).
   - Added explicit idempotency manual test.

### What was tested

- `npm run compile`
- `npm run test:extension` (includes setup tests and reconciliation parity tests)
- `npm test` (full CLI + extension suites)
- Manual sanity checks during development:
  - setup command activation from Command Palette,
  - comment gutter availability on startup,
  - add-comment from Command Palette,
  - default collapsed thread presentation.

### Implementation decisions not in the spec

- **Codex integration is skills-based:** setup writes a Codex skill at `.codex/skills/consider/SKILL.md` rather than mutating repo instruction files.
- **Footprint detection spans workspace and home:** setup detection checks `.claude/`, `.opencode/`, and `.codex/` in both workspace and home; `.agents/` is still detected as legacy footprint compatibility.
- **Skill content is shared structure with agent-specific label:** Claude/OpenCode/Codex skill files share core command/convention text, with only installed-for labeling varied.
- **Setup logic extracted from extension controller:** pure setup behavior lives in `setup.ts` to enable reliable automated tests outside extension host.

### What's known to be incomplete

- **Phase 5 items remain:** tree view panel, archive resolved workflow, visual polish, and richer stale/orphan management UX.
- **Phase 6 items remain:** Extension Host integration-test harness and command-level end-to-end automation strategy.
- **Skill lifecycle management is basic:** setup can be rerun manually, but extension update-time skill versioning/regeneration policy is not yet implemented.

---

## Phase 5: Polish

**Status:** Complete

### What was built

1. **Comments tree view panel** (`extension/package.json`, `extension/src/extension.ts`, `extension/src/tree-data.ts`)
   - Added Explorer view contribution: `Consider Comments`.
   - Implemented grouped-by-file tree data with status filtering (`all/open/resolved/stale/orphaned`).
   - Implemented `Consider: Show All Comments` command flow:
     - prompts for status filter,
     - updates tree provider filter,
     - focuses the comments view.
   - Tree comment items open and reveal their anchored location in editor.

2. **Archive resolved workflow** (`extension/src/archive.ts`, `extension/src/extension.ts`)
   - Implemented `Consider: Archive Resolved`.
   - Resolved comments are moved from active `.consider/store.json` into `.consider/archive.json`.
   - Archive writes use atomic temp-file + rename.
   - Re-running archive with no resolved comments returns a no-op message.

3. **Visual refinements**
   - Threads default to collapsed on create/load.
   - Tree items include status-sensitive icons and concise metadata (`status • id`).

4. **Manual testing updates** (`docs/manual-testing.md`)
   - Added dedicated tests for:
     - comments tree view behavior,
     - archive resolved behavior.
   - Renumbered and expanded the manual checklist to 15 scenarios.

5. **Automated tests for new pure logic**
   - `test/extension/archive.test.ts` for archive behavior and idempotency.
   - `test/extension/tree-data.test.ts` for filter/group/sort behavior in the tree data model.

### What was tested

- `npm run compile`
- `npm run test:extension` (archive + setup + reconciliation parity + tree data tests)
- `npm test` (full CLI + extension suite)

### Implementation decisions not in the spec

- **Archive file format:** `.consider/archive.json` stores records as `{ archivedAt, comment }` to preserve audit history and timestamp of archival.
- **Tree view filtering UX:** filter is selected via `Consider: Show All Comments` command rather than hardcoded per-view filter controls.
- **Open-from-tree behavior:** selecting a tree comment opens file and reveals anchor line, but does not force comment widget expansion.

### What's known to be incomplete

- **Phase 6 items remain:** VS Code Extension Host integration-test harness and command-level end-to-end automation.
- **Advanced stale/orphan UX remains basic:** no dedicated interactive “re-anchor this stale comment” flow yet.
- **Skill lifecycle management remains basic:** setup can be rerun manually; extension update-time skill version checks are not yet implemented.

---

## Phase 6: Testing Hardening

**Status:** Complete

### What was built

1. **Extension Host integration test harness** (`extension/test/`)
   - Added `@vscode/test-electron` based runner:
     - `extension/test/runTest.js`
     - `extension/test/suite/index.js`
   - Added fixture workspace under `extension/test/fixtures/workspace/`.
   - Hardened host runner to use an isolated temporary workspace copy plus temporary VS Code `user-data` and `extensions` directories per run, with cleanup on exit.

2. **Command-level integration scenarios** (`extension/test/suite/extension.integration.test.js`)
   - Setup command scaffolding test.
   - Add-comment command payload-path test.
   - Archive-resolved workflow test.

3. **Scripted test tiers**
   - Root scripts (`package.json`):
     - `npm run test:extension:host`
     - `npm run test:full` (fast suite + host integration suite)
   - Extension script (`extension/package.json`):
     - `npm run test:host`

4. **Testing policy documentation updates**
   - Added/updated `docs/testing-strategy.md` with:
     - test layer definitions,
     - PR vs release/nightly gates,
     - host-test network caveat and remaining gaps.
   - Updated `AGENTS.md` build/test command reference to include host/full test commands.

5. **Fast-suite TypeScript migration**
   - Migrated all non-host automated tests to TypeScript:
     - `test/cli/*.test.ts`
     - `test/extension/*.test.ts`
   - Added `test/tsconfig.json` and root `test:prepare` script to compile tests before execution.
   - Hardened test compilation setup:
     - switched `test:prepare` to use `extension`'s `./node_modules/.bin/tsc` entrypoint (avoids brittle package-internal bin pathing),
     - enabled strict mode in `test/tsconfig.json` while relaxing `noImplicitAny` for fixture-heavy suites.
   - Updated test scripts to run compiled output under `test/out/` and ignored generated output via `.gitignore`.
   - Standardized compiled-test module resolution using repository-root paths (`process.cwd()`), so tests run correctly both pre-compile and post-compile.

6. **GitHub Actions PR/merge check workflows**
   - Added PR/main fast-suite workflow:
     - `.github/workflows/ci.yml` (`CI / fast-tests`)
   - Added host integration job to the main CI workflow:
     - `.github/workflows/ci.yml` (`CI / host-integration`)
     - runs Electron host tests under `xvfb` on each push/PR.
   - Kept manual extension-host workflow:
     - `.github/workflows/extension-host.yml` (`Extension Host / host-integration`) via `workflow_dispatch` only.
   - Updated testing policy docs to pin merge gate status-check name and branch-protection expectations.

### What was tested

- `npm run compile`
- `npm run test:extension`
- `npm test`
- `npm run test:extension:host`
- Attempted to apply `main` branch protection via GitHub API for required status checks and PR reviews; API returned repository plan/visibility restriction (`HTTP 403`).

### Implementation decisions not in the spec

- **Host tests are a required CI tier:** retained `npm test` as the fast deterministic gate and added host integration checks as a separate required CI job (`CI / host-integration`) on each push/PR.
- **Mocha retained for host harness:** used standard VS Code extension-host test pattern (Mocha + `@vscode/test-electron`) while keeping existing Node test runner for non-host suites.
- **Language split policy documented:** extension runtime + fast tests are TypeScript; CLI/shared runtime and extension-host harness remain JavaScript for C5 compliance and lower harness friction.
- **CI check naming made explicit:** workflow/job naming intentionally fixed to `CI / fast-tests` and `CI / host-integration` for stable branch-protection targeting.
- **Fixture immutability policy:** host tests must run against temp-copied workspaces so tracked fixture files never receive incidental mutations.

### What's known to be incomplete

- **Host test execution depends on network access:** first run requires downloading VS Code test binaries from Microsoft update servers.
- **Host scenarios should expand further:** watcher-driven reply rendering and reconciliation edit-path assertions are not yet covered in host suite.
- **Click-level UI automation is still separate:** no full mouse-driven UI automation suite is part of PR gating.
- **Branch protection cannot be enforced from this repository state:** GitHub API rejects protection changes (`HTTP 403`) until repository plan/visibility supports the feature.

---

## Phase 7: Onboarding and Installation UX

**Status:** Complete

### What was built

1. **Setup core made explicit-opt-in for integrations** (`extension/src/setup.ts`)
   - Added setup options for:
     - optional `.gitignore` update (`addGitignoreEntry`),
     - explicit integration targets (`integrationTargets`),
     - per-integration install plans (`integrationInstalls`) with project/home scope per target.
   - Removed implicit fallback behavior that auto-installed all integrations when no agent footprint was detected.
   - Added exported detection helpers for guided setup defaults:
     - `detectAgentIntegrations(projectRoot)`
     - `getDetectedIntegrationTargets(detection)`
   - Setup still keeps feedback data rooted at fixed `<project-root>/.consider/`.

2. **Guided setup UX in extension command path** (`extension/src/extension.ts`)
   - `Consider: Setup` is now a guided flow:
     - shows a single setup panel that includes `.gitignore` choice,
     - includes checkboxes for Claude/OpenCode/Codex,
     - includes workspace/home scope switches per selected integration in that same panel,
     - writes only explicitly selected integrations.
   - Setup completion message now reports selected/updated/skipped actions clearly.

3. **First-run discoverability prompt** (`extension/src/extension.ts`)
   - On workspace activation without `.consider/store.json`, extension shows a one-time prompt:
     - `Set Up Now`
     - `Later`
   - Prompt is suppressed in extension test mode to avoid host-test flakiness.

4. **Phase 7 automated tests** (`test/extension/setup.test.ts`)
   - Added/updated tests for:
     - baseline setup without integration writes by default,
     - explicit target installation behavior,
     - home-scope skill installation behavior,
     - mixed per-integration scope behavior in one setup run,
     - optional `.gitignore` update skip path,
     - idempotency with explicit targets,
     - integration footprint detection helpers.

5. **Manual testing guide updates** (`docs/manual-testing.md`)
   - Added first-run prompt expectations.
   - Updated setup test flow for guided choices and explicit consent behavior.
   - Updated setup idempotency test to reflect explicit target selection.

6. **Skill file format hardening** (`extension/src/setup.ts`, `test/extension/setup.test.ts`)
   - Skill generation now writes required YAML frontmatter (`name`, `description`) so Claude/OpenCode/Codex can index skills consistently.
   - Added automated assertions that each selected integration gets correctly formatted `SKILL.md`.

7. **CLI deployment hardening for ESM repos** (`extension/src/setup.ts`, `test/extension/setup.test.ts`)
   - Setup now deploys a module-type-invariant launcher path:
     - writes `.consider/bin/consider-cli.cjs`,
     - rewrites `.consider/bin/consider-cli` to execute `consider-cli.cjs`.
   - Setup now copies required shared runtime modules into `.consider/shared/` so deployed CLI imports resolve correctly.
   - Setup now writes `.consider/bin/package.json` and `.consider/shared/package.json` with `"type": "commonjs"` so direct `.js` execution and shared imports remain stable inside ESM repositories.
   - Added an automated test that executes the deployed CLI in a project with `package.json` `"type": "module"` and verifies it runs.

8. **Thread-first guidance for non-actionable feedback** (`extension/src/setup.ts`, `docs/spec.md`)
   - Skill content now instructs agents to prefer in-thread replies (without code edits) when a comment is informational or preference-only and does not request a change.

### What was tested

1. `npm test` (full fast suite) after Phase 7 changes.
2. Updated extension setup tests in `test/extension/setup.test.ts`.
3. Manual test procedures updated for guided setup and first-run prompt behavior.

### Implementation decisions not in the spec

1. **Setup prompt cadence:** first-run prompt is shown once per workspace state when `.consider/store.json` is missing.
2. **Guided defaults:** users can skip integrations explicitly; no implicit integration writes occur.
3. **Skill install scope:** setup supports project-local and home-level install locations per selected integration in the same run.
4. **Codex integration path:** Codex setup writes a skill file under `.codex/skills/consider/SKILL.md`; setup does not append content into `AGENTS.md`/`CLAUDE.md`.
5. **No custom store path in v1:** `.consider/` remains fixed at project root for compatibility with existing CLI/store assumptions.
6. **Agent-specific formatting baseline:** setup now enforces a shared valid frontmatter shape (`name: consider`, `description: ...`) before markdown content.
7. **Module-type invariance in deployed CLI:** setup emits a `.cjs` runtime entrypoint and copies shared modules under `.consider/shared/` to avoid ESM/CJS and relative-import breakage in target repositories.

### What's known to be incomplete

1. **Onboarding wizard remains command/prompt based:** no custom webview wizard has been added.

---

## Phase 8: Offboarding and Uninstall UX

**Status:** Complete

### What was built

1. **Tracked install state in setup config** (`extension/src/setup.ts`)
   - Setup now writes `.consider/config.json` during setup runs.
   - Config tracks installed skill locations with target + scope + absolute path.
   - Repeated setup runs merge tracked installs idempotently.

2. **Uninstall core behavior** (`extension/src/setup.ts`)
   - Added `runUninstallAgentIntegration(projectRoot, options)` to support deterministic cleanup.
   - Supports two modes:
     - full uninstall (remove `.consider/` and tracked skills),
     - skills-only uninstall (remove tracked skills, keep `.consider/`).
   - Removes `.consider/` entry from `.gitignore` when requested.
   - Includes fallback skill discovery for older installs that predate config tracking.

3. **Extension uninstall command flow** (`extension/src/extension.ts`, `extension/package.json`)
   - Added command: `Consider: Uninstall`.
   - Added guided uninstall choices with explicit confirmation:
     - full uninstall,
     - skills-only uninstall.
   - Completion summary reports what was removed/retained.

4. **Automated test coverage updates**
   - `test/extension/setup.test.ts` now covers:
     - setup config tracking output,
     - full uninstall cleanup,
     - skills-only uninstall behavior,
     - fallback discovery uninstall behavior.
   - `extension/test/suite/extension.integration.test.js` now asserts setup writes config artifact.

5. **Docs updates**
   - Updated uninstall behavior and setup tracking in `docs/spec.md`.
   - Added manual uninstall test procedure in `docs/manual-testing.md`.
   - Updated phase plan docs (`AGENTS.md`) and user-facing README flow note.

### What was tested

1. `npm test` (full fast suite) after Phase 8 changes.
2. Extended setup/uninstall unit tests in `test/extension/setup.test.ts`.
3. Manual uninstall test procedure documented in `docs/manual-testing.md`.

### Implementation decisions not in the spec

1. **Config path ownership:** uninstall tracking state is stored in `.consider/config.json` (same gitignored root as store/runtime files).
2. **Fallback compatibility:** uninstall attempts fallback detection for known skill paths when tracking metadata is missing, to support older installs.
3. **Safety scope:** uninstall removes only tracked Consider skill directories (`.../skills/consider`) and leaves agent root directories in place.

### What's known to be incomplete

1. **No selective per-agent uninstall UI yet:** uninstall currently offers two coarse modes (full vs skills-only), not per-agent toggles.

---

## Phase 9: Thread State Model Split

**Status:** Complete

### What was built

1. **Store schema split + migration compatibility** (`shared/store.js`, `extension/src/store.ts`)
   - Replaced single `status` field with:
     - `workflowState`: `open|resolved`
     - `anchorState`: `anchored|stale|orphaned`
   - Added backward-compatible read normalization for legacy stores that still use `status`.
   - Added `agentLastSeenAt` support and unseen-human-activity helpers.

2. **Reconciliation behavior updated to anchor-only transitions** (`shared/reconcile.js`)
   - Reconciliation now updates `anchorState` independently of workflow state.
   - Resolved threads can become stale/orphaned when files change/delete.
   - Successful re-anchor sets `anchorState=anchored` without reopening workflow state.

3. **CLI workflow/anchor UX + reopen command** (`cli/consider-cli.js`)
   - `list` now supports `--workflow`, `--anchor`, and `--unseen`.
   - Kept `--status` as a legacy alias for backward compatibility.
   - Added `unresolve <comment-id>`.
   - `summary` now reports `byWorkflow`, `byAnchor`, and `unseenOpenCount`.
   - `reply`/`resolve`/`unresolve` mark `agentLastSeenAt`.

4. **Extension rendering and actions aligned with split model** (`extension/src/extension.ts`, `extension/src/tree-data.ts`, `extension/src/archive.ts`, `extension/package.json`)
   - Thread labels now render workflow state (`Open`/`Resolved`) and anchor reliability (`Stale Anchor`/`Missing File`).
   - Resolve/Reopen actions are controlled by workflow state.
   - Consider Comments tree now shows workflow + anchor in descriptions and filters accordingly.
   - Archive now archives by `workflowState=resolved`.

5. **Skill guidance + command docs updated** (`extension/src/setup.ts`)
   - Skill instructions now document workflow/anchor semantics, `unresolve`, and unseen-aware listing options.

6. **Comment UX refinements for state handling** (`extension/src/extension.ts`, `extension/package.json`, `extension/src/tree-data.ts`)
   - Added richer workflow/anchor status tags in thread headers and tree rows.
   - Switched comment visibility controls to checkbox toggles (`show resolved`, `show stale`) and applied them to both custom tree and built-in comments panel by controlling rendered threads.
   - Disabled replies on resolved threads until explicitly un-resolved.
   - Exposed `Unresolve` action in thread menus more explicitly.

### What was tested

1. `npm test` after the full refactor.
2. Updated CLI tests:
   - schema fixtures,
   - list filtering (`workflow`/`anchor`/`unseen`),
   - resolve + unresolve flow,
   - summary JSON shape,
   - orphan context behavior.
3. Updated reconciliation parity tests (CLI + extension) for anchor-state transitions.
4. Updated extension tree/archive tests for workflow/anchor model.
5. Added store migration test asserting legacy `status` is normalized into split state fields.

### Implementation decisions not in the spec

1. **Legacy filter support retained:** CLI keeps `--status` for compatibility while promoting `--workflow`/`--anchor`.
2. **Open filter semantics in UI tree:** `Open only` maps to `workflowState=open` (includes stale/orphaned anchors if still open).
3. **Summary shape migration:** CLI JSON summary switched from `byStatus` to `byWorkflow` + `byAnchor`.

### What's known to be incomplete

1. **No dedicated unread triage command yet:** unseen support exists via `list --unseen`, but no separate inbox command is implemented.

---

## Phase 10: UI Smoke Automation

**Status:** Complete

### What was built

1. **UI smoke harness scaffolding** (`extension/test-ui/`)
   - Added `vscode-extension-tester` based runner at `extension/test-ui/runSmoke.js`.
   - Runner provisions an isolated fixture workspace copy per run, executes smoke tests, and keeps artifacts on failures.
   - Runner now uses an isolated extension directory (`extension/test-ui/.cache/extensions`) so global user extensions do not affect smoke runs.
   - Added deterministic smoke settings file: `extension/test-ui/settings.json`.

2. **Smoke fixture workspace** (`extension/test-ui/fixtures/workspace/`)
   - Added minimal source fixture (`src/sample.ts`) used by click-level smoke flows.

3. **Expanded end-to-end UI smoke scenarios** (`extension/test-ui/suite/smoke.test.js`)
   - Runs guided setup from the setup webview submit path and verifies scaffold outputs (`.consider/store.json`, `.consider/config.json`, deployed CLI/shared runtime files, and `.gitignore` entry).
   - Adds a comment through the command palette flow and verifies persisted store records.
   - Executes CLI reply from the same workspace and asserts watcher-driven thread rendering in the editor.
   - Exercises resolve/unresolve lifecycle across UI + CLI transitions and verifies workflow state persistence.
   - Archives resolved comments from the command flow and verifies movement from active store into `.consider/archive.json`.
   - Runs full uninstall from the command flow and verifies `.consider` removal plus `.gitignore` cleanup.

4. **Scripts and CI wiring**
   - Added extension script: `npm run test:ui:smoke`.
   - Added root scripts:
     - `npm run test:extension:ui:smoke`
     - updated `npm run test:full` to include UI smoke.
   - Added UI smoke artifact retention under `extension/test-ui/.artifacts` for failure triage.

5. **Repo hygiene**
   - Added `extension/test-ui/.artifacts/` to `.gitignore`.
   - Added `extension/test-ui/.cache/` to `.gitignore`.

6. **Packaged-extension runtime hardening** (`extension/runtime/**`, `extension/scripts/sync-runtime.js`, `extension/src/reconcile.ts`, `extension/src/extension.ts`)
   - Bundled CLI/shared runtime assets inside the extension package under `runtime/`.
   - Added `sync:runtime` build step so packaged VSIX has the same CLI/shared runtime files setup depends on.
   - Updated extension runtime imports and setup source paths to use bundled runtime assets rather than repo-sibling paths.

### What was tested

1. `npm test` (passes).
2. `npm run test:extension:host` (passes).
3. `npm run test:extension:ui:smoke` (passes).
4. `npm run test:full` (passes).

### Implementation decisions not in the spec

1. **UI smoke uses explicit non-interactive VSIX packaging:** the smoke runner packages with `@vscode/vsce` API options to avoid interactive prompts and to skip secret-lint gating for test-only packaging (CI-safe), then installs that VSIX via `vscode-extension-tester`.
2. **Isolated workspace-first execution:** smoke tests never run against repo working files; they operate on a copied fixture workspace.
3. **Isolated extensions runtime for smoke:** smoke runs do not load global user extensions; they use a dedicated test extensions directory.
4. **Artifact retention policy:** run directory is deleted on success and retained on failure for screenshot/log triage.
5. **Packaging exclusions hardened:** extension packaging now uses `.vscodeignore` to exclude test/dev artifacts (including `test-ui/**`) so UI smoke runtime data cannot bloat/break VSIX creation.
6. **Cache-first test runtime:** UI smoke now uses a stable cache directory (`extension/test-ui/.cache`) so local and CI runs can reuse downloaded VS Code + ChromeDriver binaries across runs.
7. **Self-contained VSIX runtime assets:** the extension bundle carries the CLI/shared runtime files required for setup and reconciliation so installed VSIX behavior matches development behavior.
8. **CI gate adjustment:** push/PR CI now runs `CI / fast-tests` and `CI / host-integration`; UI smoke runs remain local/manual due intermittent hosted-runner UI automation instability.

### What's known to be incomplete

1. **Coverage breadth is still selective:** smoke now covers core lifecycle paths, but additional UX paths (advanced filtering toggles, comments panel edge interactions, and reconciliation-heavy edit sequences) should still be added incrementally.

---

## Post-Phase: Naming Migration (Feedback -> Consider)

**Status:** Complete

### What was built

1. Renamed the primary runtime artifacts:
   - project data directory from `.feedback/` to `.consider/`,
   - CLI executable from `feedback-cli` to `consider-cli`,
   - deployed CLI/runtime paths under `.consider/bin/` and `.consider/shared/`.
2. Updated extension command labels and view naming to user-facing `Consider:*` terminology.
3. Updated extension setup/uninstall flows, skill templates, and docs/manual test instructions to use `.consider` and `consider-cli`.
4. Updated CLI tests, extension tests, integration tests, and UI smoke tests to assert the new paths/command labels.

### What was tested

1. `npm test` (passes).
2. `npm run test:extension:host` (passes).

### Implementation decisions not in the spec

1. **Legacy store compatibility retained:** runtime store resolution now prefers `.consider` but falls back to legacy `.feedback` when needed.
2. **Setup auto-migrates legacy data directory:** if `.feedback/` exists and `.consider/` does not, setup renames `.feedback/` to `.consider/`.
3. **Dual watcher + activation compatibility:** the extension watches and activates on both `.consider/store.json` and legacy `.feedback/store.json` to avoid breaking existing workspaces before setup reruns.
4. **Gitignore cleanup behavior:** setup removes legacy `.feedback` ignore entries while adding `.consider/` and uninstall removes both entries.
5. **Uninstall cleanup behavior:** full uninstall removes both `.consider/` and legacy `.feedback/` when present.

### What's known to be incomplete

1. **Legacy artifact shims are not shipped:** old `feedback-cli` wrappers are intentionally removed in favor of clean naming; legacy compatibility is provided at store-path level and setup migration flow.

---

## Post-Phase: Thread ID Copy + Thread Fetch Flow

**Status:** Complete

### What was built

1. **Thread-header copy action in extension UI** (`extension/package.json`, `extension/src/extension.ts`)
   - Added `Copy Thread ID` command to comment thread title actions next to resolve/unresolve.
   - New command copies `threadID: <comment-id>` into clipboard for direct sharing in agent chat.

2. **CLI thread fetch command** (`cli/consider-cli.js`)
   - Added `thread <comment-id> [--json]` command as a thread-first alias for `get`.
   - Updated CLI help text and command router.

3. **Skill loop update** (`extension/src/setup.ts`)
   - Skill template now explicitly handles copied thread tokens:
     - if developer shares `threadID: <comment-id>`, run `consider-cli thread <comment-id>`.
   - Added `thread` to the generated command list.

4. **Tests and docs updates**
   - Added CLI tests for `thread` command behavior (`test/cli/cli.test.ts`).
   - Added extension host integration test for clipboard behavior (`extension/test/suite/extension.integration.test.js`).
   - Updated command documentation in `README.md` and `docs/spec.md`.

### What was tested

1. `npm test` (passes).
2. `npm run test:extension:host` (passes).

### Implementation decisions not in the spec

1. **`thread` command is intentionally an alias** of `get` for backward compatibility and easier adoption.
2. **Clipboard token format is fixed** as `threadID: <id>` to keep parsing and human handoff consistent.

### What's known to be incomplete

1. **No dedicated parse command for free-form chat logs** — agents still parse `threadID:` tokens from normal conversation context.

---

## Post-Phase: Skill Template Hardening

**Status:** Complete

### What was built

1. **Richer skill trigger metadata** (`extension/src/setup.ts`)
   - Expanded generated skill descriptions to include explicit trigger cues (`threadID`, `consider-cli`, Consider comment triage).

2. **Workflow/failure guidance upgrades in generated skills** (`extension/src/setup.ts`)
   - Added explicit no-work branch when there are no open comments.
   - Added explicit default behavior to keep threads open unless the issue is fully addressed and the discussion is clearly complete.
   - Added CLI failure handling guidance for store conflict/busy, missing thread IDs/comments, and orphaned context.
   - Reduced command duplication by replacing the full command catalog with a shorter quick-reference list.

3. **Codex UI metadata generation** (`extension/src/setup.ts`)
   - Setup now writes `agents/openai.yaml` alongside Codex `SKILL.md` with `display_name`, `short_description`, and `default_prompt`.

4. **Setup test coverage updates** (`test/extension/setup.test.ts`)
   - Added assertions for generated Codex `agents/openai.yaml` existence and required metadata fields.

### What was tested

1. `npm test` (passes).

### Implementation decisions not in the spec

1. **Codex metadata scope:** `agents/openai.yaml` generation is currently added only for Codex skill installs.

### What's known to be incomplete

1. **No optional icon/brand metadata yet:** `agents/openai.yaml` currently includes interface text fields only.

---

## Post-Phase: Storage Write-Path Unification

**Status:** Complete

### What was built

1. **Extension store adapter now delegates to shared runtime store logic** (`extension/src/store.ts`)
   - Replaced extension-local read/write normalization implementation with typed wrappers over `extension/runtime/shared/store.js`.
   - Extension now uses the same lock, revision conflict detection, mutation-on-latest, and atomic-write semantics as the CLI/shared runtime.
   - Added typed export for `mutateStore(...)` in extension runtime code.

2. **Extension write call sites migrated to mutation-on-latest writes** (`extension/src/extension.ts`)
   - Reworked root comment creation, replies, resolve/unresolve, delete flows, archive-resolved persistence, reconcile persistence, and active-editor anchor sync to mutate under shared store lock.
   - Replaced `writeStoreSuppress` with `mutateStoreSuppress` so extension write operations no longer perform stale snapshot read-modify-write persistence.
   - Added explicit lock-timeout user messaging (`Consider store is busy...`) on write contention.

3. **Extension storage concurrency test coverage added** (`test/extension/store.test.ts`)
   - Added stale snapshot conflict test proving extension wrapper surfaces `ESTORECONFLICT`.
   - Added concurrent extension-vs-CLI write test proving both updates persist (no dropped update on concurrent mutations).

### What was tested

1. `npm test` (passes).
2. `npm run test:extension:host` (passes).
3. `npm run test:full` (passes, including UI smoke).

### Implementation decisions not in the spec

1. **Single mutation helper in extension controller:** all extension write operations now funnel through one helper (`mutateStoreSuppress`) for consistent lock/error/suppression behavior.
2. **Shared runtime is source-of-truth for persistence semantics:** extension-side type-safe wrappers call shared runtime functions directly instead of maintaining duplicate persistence logic in TypeScript.
3. **Conflict handling kept defensive in extension helper:** `ESTORECONFLICT` handling remains in the helper for resilience even though mutation-on-latest should avoid stale-snapshot conflicts for normal extension write paths.

### What's known to be incomplete

1. **Archive flow is not cross-file transactional:** archive writes (`archive.json`) and active-store updates (`store.json`) are still separate atomic writes, not a single transaction across both files.
