# Progress Log

## Phase 1: Store Format + CLI Skeleton

**Status:** Complete

### What was built

1. **Shared store module** (`shared/store.js`)
   - `readStore(projectRoot)` — reads `.feedback/store.json`, returns empty store if absent.
   - `writeStore(projectRoot, store)` — atomic write via temp file + rename.
   - `findProjectRoot(startDir)` — walks up directory tree looking for `.feedback/`.
   - `generateCommentId()` / `generateReplyId()` — `c_` / `r_` prefix + 8 random hex chars.
   - `findComment(store, id)` — lookup by comment ID.

2. **CLI tool** (`cli/feedback-cli.js` + `cli/feedback-cli` shell wrapper)
   - `list [--status <s>] [--file <path>] [--json]` — lists comments filtered by status (default: open) and file path prefix.
   - `get <id> [--json]` — shows a comment with its full thread.
   - `reply <id> --message "..."` — adds a reply as `author: "agent"`.
   - `resolve <id>` — sets status to `resolved`.
   - `summary [--json]` — shows open count, file count, and breakdown by status.
   - `context <id> [--lines N] [--json]` — shows the comment with surrounding code from the actual file, target lines marked with `>>>`.

3. **Automated tests** (`test/cli/store.test.js`, `test/cli/cli.test.js`)
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
   - **File watcher** — watches `.feedback/store.json` for changes. When the agent writes a reply via CLI, the store changes, and the extension re-renders affected threads. Agent replies appear inline with "Agent" author label.
   - **Startup load** — reads all comments from the store on activation and creates visual threads.
   - **Watcher suppression** — the extension suppresses its own file watcher during writes to avoid re-reading its own changes.
   - **Graceful no-workspace handling** — if no workspace folder is open, commands show a warning message.
   - **Phase 3/4/5 stubs** — Reconcile All, Setup Agent Integration (basic), Show All Comments, and Archive Resolved are registered as commands with placeholder behavior.

4. **Manual testing guide** (`docs/manual-testing.md`)
   - 12 step-by-step test scenarios covering: extension launch, add/reply/resolve/delete comments, agent reply via CLI (bidirectional communication), startup load, multi-file, and no-workspace edge case.

### Implementation decisions not in the spec

- **Author display:** "Developer" for human author, "Agent" for agent author. No icon paths (the VS Code CommentAuthorInformation `iconPath` field requires a `Uri`, not a `ThemeIcon`, so we omit it for simplicity — author names are sufficient for distinguishing).
- **Context capture on comment creation:** 2 lines of context before/after are captured at comment creation time. This will feed into the Phase 3 re-anchoring algorithm.
- **Watcher suppression timeout:** 500ms timeout after writing to store before re-enabling the file watcher. This prevents spurious re-reads from our own writes while still catching agent writes that arrive shortly after.
- **Comment thread `contextValue`:** Used to control menu visibility. Open threads show "Resolve", resolved threads show "Reopen". Format: `feedback-thread-<status>`.
- **Store adapter is a separate TypeScript file,** not a direct import of `shared/store.js`. This keeps the extension's TypeScript strict mode working and avoids require-path issues at runtime. Both implementations follow the same schema and must stay in sync.

### What was tested

- Extension compiles cleanly with `tsc` in strict mode.
- All 39 Phase 1 CLI tests still pass.
- Manual testing guide provided for all extension features.

### What's known to be incomplete

- **No reconciliation** — Phase 3. Comments use static line numbers.
- **No agent setup command** — Phase 4. Current stub only creates `.feedback/` directory.
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

2. **CLI lazy reconciliation on reads** (`cli/feedback-cli.js`)
   - Read commands now reconcile before returning output:
     - `list`
     - `get`
     - `summary`
     - `context`
   - If reconciliation mutates comments, CLI persists the updated store atomically before rendering output.
   - `context` now correctly fails for comments that became orphaned during reconciliation in that same invocation.

3. **Extension reconciliation wiring** (`extension/src/extension.ts`, `extension/src/reconcile.ts`)
   - Added extension wrapper module over shared reconciliation to keep behavior aligned with CLI.
   - Implemented `Feedback: Reconcile All` command using `force` reconciliation.
   - Implemented automatic file-scoped reconciliation triggers:
     - on file open,
     - on save,
     - on document changes (debounced).
   - For active editing, added thread-range persistence back to store (updates line range + anchor snapshot for open comments).
   - Added consistent thread presentation updates (status-driven labels/context values) for open/resolved/stale/orphaned states.

4. **Automated Phase 3 tests**
   - Added reconciliation scenario tests (`test/cli/reconcile.test.js`) covering:
     - insertion above target,
     - content changes requiring fuzzy match,
     - stale detection,
     - orphan detection,
     - force-based stale reopening.
   - Added extension parity tests (`test/extension/reconcile.test.js`) comparing shared vs extension reconciliation outputs for the same fixtures.
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
- **Phase 4 items remain:** full Setup Agent Integration (CLI deployment + skill generation).
- **Phase 5 items remain:** tree view, archive-resolved workflow, and polish UX.
