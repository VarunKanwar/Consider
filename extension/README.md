# Consider

Consider is a VS Code extension for inline, bidirectional feedback between developers and AI coding agents.

It gives you PR-style comment threads inside local files, while keeping feedback out of source code and out of git history.

## Features

- Inline comment threads anchored to files and line ranges.
- Agent replies synced through a shared filesystem store.
- Content-based anchor reconciliation after code edits.
- Workflow state and anchor state tracking:
  - workflow: `open` / `resolved`
  - anchor: `anchored` / `stale` / `orphaned`
- Feedback tree view in Explorer for file-grouped navigation.
- Archive resolved comments.
- Guided setup and uninstall flows for agent integration artifacts.

## Quick Start

1. Install the extension.
2. Open a workspace folder.
3. Run `Feedback: Setup Agent Integration`.
4. Leave inline comments using the gutter `+` affordance or command palette.
5. Use the project-local CLI at `.feedback/bin/feedback-cli` for agent-side operations.

## Core Commands

- `Add Comment`
- `Feedback: Setup Agent Integration`
- `Feedback: Uninstall`
- `Feedback: Show All Comments`
- `Feedback: Archive Resolved`
- `Feedback: Reconcile All`

## Data and Privacy

- Feedback data is stored in workspace-local `.feedback/`.
- The setup flow can add `.feedback/` to `.gitignore`.
- No external service is required for core feedback storage and syncing.

## Troubleshooting

- If comments appear stale after heavy edits, run `Feedback: Reconcile All`.
- If the extension is installed but not initialized in a workspace, run `Feedback: Setup Agent Integration`.
- For UI/platform caveats, see known limitations in the repository docs.

## Project Links

- Repository: <https://github.com/VarunKanwar/consider>
- Specification: <https://github.com/VarunKanwar/consider/blob/main/docs/spec.md>
- Known limitations: <https://github.com/VarunKanwar/consider/blob/main/docs/known-limitations.md>
