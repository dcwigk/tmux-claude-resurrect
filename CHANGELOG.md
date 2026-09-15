# Changelog

## 0.2.0 — 2026-09-15

- Capture supported launch arguments per Claude session, including explicit permission flags, models, tool restrictions, and inline settings.
- Read exact argument boundaries from Linux `/proc` or macOS `KERN_PROCARGS2`; macOS now requires Python 3.
- Save version-2 manifests, retain version-1 compatibility, and skip sessions whose arguments cannot be captured reliably.
- Omit initial prompts, old session selectors, and worktree creation when resuming the saved conversation.
- Preserve Claude's default settings location on restore; only export `CLAUDE_CONFIG_DIR` for an explicitly configured profile.
- Add a reproducible demo with real Claude conversations, different models and permission flags, and a complete tmux server restart.

When upgrading, make Python 3 available in the tmux server's `PATH` on macOS and save again to capture launch arguments. Existing version-1 snapshots still restore without arguments; version 0.1.0 cannot read new version-2 snapshots.

## 0.1.0 — 2026-09-15

Initial public release.

- Restore exact Claude Code conversations in their saved tmux panes and working directories.
- Identify sessions through Claude's native process registry without Claude hooks or background polling.
- Integrate with TPM, tmux-resurrect, and optional tmux-continuum.
- Protect existing panes and prevent duplicate starts with verified process identities and shared launch claims.
- Validate snapshots and report missing projects, transcripts, and unsupported session metadata.
- Provide `doctor`, `status`, and `unlock` commands for diagnostics and recovery.

See the [README](README.md#requirements) for requirements and compatibility limits.
