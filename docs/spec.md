# Feedback Loop: Technical Specification

## Document Purpose

This document is the canonical reference for building Feedback Loop, a VS Code extension and accompanying CLI tool that enables inline, bidirectional feedback between a human developer and an AI coding agent. It is written to give a fresh team complete context: the problem, the decisions already made, the open questions, and the constraints.

Read the whole thing before writing any code.

---

## 1. Problem Statement

### 1.1 Who This Is For

A developer who uses AI coding agents (Claude Code, Codex, OpenCode, or similar) as a primary development workflow. They interact with the agent through a CLI or sidebar conversation, supervising it through multi-stage tasks: planning, refinement, implementation, review.

### 1.2 The Workflow Gap

When the developer needs to review code or specs that the agent has produced (or that they're collaborating on), they open the files in VS Code. At this point, they need to provide *located* feedback — comments tied to specific lines or ranges, not free-text chat messages.

Today, the developer works around this by inserting sentinel comments (e.g., `FEEDBACK: this function should handle the error case`) directly into the file, then asking the agent to scan for them. The agent responds in the chat interface, referencing line numbers. This creates a fragmented experience:

- Feedback lives in the file itself, polluting the codebase and git history.
- Agent responses live in chat, disconnected from the code locations they reference.
- The developer must mentally map between chat responses and file locations.
- There is no threading — a back-and-forth about a specific piece of feedback sprawls across the main conversation.

### 1.3 What We're Building

A system that provides a GitHub PR review-like annotation layer for local development, designed specifically for human↔agent communication. The developer adds inline comments in VS Code. The agent reads and responds to them. The conversation threads are anchored to code locations but stored separately from the code. Git never sees any of it.

---

## 2. Hard Constraints

These are non-negotiable requirements that were established during design discussions.

**C1: No git pollution.** Feedback must not appear in `git status`, `git diff`, or any git operation. The feedback store, CLI tool, and all metadata must be invisible to git. This means everything lives in gitignored directories.

**C2: No manual line-number references.** The developer should never have to type "on line 45, I think..." — the UI handles the association between comments and code locations. The developer clicks on a line (or selects a range), writes their comment, and the system records the location.

**C3: Feedback is not code.** The developer should not have to write comments in source-code syntax, insert sentinel values, or otherwise modify files to communicate with the agent. The annotation layer is entirely separate from the files it annotates.

**C4: Preserve the main conversation.** The developer already has a conversation with the agent in a terminal, sidebar, or other interface. Feedback Loop should not replace that conversation — it should complement it. Inline comment threads are a *separate channel* for located, specific feedback. The main conversation remains the primary interaction surface.

**C5: Zero-setup agent integration.** The CLI tool that agents use to read/write feedback must work without requiring the developer to install additional runtimes, run package managers, or configure anything beyond what the extension's setup command provides. It must run in the environment that any developer using VS Code + an AI agent already has.

---

## 3. Architecture Overview

The system has three components:

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                     │
│                                                         │
│  - Uses VS Code Comments API for inline thread UI       │
│  - Reads/writes to the feedback store                   │
│  - Watches store.json for agent replies (file watcher)  │
│  - Re-anchors comments for open/viewed files            │
│  - "Setup Agent Integration" command                    │
└──────────────────────┬──────────────────────────────────┘
                       │ reads/writes
                       ▼
┌─────────────────────────────────────────────────────────┐
│                Feedback Store (.feedback/)                │
│                                                         │
│  - JSON file(s) storing all comments, threads, anchors  │
│  - Gitignored                                           │
│  - Source of truth for both extension and CLI            │
└──────────────────────┬──────────────────────────────────┘
                       │ reads/writes
                       ▼
┌─────────────────────────────────────────────────────────┐
│              CLI Tool (.feedback/bin/feedback-cli)        │
│                                                         │
│  - Standalone Node.js script (no dependencies)          │
│  - Shell wrapper for ergonomic invocation               │
│  - Documented via skill files for each agent system     │
│  - Called by agents via normal shell execution           │
│  - Reconciles anchors lazily on every read              │
└─────────────────────────────────────────────────────────┘
```

### 3.1 Why These Three Components

The **extension** provides the human-facing UX. It's how the developer creates, reads, and manages feedback. It uses VS Code's native Comments API, which gives us the GitHub PR-style inline thread UI (gutter icons, comment widgets, resolve/unresolve) without building custom UI.

The **store** is the shared data layer. Both the extension and the CLI read and write to the same files. This means the extension can pick up agent responses without any IPC or server process — it just watches the files.

The **CLI** is the agent-facing interface. Agents call it via shell commands. It wraps the store with ergonomic operations (list pending feedback, reply to a comment, resolve a thread). The agent learns how to use it through skill files that are dropped into the project during setup.

---

## 4. The Feedback Store

### 4.1 Location and Git Isolation

The store lives at `<project-root>/.feedback/`. The setup command adds `.feedback/` to `.gitignore`.

The directory structure:

```
.feedback/
├── store.json              # All comments, threads, and anchors
├── bin/
│   ├── feedback-cli        # Shell wrapper (#!/bin/sh)
│   └── feedback-cli.js     # Node.js implementation
└── config.json             # Optional: extension/CLI configuration
```

### 4.2 Data Model

The store is a single JSON file. A single file (rather than per-file storage) simplifies querying ("show all open comments across the project") and avoids proliferating files.

Comment statuses: **open** (active, awaiting attention), **resolved** (addressed, closed by either party), **stale** (target code changed substantially, anchor could not be re-established), **orphaned** (target file no longer exists).

```json
{
  "version": 1,
  "comments": [
    {
      "id": "c_abc123",
      "file": "src/auth/login.ts",
      "anchor": {
        "startLine": 45,
        "endLine": 47,
        "contextBefore": ["  const token = await getToken();", "  if (!token) {"],
        "contextAfter": ["  }", "  return token;"],
        "targetContent": "    throw new Error('no token');",
        "contentHash": "a1b2c3d4",
        "lastAnchorCheck": "2025-02-15T10:30:00Z"
      },
      "status": "open",
      "createdAt": "2025-02-15T10:30:00Z",
      "author": "human",
      "body": "This should return a Result type instead of throwing. We discussed this in the error handling spec.",
      "thread": [
        {
          "id": "r_def456",
          "author": "agent",
          "body": "Agreed. I'll refactor this to return Result<Token, AuthError>. Should I also update the callers in session.ts and middleware.ts?",
          "createdAt": "2025-02-15T10:32:00Z"
        },
        {
          "id": "r_ghi789",
          "author": "human",
          "body": "Yes, update all callers.",
          "createdAt": "2025-02-15T10:33:00Z"
        }
      ]
    }
  ]
}
```

### 4.3 Content-Based Anchoring and Reconciliation

This is the hardest subproblem in the project and deserves careful attention.

**The problem:** Line numbers are fragile. If the developer (or the agent) adds 10 lines above a comment's target, the comment now points at the wrong code. Pure line-number anchoring breaks on every edit.

**The approach:** Each anchor stores both the line number AND the content context — a few lines before and after the target, plus the target content itself and a hash. When a read operation detects that the file has changed, we re-anchor:

1. Check if the content at the stored line number still matches `targetContent` (fast path — nothing moved).
2. If not, search the file for the `targetContent` string. If found exactly once, update the line number.
3. If not found exactly, use the `contextBefore`/`contextAfter` lines to do fuzzy positional matching — find the region of the file that best matches the surrounding context.
4. If no good match is found (similarity below a threshold), mark the comment as **stale**.
5. If the file no longer exists, mark the comment as **orphaned**.

This is the same general approach that `git merge` uses for conflict detection, and it's "good enough" — perfect tracking isn't the goal. Flagging staleness is. At the same time, common interaction patterns (agent adds lines above a comment, agent refactors the commented function) must re-anchor correctly and not produce false staleness.

**Who reconciles: both the CLI and the extension, for different contexts.**

The dominant edit pattern is: the agent modifies files via the terminal (Claude Code, Codex, OpenCode all write files directly). The developer may not have these files open in VS Code at all, and there are no "save" events to hook into.

Therefore, **both** the CLI and the extension perform reconciliation, each covering a different scenario:

**The CLI** performs **lazy reconciliation on every read operation**. When the agent (or anyone) calls `feedback-cli list`, `feedback-cli get`, or `feedback-cli context`, the CLI:

1. Reads the store.
2. For each comment whose target file has a modification time newer than the comment's `lastAnchorCheck` timestamp, runs the re-anchoring algorithm.
3. Updates the store with corrected line numbers and any staleness flags.
4. Returns the reconciled results.

This ensures the agent always sees accurate positions, even for files that were never opened in VS Code.

**The extension** performs reconciliation for files the developer opens or is viewing. This is not optional — the developer must see correct comment positions for any file they look at. The extension should re-anchor:

- When a file with comments is opened in the editor.
- When VS Code detects an external change to a file with comments (e.g., the agent edited it while the developer has it open).
- During active editing, either via VS Code's native `Range` tracking on the Comments API (if it handles this automatically) or via lightweight re-anchoring on document change events. This needs investigation during implementation.

If either the CLI or the extension has already reconciled (updating `lastAnchorCheck`), the other will see that the file hasn't changed since the last check and skip re-processing.

**Performance considerations:** Reconciliation only runs for comments on files that have actually changed (checked via `fs.stat` mtime comparison). For a typical feedback session with 10-30 comments across a few files, this is negligible — a few file reads and string comparisons. The anchor-matching algorithm itself is O(n) in file length per comment, which is fine for source files.

**Shared logic:** The re-anchoring algorithm should be identical in both the CLI and the extension. In practice, the extension is TypeScript and the CLI is a standalone Node.js script, so the implementations will be separate. However, the algorithm (content matching, context window comparison, staleness threshold) must behave the same way. Consider extracting the algorithm into a shared `.js` file that both can import, or at minimum, ensure the logic is well-specified enough that two implementations produce the same results.

**File deletion:** When the CLI encounters a comment whose target file no longer exists on disk, it marks the comment as **orphaned**. Orphaned comments are still visible in listings (with an `[orphaned]` flag) but are excluded from `context` output (there's no file to show context from). The developer can dismiss orphaned comments or, if the file was renamed/moved, manually re-anchor them via the extension.

**Future improvement: git-based optimization.** The reconciliation could be made smarter by using `git diff --name-only` to identify which files have changed, and even using diff hunk information for mechanical line-number remapping before falling back to content-based matching. This is a v2 optimization — the content-based approach is sufficient for v1, and git-based remapping would be an acceleration, not a replacement.

### 4.4 Staleness and Orphan Display

Comments can be in one of four states: **open** (active, anchor is valid), **resolved** (addressed, closed by either party), **stale** (the target code has changed substantially and the anchor could not be confidently re-established), or **orphaned** (the target file no longer exists).

The extension should visually distinguish these — different icon colors, labels, or dimming. Stale and orphaned comments aren't deleted; they're flagged for human review. The developer can re-anchor stale comments manually (click to move to the right location), dismiss them, or leave them for the agent to address.

The CLI reports these states clearly in its output so the agent can also understand which comments might be outdated.

---

## 5. VS Code Extension

### 5.1 Core Technology: Comments API

The extension uses VS Code's [Comments API](https://code.visualstudio.com/api/extension-guides/comments) rather than building custom UI. This API provides:

- A `CommentController` that manages comment threads.
- `CommentingRangeProvider` to define which lines are commentable (all lines, in our case).
- Inline comment thread widgets with reply boxes.
- Resolve/unresolve state per thread.
- Gutter icons indicating commented lines.

This gives us the PR review UX essentially for free. The extension's job is to wire this API to our store and handle persistence, anchoring, and agent integration.

### 5.2 Extension Commands

The extension should register the following commands:

**Feedback: Add Comment** — Opens a comment thread at the current cursor position or selection. The developer types their feedback and it is saved to the store with status `open`. The comment is immediately visible to the CLI — there is no draft or queue state. The developer controls when the agent sees feedback by controlling when they tell the agent to check (via the main conversation or skill-prompted behavior), not by managing comment visibility.

**Feedback: Setup Agent Integration** — Runs a guided setup flow: initializes `.feedback/`, deploys the CLI, optionally updates `.gitignore`, and optionally writes selected agent integrations. See Section 8.

On first run in a workspace without `.feedback/store.json`, the extension should surface a lightweight setup prompt so onboarding is discoverable without forcing side effects.

**Feedback: Show All Comments** — Opens a tree view / panel showing all feedback across the project, grouped by file, filterable by status (open/resolved/stale/orphaned).

**Feedback: Archive Resolved** — Moves resolved threads out of the active store (into an archive file or deletes them) to prevent unbounded growth.

**Feedback: Reconcile All** — Forces a full re-anchoring pass across all comments. Useful after a large batch of changes or when the developer knows things have shifted significantly.

**Why no queue or dispatch:** We considered a queue model where comments start as drafts and are explicitly dispatched. However, the extension has no mechanism to inject messages into the agent's conversation — the agent discovers feedback by running the CLI, which is always initiated from the agent's side (either by the developer prompting it, or by the skill file instructing the agent to check). Since the developer already controls timing through when they prompt the agent, a separate queue/dispatch layer adds complexity without enabling anything new. The developer does their review, adds all their comments, then tells the agent to go look. The comments are already there.

### 5.3 File Watching and Agent Response Rendering

The extension watches `.feedback/store.json` for changes. When the agent writes a reply via the CLI, the store file changes, the extension detects this, and re-renders the affected comment thread — the agent's reply appears inline, just like a human's would. The agent's comments should be visually distinct (different author label, possibly different styling).

This is the key mechanism for bidirectional communication: the extension writes comments, the agent reads them via CLI, writes replies via CLI, and the extension picks up the replies via file watching. No IPC, no server, no protocol — just filesystem-mediated message passing.

### 5.4 Extension Re-Anchoring

The extension must re-anchor comments for any file the developer opens or is viewing. The developer should never see comments pointing at the wrong lines. This means re-anchoring on file open, on external file change detection, and during active editing (see Section 4.3 for details on how the extension and CLI share this responsibility).

The extension does not need to re-anchor comments for files that are not open — the CLI handles those on its next read.

---

## 6. CLI Tool

### 6.1 Implementation

The CLI is a standalone Node.js script with **zero npm dependencies** — only Node builtins (`fs`, `path`, `crypto`, `process`). It is invoked through a shell wrapper for ergonomic use.

**Shell wrapper** (`.feedback/bin/feedback-cli`):
```sh
#!/bin/sh
exec node "$(dirname "$0")/feedback-cli.js" "$@"
```

**Why Node.js:** JSON is the native data format. Content-based anchor matching requires string similarity comparisons that are painful in pure shell. Node is guaranteed to be present for any developer using VS Code (which requires Node), and a single `.js` file with no dependencies requires zero installation.

### 6.2 Commands

```
feedback-cli list [--status open|resolved|stale|orphaned|all] [--file <path>]
    List comments, optionally filtered. Default: all open comments.
    Output: structured text or JSON (--json flag).

feedback-cli get <comment-id>
    Get a single comment with its full thread and context.
    Output: the comment body, all replies, file path, line info, and
    a snippet of the surrounding code for context.

feedback-cli reply <comment-id> --message "..."
    Add a reply to a comment thread. Sets author to "agent".

feedback-cli resolve <comment-id>
    Mark a comment as resolved.

feedback-cli summary
    High-level summary: N open comments across M files.
    Useful for the agent to quickly check if there's pending feedback.

feedback-cli context <comment-id>
    Output the comment along with the actual current file content
    around the anchor point (e.g., 10 lines before and after).
    This gives the agent the code context alongside the feedback.
```

Every read command (`list`, `get`, `context`, `summary`) performs lazy reconciliation before returning results (see Section 4.3). This ensures the agent always sees accurate, up-to-date anchor positions regardless of when or how the files were modified.

### 6.3 Output Format

Default output should be human-readable structured text (suitable for an agent to consume in a conversation). A `--json` flag on every command provides machine-readable output for more sophisticated integrations.

Example `list` output:
```
3 open comments:

[c_abc123] src/auth/login.ts:45-47 (open)
  "This should return a Result type instead of throwing."
  2 replies, last reply from: agent

[c_def456] src/auth/session.ts:12 (open)
  "Missing null check on session object"
  0 replies

[c_ghi789] README.md:30-35 (stale)
  "This section needs to be updated after the API changes"
  1 reply, last reply from: human
```

---

## 7. Conversation Flow

This section covers how feedback flows between the extension and the agent, and how the two conversation contexts (main chat and comment threads) relate to each other.

### 7.1 Comment Lifecycle

Comments are `open` the moment the developer creates them. There is no draft, queue, or dispatch step. The developer does their review pass in VS Code, adding comments across files, and those comments are immediately present in the store.

The developer controls when the agent sees the feedback by controlling when they tell the agent to look — either by prompting it directly in the main conversation, or by relying on the skill file's instructions for the agent to check periodically. This is simpler than a queue model and maps to how the developer already interacts with the agent.

### 7.2 How the Agent Discovers Feedback

The agent discovers feedback through the CLI, prompted by the skill file or by the developer.

**Skill-prompted discovery:** The skill file instructs the agent to check for pending feedback at natural workflow transition points. For example: "Before beginning implementation of a plan, run `feedback-cli summary` to check if the developer has left inline feedback. If there are open comments, run `feedback-cli list` and address them before proceeding." This makes feedback checking part of the agent's habitual workflow without requiring the developer to remember to prompt it.

**Developer-prompted discovery:** The developer tells the agent in the main chat: "I've left inline feedback on the auth module — check `feedback-cli list --file src/auth/` and address it." This gives the developer explicit control and allows targeting by file or scope.

**What we are NOT building for v1:** We are not building a mechanism for the extension to inject messages into the agent's chat session. This would require deep, agent-specific integration (hooking into Claude Code's VS Code extension API, writing to Codex/OpenCode stdin, etc.) and is fragile across agent versions. The skill-prompted and developer-prompted paths are reliable and sufficient.

### 7.3 Targeted Review via Skill Invocation

The skill file should document how to filter feedback. When the developer says "check my feedback on @src/auth/login.ts" in the agent chat, the agent knows (from the skill) to run `feedback-cli list --file src/auth/login.ts`. The `@`-mention file reference syntax already exists in Claude Code and Codex, so this composes naturally with existing agent UX.

The skill file should also instruct the agent on how to handle different comment states: process `open` comments and note `stale` ones (flag them to the developer rather than acting on potentially outdated feedback).

### 7.4 Comment Threads vs. Main Conversation

A comment thread is a *scoped* discussion about a specific code location. The main conversation is the broader task context. These should be complementary:

- The developer uses comment threads for specific, located feedback ("this line should do X").
- The developer uses the main conversation for high-level direction ("now implement the changes from my review").
- The agent uses comment threads for located responses ("agreed, I'll change this") and the main conversation for broader status updates ("I've addressed all 5 feedback items, here's a summary").
- If the agent finds that the overall set of comments suggests a significant directional disagreement (not just line-level fixes), it should raise this in the main conversation rather than replying piecemeal in threads.

The skill file should explain these conventions to the agent.

### 7.5 What Happens to Conversation History

Comment threads are *not* part of the main conversation history. They exist in the feedback store. The agent accesses them via CLI calls, which appear in the main conversation as tool use (the agent ran a command and got output). This means:

- The main conversation stays clean — it's not polluted with every inline comment.
- The agent can reference specific comments by ID when discussing them in the main conversation.
- If the main conversation context window fills up, the comment threads are still available via CLI (they're on disk, not in the chat history).

---

## 8. Agent Integration and Setup

### 8.1 Skill Files

The "Setup Agent Integration" command can write skill files into the project when the developer explicitly opts in. Each skill file explains the feedback system to the agent: what the CLI commands are, what the conventions are, and how to use them.

**For Claude Code:** `.claude/skills/feedback-loop/SKILL.md`

**For OpenCode:** `.opencode/skills/feedback-loop/SKILL.md` (OpenCode also reads `.claude/skills/` as a fallback, so the Claude Code file might suffice, but having a dedicated one is cleaner.)

**For Codex:** Codex reads `AGENTS.md` (or similar convention files). The setup command should append a section to the project's `AGENTS.md` (or create one) documenting the feedback CLI. Alternatively, if Codex supports a skill-file convention similar to Claude Code, use that.

**Skill file content should include:**
- What the feedback system is and why it exists.
- The full CLI command reference with examples.
- Conventions: when to reply in a thread vs. elevate to the main conversation, how to handle stale comments, when to resolve threads.
- A note that the feedback store is at `.feedback/store.json` and can be read directly if needed, but the CLI is preferred.

### 8.2 Setup Command Behavior

When the developer runs "Feedback: Setup Agent Integration":

1. Create `.feedback/` directory if it doesn't exist.
2. Create `.feedback/bin/` and copy/generate the CLI tool files.
3. Add `.feedback/` to `.gitignore` (append if `.gitignore` exists, create if not). Check for existing entries to avoid duplicates.
4. Run a guided setup flow (extension-first onboarding) with explicit choices:
   - Initialize/repair project-local Feedback Loop files (required baseline).
   - Add `.feedback/` to `.gitignore` (recommended default: yes).
   - Install/update agent integrations (optional, explicit opt-in).
5. If integrations are selected, detect existing agent footprints and let the developer confirm targets (Claude/OpenCode/Codex) before writing files.
6. Print a summary of what was set up.

For v1, the feedback store location remains fixed at `<project-root>/.feedback/` and is not user-configurable.

### 8.3 No MCP (For Now)

We are deliberately not implementing an MCP server for v1. The rationale:

- The CLI + skill file approach covers all three target agents (Claude Code, Codex, OpenCode).
- All three agents can execute shell commands natively.
- MCP adds operational complexity (a running server process) without providing capabilities we can't get from the CLI.
- MCP may be added later for VS Code Copilot agent mode integration or for agents running in contexts where shell execution isn't available.

The architecture accommodates MCP later because the CLI and a future MCP server would wrap the same store logic. The CLI's command structure maps directly to MCP tool definitions.

---

## 9. Open Questions and Known Complexities

These are issues identified during design that need further investigation or decisions during implementation.

### 9.1 Anchor Drift in the Extension UI

Both the CLI and the extension perform reconciliation (Section 4.3). For the extension, the key question is handling real-time edits: if the developer is actively typing in a file with comments, line positions shift with every keystroke. VS Code's Comments API stores comment positions as `Range` objects which may be automatically adjusted by the editor on text changes — this needs investigation during implementation. If the Comments API handles range tracking natively, the extension just needs to persist updated positions back to the store periodically. If not, the extension needs to run the re-anchoring algorithm on document change events (debounced to avoid excessive computation).

External changes (agent edits a file the developer has open) should also trigger re-anchoring via VS Code's file change detection.

### 9.2 Multi-File Comments and Grouping

Comments are anchored to a single file and line range for v1. Cross-file concerns ("this function in auth.ts doesn't match the interface in types.ts") should be handled in the main conversation.

**v2 enhancement: labels.** A labeling system would allow the developer to tag related comments across files with a shared label (e.g., "error-handling-pattern"), enabling grouped filtering (`feedback-cli list --label error-handling-pattern`) and helping the agent see thematic connections across individual comments. The data model accommodates this (a `labels: string[]` field on comments) but the implementation is deferred to v2.

### 9.3 Concurrent Access

Both the extension and the CLI can write to `store.json` simultaneously (e.g., the developer adds a comment while the agent is writing a reply). With a single JSON file, this is a last-write-wins race condition. Mitigation options:
- File locking (flock or similar) in both the extension and CLI.
- Optimistic concurrency with read-merge-write (read the file, apply the change, write back, retry if the file changed between read and write).
- Accept the race and document it as a known limitation for v1.

Given that simultaneous writes are unlikely (the developer adds comments during review, then the agent processes them sequentially), this is probably a v2 concern. But the implementation should at least use atomic writes (write to temp file, rename) to avoid corrupt reads.

### 9.4 Large Projects and Performance

For most projects, the feedback store will be small (tens to low hundreds of comments). But we should avoid pathological cases:
- Reconciliation (both CLI and extension) should only process comments for files that have actually changed, not the entire store.
- The tree view should be lazy-loaded or virtualized if the comment count gets large.
- Resolved/archived comments should be moved out of the active store.

### 9.5 Extension Language/Framework and Shared Logic

The extension itself will be TypeScript (this is the standard and effectively required language for VS Code extensions). The CLI is a standalone Node.js script. They share the same store format and both implement the re-anchoring algorithm.

Because both the CLI and extension perform reconciliation, the re-anchoring logic must produce consistent results. The preferred approach is to extract the algorithm into a shared `.js` file that both the extension and CLI can import. If this creates unacceptable coupling for the CLI (which is meant to be self-contained and dependency-free), the alternative is to keep separate implementations but ensure they are well-specified and tested against the same cases.

### 9.6 What "Resolve" Means

When a comment is resolved, does that mean:
- The feedback was addressed (the agent made the change)?
- The feedback was acknowledged (the agent replied and the human is satisfied)?
- The thread is simply closed (either party can resolve)?

Leaning toward: either party can resolve, and resolution is a soft state (can be reopened). The semantics are "this thread no longer needs attention," not "this issue is verified fixed." Verification happens in the main conversation or in a subsequent review pass.

### 9.7 Comment Authorship

The data model has `author: "human" | "agent"`. But what if the developer uses multiple agents, or what if two humans are annotating? For v1, two authors is sufficient — the developer is "human," the agent is "agent." If this needs to expand later, the field can become a free-form string without breaking the schema.

### 9.8 Skill File Maintenance

The skill file is a static snapshot copied during setup. If the CLI commands change (e.g., in an extension update), the skill file becomes stale. The extension should either:
- Regenerate skill files on extension update.
- Version the skill files and check/warn on mismatch.
- Keep the skill files minimal enough that they rarely need updating.

---

## 10. Existing Work and Prior Art

Several existing VS Code extensions were evaluated during design. None solve this problem, but they informed the approach.

### 10.1 Vibe Notes (hatappo/vscode-extension-vibe-notes)

The closest match. Stores notes in a gitignored `.notes/` directory, attaches them to specific lines, shows inline indicators, and has a "Copy for LLM" feature. However: no bidirectional agent integration (copy-paste only), no threading/reply model, no MCP or CLI, line-number-based anchoring only (semantic anchoring is on their roadmap but not implemented). Very early stage (v0.4.0, ~1 star). MIT licensed.

### 10.2 Out-of-Code Insights (JacquesGariepy/out-of-code-insights)

Feature-rich annotation extension with threaded replies, severity levels, tags, Kanban board, linked annotations, review mode, and multi-LLM provider support. However: its AI integration is self-contained (calls LLM APIs directly within the extension to generate annotations). It does not bridge to an external agent conversation. No CLI, no MCP, no skill files. The AI features are "have the extension generate annotations" rather than "communicate with your agent." Line-number-based anchoring with basic in-VS Code change tracking.

### 10.3 Local Comments (marcel-rsoub/local-comments)

Lightweight local comment storage with sidebar panel and search. Supports line and text-selection comments. No threading, no agent integration, no CLI. Too minimal for our use case but validates that the "local, git-invisible annotations" concept has demand.

### 10.4 vscode-code-review (d-koppenhagen/vscode-code-review)

Stores review notes in a CSV file, supports line/range annotations, exports to HTML/Markdown/GitLab/GitHub formats. Oriented toward producing a review deliverable, not toward ongoing conversation. One-directional (human writes, then exports). Pinned to git SHAs, which adds friction for iterative workflows.

### 10.5 GitHub Pull Requests Extension

The UX gold standard for inline code comments. Uses VS Code's Comments API (which we'll also use). However: tightly coupled to GitHub's remote infrastructure, requires a PR to exist, and doesn't work for local/unpushed annotation. Not usable for our case, but the UX is what we're emulating.

---

## 11. MVP Scope and Build Order

The recommended build order, with each step producing a usable increment:

**Phase 1: Store format + CLI skeleton** — Define the JSON schema and build the CLI tool with basic operations: `list`, `get`, `reply`, `resolve`, `summary`. No reconciliation yet — just reads/writes to the store with static line numbers. This is testable independently by hand-editing `store.json`.

**Phase 2: Extension skeleton** — Get the VS Code Comments API wired up. The developer can add comments on lines, see them in the gutter, reply to them, and resolve them. Comments persist to `.feedback/store.json`. File watching picks up external changes to the store (agent replies). This is a usable local annotation tool.

**Phase 3: Content-based anchoring** — Implement the anchor data model, mtime-based change detection, and the re-anchoring algorithm. This logic must work in both the CLI (lazy on read) and the extension (on file open, external change, and active editing). Test with various edit patterns: insertions above a comment, deletions, function renames, file deletions. Implement staleness and orphan detection. This is the riskiest technical piece and should be tackled early.

**Phase 4: Agent integration setup** — Implement the "Setup Agent Integration" command. Write the skill files for Claude Code, OpenCode, and Codex. Test the full loop: developer adds comments in VS Code → tells agent (or agent checks via skill-prompted behavior) → agent reads via CLI → agent replies via CLI → developer sees replies inline.

**Phase 5: Polish** — Tree view panel for all comments, archive/cleanup for resolved threads, visual refinements (stale/orphaned indicators), Reconcile All command, stale comment management UX.

**Phase 6: Testing hardening** — Add VS Code Extension Host integration tests (`@vscode/test-electron` / `@vscode/test-cli`) to validate command-level end-to-end behavior in fixture workspaces. Keep `npm test` as a fast PR gate and add slower UI/host smoke checks as release/nightly verification.

**Phase 7: Onboarding and installation UX** — Replace implicit setup side effects with a guided setup flow in the extension. Keep `.feedback/` at project root for v1, make agent integration writes explicit opt-in, and improve first-run discoverability/documentation for end users.

---

## 12. Success Criteria

The system is working when the following workflow is smooth and unbroken:

1. Developer opens VS Code, reviews code the agent wrote.
2. Developer clicks on lines, types comments. Each comment is immediately `open` in the store. Repeats across multiple files.
3. Developer tells the agent (in their normal chat): "I've left inline feedback on the auth module, check it." Alternatively, the agent checks on its own because the skill file instructs it to run `feedback-cli summary` before starting work.
4. Agent runs `feedback-cli list`, sees the comments with accurate line numbers (reconciled lazily by the CLI even if files changed since the comments were written).
5. Agent runs `feedback-cli context <id>` for each, reads the feedback with surrounding code.
6. Agent runs `feedback-cli reply <id> --message "..."` for each, responding to the feedback.
7. Developer sees the agent's replies appear inline in VS Code, right next to their original comments.
8. Developer resolves the ones they're satisfied with, continues the conversation on the ones they're not.
9. Agent makes the agreed-upon code changes.
10. Developer does another review pass. Comments on changed code are flagged as stale (detected by reconciliation). Comments on deleted files are marked orphaned. New comments are added. The developer never sees a comment pointing at the wrong line for a file they have open.
11. The cycle continues until the work is done.

At no point does git see any of this. At no point does the developer reference a line number by hand. At no point does the main conversation get cluttered with the full text of every inline comment.
