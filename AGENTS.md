# AGENTS.md — Consider

You are working on **Consider**, a VS Code extension and CLI tool for inline, bidirectional code feedback between developers and AI agents. Read `docs/spec.md` before doing anything. It is the canonical reference for all architectural decisions, data models, and constraints.

## Project overview

Three components: a VS Code extension (TypeScript), a feedback store (`.consider/store.json`), and a CLI tool (standalone Node.js, zero npm dependencies). The extension and CLI both read/write the same JSON store. Communication between developer and agent is mediated entirely through the filesystem — no IPC, no server.

The spec has 5 hard constraints (Section 2). Memorize them. The most commonly violated one will be C5: the CLI must have zero npm dependencies and work with only Node builtins (`fs`, `path`, `crypto`, `process`).

## Build phases

This project is built in phases. **Complete one phase fully before starting the next.** Do not skip ahead, do not partially implement a later phase, and do not combine phases unless explicitly told to. Each phase should produce a working, testable increment.

- **Phase 1: Store format + CLI skeleton** — JSON schema, CLI with `list`, `get`, `reply`, `resolve`, `summary`, `context`. Static line numbers, no reconciliation yet. Testable by hand-editing `store.json`.
- **Phase 2: Extension skeleton** — VS Code Comments API wired up. Add/view/reply/resolve comments. Persist to store. File watcher for agent replies.
- **Phase 3: Content-based anchoring** — Re-anchoring algorithm in both CLI and extension. Mtime-based change detection. Staleness and orphan detection. This is the riskiest piece — test thoroughly.
- **Phase 4: Agent integration setup** — "Setup" command. Skill files for Claude Code, OpenCode, Codex. Full loop test.
- **Phase 5: Polish** — Tree view panel, archive resolved, visual refinements, Reconcile All command.
- **Phase 6: Testing hardening** — Add VS Code Extension Host integration tests (`@vscode/test-electron` / `@vscode/test-cli`) for command-level end-to-end flows. Keep `npm test` fast and deterministic while adding release-grade coverage for the advertised workflow.
- **Phase 7: Onboarding and installation UX** — Add a guided setup flow (extension-first), keep `.consider/` fixed at project root, make agent skill installation explicit opt-in (not implicit side effect), and let users choose workspace vs home skill install scope.
- **Phase 8: Offboarding and uninstall UX** — Add a guided uninstall flow and track setup artifact locations so skill/runtime cleanup is deterministic and safe.

When you finish a phase, update `docs/progress.md` with: what was built, what was tested, what implementation decisions were made that aren't in the spec, and what's known to be incomplete.

## Documentation governance

- Substantial product/architecture/workflow changes must be reflected in docs during the same change (at minimum: `docs/spec.md`, `docs/progress.md`, and any affected policy docs).
- Prefer maintaining a finite, stable docs set over adding new one-off docs. Extend existing source-of-truth files unless a new document is clearly necessary.

## What not to build

The spec distinguishes v1 from v2 explicitly. Do not build:
- MCP server (Section 8.4 — deliberately deferred)
- Label/tagging system (Section 9.2 — v2 enhancement)
- Queue/dispatch model — comments are `open` on creation, no `queued` status
- Complex build pipelines — the CLI is a single `.js` file with no build step
- Per-agent deep integration or message injection into agent conversations

If you think something should be added that isn't in the spec, ask before building it.

## Repository structure

After scaffolding, the repo should look roughly like:

```
consider/
├── docs/
│   ├── spec.md                 # Technical specification (read-only reference)
│   ├── progress.md             # Phase completion log (you update this)
│   └── manual-testing.md       # Manual test procedures (you generate this)
├── extension/                  # VS Code extension (TypeScript)
│   ├── src/
│   ├── package.json            # Extension manifest
│   └── tsconfig.json
├── cli/                        # CLI tool source (Node.js, zero dependencies)
│   ├── consider-cli.js         # Main implementation
│   └── consider-cli            # Shell wrapper
├── shared/                     # Shared logic (if extracted — see spec Section 9.5)
├── test/                       # Test fixtures and test scripts
│   ├── cli/
│   └── extension/
├── AGENTS.md                   # This file
├── CLAUDE.md                   # → symlink to AGENTS.md
├── .gitignore
└── README.md
```

