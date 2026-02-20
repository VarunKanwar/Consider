# Manual Testing Guide — Consider Extension

## Prerequisites

1. Clone the repository and open it in VS Code.
2. Install extension dependencies: `cd extension && npm install`
3. Compile: `cd extension && npm run compile`

## Test 1: Launch Extension in Development Mode

1. Open the `consider` repo in VS Code.
2. Press **F5** (or Run > Start Debugging). Select "Run Extension" if prompted.
3. A new VS Code window (Extension Development Host) should open.
4. **Expected:** No errors in the Debug Console. The extension is active immediately on startup (no command needed first).
5. If the workspace does not yet have `.consider/store.json`, **Expected:** a one-time setup prompt appears with actions like **Set Up Now** / **Later**.

## Test 2: Setup

1. In the Extension Development Host window, open any project folder.
2. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P).
3. Run **Consider: Setup**.
4. In the guided flow:
   - use the single setup panel to:
     - choose whether to add `.consider/` to `.gitignore`,
     - check/uncheck integrations (Claude/OpenCode/Codex),
     - set install location per selected integration (`Workspace` or `Home`) with the scope switch.
4. **Expected:**
   - `.consider/store.json` exists.
   - `.consider/bin/consider-cli`, `.consider/bin/consider-cli.js`, and `.consider/bin/consider-cli.cjs` exist.
   - `.consider/bin/package.json` exists with `"type": "commonjs"`.
   - `.consider/shared/store.js` and `.consider/shared/reconcile.js` exist.
   - `.consider/shared/package.json` exists with `"type": "commonjs"`.
   - If `.gitignore` update was selected, `.gitignore` contains `.consider/` exactly once.
   - If no integrations are selected, no new skill files are written.
   - If integrations were selected, only selected targets are written/updated using each target's selected location:
     - Workspace install:
       - Claude: `.claude/skills/consider/SKILL.md`
       - OpenCode: `.opencode/skills/consider/SKILL.md`
       - Codex: `.codex/skills/consider/SKILL.md`
     - Home install:
       - Claude: `~/.claude/skills/consider/SKILL.md`
       - OpenCode: `~/.opencode/skills/consider/SKILL.md`
       - Codex: `~/.codex/skills/consider/SKILL.md`
   - Any written `SKILL.md` starts with YAML frontmatter containing:
     - `name: consider`
     - `description: ...`

## Test 3: Add a Comment

1. Open any source file in the Extension Development Host.
2. Preferred path: hover over the glyph margin (left of line numbers) on any line — you should see a `+` icon appear.
3. Click the `+` icon to create a new comment thread.
4. Type a comment (e.g., "This function should handle errors") and click the submit button (checkmark or press Cmd+Enter).
5. Alternate path: run **Add Comment** from Command Palette and enter the comment in the prompt.
6. **Expected:**
   - The comment appears inline next to the line.
   - Author shows as "Developer".
   - `.consider/store.json` now contains the comment with correct file path, line numbers, and body text.
   - The comment has `"workflowState": "open"` and `"anchorState": "anchored"`.

If the `+` icon never appears:
- Ensure `"editor.glyphMargin": true` in settings.
- Ensure the file is on disk (not an untitled buffer) and the extension host window has an open workspace folder.
- For known VS Code rendering edge cases (for example, duplicate `+` glyphs with word wrap), see `docs/known-limitations.md`.

## Test 4: Reply to a Comment

1. With a comment thread open, type a reply in the reply box.
2. Submit the reply.
3. **Expected:**
   - The reply appears below the original comment.
   - The store is updated with the reply in the comment's `thread` array.
   - The reply has author `"human"` and a reply ID starting with `r_`.

## Test 5: Resolve a Comment

1. On an open comment thread, click the **Resolve** button (checkmark icon in the thread title bar).
2. **Expected:**
   - The thread visually changes to resolved state (may appear dimmed/collapsed).
   - The thread header/status labels show resolved + anchor state indicators.
   - Reply UI is disabled while resolved.
   - The store shows `"workflowState": "resolved"` for this comment.

## Test 6: Reopen a Resolved Comment

1. Find a resolved comment thread and click **Reopen**.
2. **Expected:**
   - The thread returns to open/unresolved state.
   - Reply UI is enabled again.
   - The store shows `"workflowState": "open"` again.

