# Manual Testing Guide — Feedback Loop Extension

## Prerequisites

1. Clone the repository and open it in VS Code.
2. Install extension dependencies: `cd extension && npm install`
3. Compile: `cd extension && npm run compile`

## Test 1: Launch Extension in Development Mode

1. Open the `feedback-loop` repo in VS Code.
2. Press **F5** (or Run > Start Debugging). Select "Run Extension" if prompted.
3. A new VS Code window (Extension Development Host) should open.
4. **Expected:** No errors in the Debug Console. The extension is active immediately on startup (no command needed first).

## Test 2: Setup Agent Integration

1. In the Extension Development Host window, open any project folder.
2. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P).
3. Run **Feedback: Setup Agent Integration**.
4. **Expected:**
   - `.feedback/store.json` exists.
   - `.feedback/bin/feedback-cli` and `.feedback/bin/feedback-cli.js` exist.
   - `.gitignore` contains `.feedback/` exactly once.
   - If `.claude/` exists, `.claude/skills/feedback-loop/SKILL.md` is written.
   - If `.opencode/` exists, `.opencode/skills/feedback-loop/SKILL.md` is written.
   - If `AGENTS.md` exists, a Feedback Loop section is appended/updated.
   - If none of those agent configs exist, setup creates all three integrations.

## Test 3: Add a Comment

1. Open any source file in the Extension Development Host.
2. Preferred path: hover over the glyph margin (left of line numbers) on any line — you should see a `+` icon appear.
3. Click the `+` icon to create a new comment thread.
4. Type a comment (e.g., "This function should handle errors") and click the submit button (checkmark or press Cmd+Enter).
5. Alternate path: run **Feedback: Add Comment** from Command Palette and enter the comment in the prompt.
6. **Expected:**
   - The comment appears inline next to the line.
   - Author shows as "Developer".
   - `.feedback/store.json` now contains the comment with correct file path, line numbers, and body text.
   - The comment has status `"open"`.

If the `+` icon never appears:
- Ensure `"editor.glyphMargin": true` in settings.
- Ensure the file is on disk (not an untitled buffer) and the extension host window has an open workspace folder.

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
   - The store shows `"status": "resolved"` for this comment.

## Test 6: Reopen a Resolved Comment

1. Find a resolved comment thread and click **Reopen**.
2. **Expected:**
   - The thread returns to open/unresolved state.
   - The store shows `"status": "open"` again.

## Test 7: Delete a Comment

1. Hover over a comment in a thread and click the **Delete** button.
2. **Expected:**
   - If it's the root comment (first in thread), the entire thread is removed from the editor and from the store.
   - If it's a reply, only that reply is removed.

## Test 8: Agent Reply via CLI (Bidirectional Communication)

This is the key test for the file watcher.

1. Add a comment in the Extension Development Host (from Test 3).
2. Note the comment ID from `.feedback/store.json` (e.g., `c_abc12345`).
3. Open a terminal in the project directory.
4. Run:
   ```sh
   .feedback/bin/feedback-cli reply c_abc12345 --message "I will fix this."
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
   - `feedback-cli list` shows all comments.

## Test 11: Show All Comments Tree View

1. Ensure you have comments across at least two files and mixed statuses.
2. Run **Feedback: Show All Comments**.
3. Pick a filter (e.g., **Open only**).
4. **Expected:**
   - Explorer shows a **Feedback Comments** view.
   - Comments are grouped by file.
   - Comment rows show status and comment ID in the description.
   - Selecting a comment row opens the target file and reveals the anchor line.
   - Filter choice updates visible comments by status.

## Test 12: Archive Resolved

1. Resolve one or more comment threads.
2. Run **Feedback: Archive Resolved**.
3. **Expected:**
   - Resolved comments are removed from `.feedback/store.json`.
   - Archived records are appended to `.feedback/archive.json`.
   - Open/stale/orphaned comments remain in active store.
   - Running again with no resolved comments reports a no-op message.

## Test 13: CLI Summary Check

1. With several comments in the store, run:
   ```sh
   .feedback/bin/feedback-cli summary
   ```
2. **Expected:** Shows the correct count of open comments and files.

## Test 14: Setup Idempotency

1. Run **Feedback: Setup Agent Integration** twice.
2. **Expected:**
   - No duplicate `.feedback/` entries in `.gitignore`.
   - No duplicate Feedback Loop section in `AGENTS.md`.
   - Existing skill files are refreshed, not duplicated with extra copies.

## Test 15: No Workspace Folder

1. Open VS Code with no folder open (File > Close Folder).
2. Launch the extension (F5).
3. Try running any Feedback command from the Command Palette.
4. **Expected:** A warning message says "Feedback Loop requires an open workspace folder."