This is a starting point. Adjust as needed during implementation, but explain structural changes in your commit messages and in `docs/progress.md`.

## Technology decisions

**Extension:** TypeScript. Use VS Code's Comments API (not custom webview UI). Standard extension scaffolding via `yo code` or equivalent. The extension manifest (`package.json`) should declare the minimum VS Code engine version that supports the Comments API features we need.

**CLI:** Node.js. Zero npm dependencies — only builtins. Must be invocable as `.consider/bin/consider-cli <command>` via the shell wrapper. See spec Section 6.1 for the wrapper script. The CLI is both the development source (in `cli/`) and a deployable artifact that gets copied into `.consider/bin/` by the extension's setup command.

**Store:** Single JSON file at `.consider/store.json`. Schema defined in spec Section 4.2. Use atomic writes (write to temp file, then rename) to prevent corrupt reads during concurrent access.

**Re-anchoring:** Both the CLI and extension implement this. The algorithm must produce identical results in both. Spec Section 4.3 has the full algorithm. Consider extracting into a shared `.js` file, but don't over-engineer the sharing mechanism.

## Language policy

- **Extension runtime code:** TypeScript (`extension/src/**`) with strict mode.
- **Fast test suites:** TypeScript (`test/**`) compiled via `test/tsconfig.json` before running `node --test` (strict mode enabled with `noImplicitAny` relaxed for fixture-heavy tests).
- **CLI and shared runtime:** JavaScript (`cli/**`, `shared/**`) to preserve the zero-dependency, no-build deploy model required by C5.
- **Extension Host harness:** JavaScript (`extension/test/**`) to keep `@vscode/test-electron` bootstrap simple and avoid adding a second transpile/loader path for the VS Code-launched test process.

## Commands reference

### Build and test

```sh
# Extension
cd extension && npm install && npm run compile
# Run extension in development: F5 in VS Code (launch.json should be set up)

# CLI (no build step)
node cli/consider-cli.js --help

# Tests
npm test                        # Run all tests
npm run test:cli                # CLI tests only
npm run test:extension          # Extension tests only
npm run test:extension:host     # Extension Host integration tests (Phase 6)
npm run test:full               # Fast suite + Extension Host integration suite
```

Set up these npm scripts during Phase 1/2 scaffolding. Adjust as needed but keep the top-level `npm test` working at all times.

### CI and merge checks

- GitHub Actions workflow `CI` runs on PRs and pushes to `main`.
- Required PR status check for merge target: `CI / fast-tests` (when branch protection is available/enabled for the repository plan/visibility).
- Extension-host workflow `Extension Host` runs on schedule/manual trigger and is not the PR gate.

### Linting and formatting

Use ESLint and Prettier with standard TypeScript configs. Run `npm run lint` and `npm run format`. Configure these during scaffolding. Do not deviate from standard community configs unless there's a specific reason.

## Testing expectations

Use `docs/testing-strategy.md` as the repository-wide testing source of truth for merge/release gates and integration-test roadmap decisions.
Use `docs/known-limitations.md` as the single source of truth for confirmed product limitations; other docs should link to it rather than restating limitation details.

Every phase must include tests. What "tests" means varies by phase:

**Phase 1 (CLI):** Automated tests. Create test fixtures (sample `store.json` files), run CLI commands, verify output. Test each command with normal input, edge cases (empty store, nonexistent ID, missing file), and the `--json` flag. A simple test runner using Node's built-in `node:test` and `node:assert` is fine — no test framework dependencies in the CLI.

**Phase 2 (Extension):** Manual testing instructions in `docs/manual-testing.md`. Step-by-step: open VS Code with the extension in dev mode, open a test project, add a comment, verify it appears in `store.json`, simulate an agent reply by editing the store externally, verify the reply renders. Also write unit tests for any pure logic (store read/write, ID generation).

