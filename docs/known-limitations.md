# Known Limitations

This document is the single source of truth for current product limitations.

## Open Limitations

### L-001: Duplicate comment `+` glyphs on wrapped lines

- **Area:** VS Code comment gutter rendering
- **Impact:** With editor word wrap enabled, a single logical source line can show multiple `+` comment affordances.
- **Status:** Upstream VS Code behavior (not extension-controlled)
- **Upstream issue:** <https://github.com/microsoft/vscode/issues/156838>
- **Notes:** The Consider extension cannot force a single glyph per logical line through the current VS Code Comments API.

