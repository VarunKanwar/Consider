# Feedback Loop

A VS Code extension and CLI tool that brings GitHub PR-style inline code review to local development, designed for communication between a human developer and an AI coding agent.

## The problem

When you're working with an AI coding agent (Claude Code, Codex, OpenCode), reviewing its output means opening files in VS Code and leaving feedback. Today, developers resort to inserting sentinel comments directly in code (`// FEEDBACK: handle the error case here`), polluting the codebase and fragmenting the conversation between inline notes and the agent's chat interface.

## What this does

Feedback Loop provides an annotation layer that sits *on top of* your code, not inside it:

- **Developer** adds inline comments in VS Code, anchored to specific lines or ranges — just like a GitHub PR review.
- **Agent** reads and replies to those comments via a CLI tool (`feedback-cli`).
- **Threads** are anchored to code locations but stored in a gitignored `.feedback/` directory. Git never sees them.
- **Anchors** survive code edits — if the agent moves code around, the system re-anchors comments to their new locations (or flags them as stale if the code changed too much).

No git pollution. No manual line numbers. No chat clutter.

## Architecture

```
VS Code Extension ←→ .feedback/store.json ←→ CLI Tool (used by agents)
```

Three components share a single JSON store via the filesystem. The extension writes comments; the CLI reads them. The CLI writes replies; the extension renders them. No IPC, no server, no protocol — just a file.

## Status

Under active development. See `docs/spec.md` for the full technical specification and `docs/progress.md` for current build status.

## Documentation

- **`docs/spec.md`** — Complete technical specification: problem statement, architecture, data model, anchoring algorithm, agent integration, build phases.
- **`docs/progress.md`** — Build log tracking phase completion and implementation decisions.
- **`docs/manual-testing.md`** — Step-by-step manual testing procedures.
- **`docs/testing-strategy.md`** — Repository-wide testing policy, merge gate, and integration-test roadmap.
- **`AGENTS.md`** — Development instructions for AI coding agents working on this repo.

## License

TBD
