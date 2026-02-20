# Consider

Consider adds PR-style inline feedback threads to local files for developer + agent workflows.

You comment in VS Code. Your agent replies via a local CLI. Comment data stays in `.consider/`, not in code.

## Features

- Inline comment threads anchored to files and line ranges.
- Agent replies synced through a shared filesystem store.
- Content-based anchor reconciliation after code edits.
- Workflow + anchor state tracking:
  - `workflowState`: `open` / `resolved`
  - `anchorState`: `anchored` / `stale` / `orphaned`
- Consider comments tree view in Explorer for file-grouped navigation.
- Archive resolved comments.
- Guided setup and uninstall flows for agent integration artifacts.

## 60-Second Quick Start

1. Install the extension.
2. Open a workspace folder.
3. Run `Consider: Setup Agent Integration`.
4. In setup, choose `.gitignore` handling, integrations, and workspace/home install scope.
5. Add an inline comment using the gutter `+` (or `Add Comment`).
6. In terminal, run:
   ```sh
   .consider/bin/consider-cli list
   .consider/bin/consider-cli reply <comment-id> --message "I will fix this."
   ```

## Agent CLI (Most Used)

```sh
.consider/bin/consider-cli list [--workflow open|resolved|all] [--anchor anchored|stale|orphaned|all] [--unseen] [--file <path>] [--json]
.consider/bin/consider-cli get <comment-id> [--json]
.consider/bin/consider-cli context <comment-id> [--lines N] [--json]
.consider/bin/consider-cli reply <comment-id> --message "..."
.consider/bin/consider-cli resolve <comment-id>
.consider/bin/consider-cli unresolve <comment-id>
.consider/bin/consider-cli summary [--json]
```

## Core Commands

- `Add Comment`
- `Reply`
- `Resolve` / `Unresolve`
- `Consider: Setup Agent Integration`
- `Consider: Uninstall`
- `Consider: Show All Comments`
- `Consider: Archive Resolved`
- `Consider: Reconcile All`

## Trust And Privacy

- Comment data is stored in workspace-local `.consider/`.
- The setup flow can add `.consider/` to `.gitignore`.
- No external service is required for core feedback storage and syncing.

## Troubleshooting

- If comments appear stale after heavy edits, run `Consider: Reconcile All`.
- If the extension is installed but not initialized in a workspace, run `Consider: Setup Agent Integration`.
- For UI/platform caveats, see known limitations in the repository docs.

## Project Links

- Repository: <https://github.com/VarunKanwar/consider>
- User + repo overview: <https://github.com/VarunKanwar/consider/blob/main/README.md>
- Specification: <https://github.com/VarunKanwar/consider/blob/main/docs/spec.md>
- Known limitations: <https://github.com/VarunKanwar/consider/blob/main/docs/known-limitations.md>