## Test 7: Delete a Comment

1. Hover over a comment in a thread and click the **Delete** button.
2. **Expected:**
   - If it's the root comment (first in thread), the entire thread is removed from the editor and from the store.
   - If it's a reply, only that reply is removed.

## Test 8: Agent Reply via CLI (Bidirectional Communication)

This is the key test for the file watcher.

1. Add a comment in the Extension Development Host (from Test 3).
2. Note the comment ID from `.consider/store.json` (e.g., `c_abc12345`).
3. Open a terminal in the project directory.
4. Run:
   ```sh
   .consider/bin/consider-cli reply c_abc12345 --message "I will fix this."
   ```
   (Use the actual comment ID from your store.)
5. **Expected:**
   - Within ~1 second, the agent's reply appears inline in VS Code.
   - The reply shows author "Agent" with label "Agent".
   - The store now has the reply in the thread array with `"author": "agent"`.

## Test 9: Startup Load from Existing Store

1. With comments in the store, close and reopen the Extension Development Host (re-launch with F5).
2. Open a file that has comments in the store.
3. **Expected:**
   - All existing comments and threads render at the correct line positions.
   - Resolved comments appear in their resolved state.

## Test 10: Multiple Files

1. Add comments to different files.
2. Switch between the files.
3. **Expected:**
   - Comments appear on the correct files and lines.
   - All comments are tracked in a single `store.json`.
   - `consider-cli list` shows all comments.

## Test 11: Show All Comments Tree View

1. Ensure you have comments across at least two files and mixed statuses.
2. Run **Consider: Show All Comments**.
3. Use the visibility checkboxes:
   - **Show resolved**
   - **Show stale**
4. **Expected:**
   - Explorer shows a **Consider Comments** view.
   - Comments are grouped by file.
   - Comment rows show richer workflow/anchor state tags and comment ID in the description.
   - Selecting a comment row opens the target file and reveals the anchor line.
   - Each comment row has an inline toggle action (collapse icon) that collapses/expands only that comment thread.
   - Checkbox state updates visible comments in both:
     - the **Consider Comments** tree,
     - the built-in VS Code **COMMENTS** panel (hidden threads are removed from the panel until re-enabled).

## Test 12: Archive Resolved

1. Resolve one or more comment threads.
2. Run **Consider: Archive Resolved**.
3. **Expected:**
   - Resolved comments are removed from `.consider/store.json`.
   - Archived records are appended to `.consider/archive.json`.
   - Non-resolved workflow comments remain in active store (regardless of anchor state).
   - Running again with no resolved comments reports a no-op message.

## Test 13: CLI Summary Check

1. With several comments in the store, run:
   ```sh
   .consider/bin/consider-cli summary
   ```
2. **Expected:** Shows the correct count of open comments and files.
   - Also shows unseen-open count and workflow/anchor breakdowns.

## Test 14: Setup Idempotency

1. Run **Consider: Setup** twice with:
   - `.gitignore` update enabled,
   - Codex integration selected.
2. **Expected:**
   - No duplicate `.consider/` entries in `.gitignore`.
   - Existing skill files are refreshed in place (single file per target path for the selected install scope).
   - Codex skill exists at `.codex/skills/consider/SKILL.md` (workspace scope) or `~/.codex/skills/consider/SKILL.md` (home scope).

## Test 15: Uninstall / Offboarding

1. Ensure setup has run and at least one integration skill is installed.
2. Run **Consider: Uninstall** from the Command Palette.
3. In the uninstall flow, choose **Skills only**.
4. **Expected:**
   - Installed skills tracked by setup are removed.
   - `.consider/store.json` remains.
   - `.consider/config.json` remains and tracked skill list is cleared.
5. Run **Consider: Setup** again and install at least one integration.
6. Run **Consider: Uninstall** and choose **Full uninstall**.
7. **Expected:**
   - `.consider/` directory is removed.
   - Tracked skills are removed.
   - `.consider/` entry is removed from `.gitignore` if present.
   - Completion message summarizes removed/retained artifacts.

## Test 16: No Workspace Folder

1. Open VS Code with no folder open (File > Close Folder).
2. Launch the extension (F5).
3. Try running any Consider command from the Command Palette.
4. **Expected:** A warning message says "Consider requires an open workspace folder."
