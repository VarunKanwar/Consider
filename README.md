# Consider

_Consider_ adds code-review-style comment threads to local files in VS Code, and enables agents to participate via [skills](https://code.claude.com/docs/en/skills). Iterate on design and implementation in place, with discussions anchored to the exact lines they refer to.

TODO: GIF showing the flow of comment creation in the editor -> skill invocation -> agent response in the thread

## Quickstart:

- VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=consider
- Open the command palette (Cmd+Shift+P on Mac, Ctrl+Shift+P on Windows/Linux) and run `Consider: Setup` to configure your agent integrations.
  - This will create a `.consider/` directory and optionally add it to `.gitignore`.
  - This will also install a `/consider` skill on selected agents, allowing them to read and write comments.



- Inline comments anchored to line/range.
- Agent replies from terminal via `consider-cli`.
- Shared local store at `.consider/store.json`.
- Content-based re-anchoring after edits.

## 60-Second First Loop

1. Open your workspace in VS Code with Consider active.
2. Run `Consider: Setup`.
3. In setup, choose:
   - whether to add `.consider/` to `.gitignore`,
   - which integrations to install,
   - workspace vs home install scope for each selected integration.
4. Add a comment from the editor gutter `+` or run `Add Comment`.
5. In terminal, list open feedback:
   ```sh
   .consider/bin/consider-cli list
   ```
6. Reply as the agent:
   ```sh
   .consider/bin/consider-cli reply <comment-id> --message "I will update this."
   ```
7. Resolve when done:
   ```sh
   .consider/bin/consider-cli resolve <comment-id>
   ```

## Agent Command Reference

```sh
.consider/bin/consider-cli list [--workflow open|resolved|all] [--anchor anchored|stale|orphaned|all] [--unseen] [--file <path>] [--json]
.consider/bin/consider-cli get <comment-id> [--json]
.consider/bin/consider-cli context <comment-id> [--lines N] [--json]
.consider/bin/consider-cli reply <comment-id> --message "..."
.consider/bin/consider-cli resolve <comment-id>
.consider/bin/consider-cli unresolve <comment-id>
.consider/bin/consider-cli summary [--json]
```

## Trust And Boundaries

- Comment data stays local in fixed project path `.consider/`.
- `.consider/` can be added to `.gitignore` during setup.
- Core workflow is filesystem-only: no server, no IPC.
- Agent integration files are explicit opt-in in setup and removable via `Consider: Uninstall`.

## Architecture (One Line)

```text
VS Code Extension <-> .consider/store.json <-> consider-cli
```

## Status

Under active development.

- Build progress: `docs/progress.md`
- Current limitations: `docs/known-limitations.md`

## Documentation Map

- Start here as a user: `extension/README.md`
- Full specification: `docs/spec.md`
- Manual test flows: `docs/manual-testing.md`
- Testing policy: `docs/testing-strategy.md`
- Agent contributor instructions: `AGENTS.md`

## License

TBD