**Phase 3 (Anchoring):** Automated tests with specific edit scenarios. Spec Section 4.3 lists the patterns to test: insertion above a comment, deletion of lines around a comment, function rename, file deletion. Create fixture files, apply known edits, verify re-anchored positions and staleness detection. These tests must cover both the CLI and extension implementations and verify they produce the same results.

**Phase 4 (Agent setup):** Verify the setup command creates correct directory structure, generates valid skill files, appends to `.gitignore` without duplicates. Test with and without existing `.claude/`, `.opencode/`, and `.codex/` directories (plus legacy `.agents/` detection compatibility).

**Phase 5 (Polish):** Manual testing for UI features (tree view, archive). Automated tests for any new logic.

**Phase 6 (Testing hardening):** Add Extension Host integration tests for setup command, add-comment command path, watcher-driven reply rendering, and reconciliation scenarios in fixture workspaces. Define CI split between PR-gating tests and slower release/nightly smoke tests.

**Phase 7 (Onboarding and installation UX):** Add automated tests for setup-flow decision logic plus manual tests for first-run UX. Verify explicit consent behavior (no skill writes unless selected), idempotent reruns, and clear setup summaries.

**Phase 8 (Offboarding and uninstall UX):** Add automated tests for uninstall path decisions and cleanup behavior (tracked skill removal, fallback detection for older installs, data-retain vs full-remove modes), plus manual tests for command UX and safety confirmations.

## Commit conventions

- Small, focused commits. One logical change per commit.
- Format: `phase N: short description` (e.g., `phase 1: implement CLI list command with status filtering`)
- If a commit touches multiple phases (should be rare), explain why in the commit body.
- Never commit broken tests. If a test is failing, fix it in the same commit or explain in the message why it's expected.
- Commit `docs/progress.md` updates at the end of each phase.

## Code style

- TypeScript strict mode for the extension.
- No `any` types unless genuinely unavoidable (and add a comment explaining why).
- Prefer explicit error handling over try/catch-all. The CLI especially should give clear error messages (e.g., "Comment c_abc123 not found" not "Cannot read property 'id' of undefined").
- No unnecessary abstractions. This is a two-component system with a simple data model. Don't introduce patterns (dependency injection, event buses, plugin systems) that the current scope doesn't require.
- Comments in code should explain *why*, not *what*. The spec already documents the what.

## Important implementation notes

**Atomic writes:** Both the CLI and extension must write `store.json` atomically (write to `.consider/store.json.tmp`, then `fs.renameSync`). This prevents corrupt reads if one process reads while the other is mid-write.

**Comment IDs:** Generate with `c_` prefix + random hex from `crypto.randomBytes`. Reply IDs use `r_` prefix. Keep them short enough to type in a CLI command but unique enough to avoid collisions.

**File paths in the store:** Always relative to the project root. Never absolute paths. The CLI resolves them relative to the `.consider/` directory's parent.

**The extension copies the CLI into `.consider/bin/`:** During the setup command, the extension copies the CLI source into the target project's `.consider/bin/` directory. This means the CLI in `cli/` is the development source, and the copy in `.consider/bin/` is the deployed artifact. They must be the same file. Don't introduce a build step between them.

**State model is split:** Workflow and anchor tracking are separate fields in v1:
- `workflowState`: `open` ↔ `resolved` (either party can resolve/reopen)
- `anchorState`: `anchored` ↔ `stale` / `orphaned` (reconciliation-driven, independent of workflow)
Resolved comments can still become stale/orphaned if code moves or files disappear.

## When you're unsure

- **Architectural questions:** Check `docs/spec.md` first. If the answer isn't there, ask before implementing.
- **Implementation details** the spec doesn't cover (e.g., debounce timing for extension re-anchoring, exact similarity threshold for staleness): make a reasonable choice, document it in a code comment and in `docs/progress.md`, and move on. These can be tuned later.
- **Scope creep:** If you find yourself building something that would take more than ~30 minutes and isn't described in the current phase, stop and ask.
