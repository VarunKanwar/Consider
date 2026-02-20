# Consider

_Consider_ adds pull request-style inline feedback threads to VS Code, streamlining mixed initiative (developer + agent) workflows.

Add comments and invoke the `consider` skill. Your agent considers your feedback and replies or acts, and eventually resolves open threads. Conversation history is stored locally, separate from your code.

TODO: GIF showing the flow of comment creation in the editor -> skill invocation -> agent response in the thread

## Features

- Inline comment threads anchored to files and line ranges.
- Agent replies synced through a shared filesystem store.
- Content-based anchor reconciliation after code edits.
- Workflow + anchor state tracking:
  - `Workflow State`: `Open` / `Resolved`
  - `Anchor State`: `Anchored` / `Stale` / `Orphaned`
- Consider comments tree view in Explorer for file-grouped navigation.
- Archive resolved comments.
- Guided setup and uninstall flows for agent integration.

## Quickstart

1. Install the extension from VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=consider
2. Open the command palette (Cmd+Shift+P on Mac, Ctrl+Shift+P on Windows/Linux) and run `Consider: Setup`.
3. In setup, choose:
   - whether to add the comment store (`.consider/`) to `.gitignore`,
   - which skill integrations to install (OpenAI, Anthropic, OpenCode, etc.)
4. Add a comment from the editor gutter `+` or run `Add Comment` from the command palette.
5. Run the `consider` skill from your agent. Optionally pass a file path, comment ID, or message to specify a focus area or additional instructions for the agent.

## Core Commands

### Editor Commands

- `Add Comment`
- `Reply`
- `Resolve` / `Unresolve`
- `Consider: Setup`
- `Consider: Uninstall`
- `Consider: Show All Comments`
- `Consider: Archive Resolved`
- `Consider: Reconcile All`

### Agent Commands (via `consider-cli`)

```sh
.consider/bin/consider-cli list [--workflow open|resolved|all] [--anchor anchored|stale|orphaned|all] [--unseen] [--file <path>] [--json]
.consider/bin/consider-cli get <comment-id> [--json]
.consider/bin/consider-cli context <comment-id> [--lines N] [--json]
.consider/bin/consider-cli reply <comment-id> --message "..."
.consider/bin/consider-cli resolve <comment-id>
.consider/bin/consider-cli unresolve <comment-id>
.consider/bin/consider-cli summary [--json]
```

## Privacy and Security

- Local comment store located at `.consider/` at the root of your project.
  - `.consider/` can be added to `.gitignore` automatically during setup.
  - Core workflow is filesystem-only: no server, no IPC. The extension never makes network requests.
- Your agents access comment data by invoking the `consider-cli` binary, which reads from and writes to the local comment store.
- Agent integration files are explicit opt-in in setup and removable via `Consider: Uninstall`.

## Troubleshooting

- If comments appear stale after heavy edits, run `Consider: Reconcile All`.
- If the extension is installed but not initialized in a workspace, run `Consider: Setup`.
- For UI/platform caveats, see known limitations in the repository docs.

## Project Links

- Repository: <https://github.com/VarunKanwar/consider>
- User + repo overview: <https://github.com/VarunKanwar/consider/blob/main/README.md>
- Specification: <https://github.com/VarunKanwar/consider/blob/main/docs/spec.md>
- Known limitations: <https://github.com/VarunKanwar/consider/blob/main/docs/known-limitations.md>


## License

MIT
