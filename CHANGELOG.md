# Changelog

## 0.1.0 — 2026-09-15

Initial public release.

- Restore exact Claude Code conversations in their saved tmux panes and working directories.
- Identify sessions through Claude's native process registry without Claude hooks or background polling.
- Integrate with TPM, tmux-resurrect, and optional tmux-continuum.
- Protect existing panes and prevent duplicate starts with verified process identities and shared launch claims.
- Validate snapshots and report missing projects, transcripts, and unsupported session metadata.
- Provide `doctor`, `status`, and `unlock` commands for diagnostics and recovery.

See the [README](README.md#requirements) for requirements and compatibility limits.
