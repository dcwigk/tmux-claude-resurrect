# README demo

The GIF records real Claude Code conversations in a 144 × 42 terminal, using tmux-resurrect and this plugin. Two panes share an empty temporary project and receive short, independent prompts. Claude's interface, answers, native session records, and transcripts are real.

The scenario opens tmux, starts Claude in both panes, saves, detaches, stops only its own server, opens a fresh server, and restores through the installed Resurrect hooks. Assertions compare session IDs, pane addresses, working directories, transcript paths, and launch arguments before and after restoration. Both original prompts must also reappear in their panes.

| Pane | Launch command |
| --- | --- |
| Left | `claude --model sonnet --effort low` |
| Right | `claude --model opus --dangerously-skip-permissions` |

## Record

Use the plugin's development requirements, an authenticated Claude Code installation, [asciinema 2.4](https://docs.asciinema.org/manual/cli/usage/) (or `uv` to run it temporarily), and [agg 1.9](https://docs.asciinema.org/manual/agg/). This recording was made with Claude Code 2.1.272. The rendering command uses JetBrainsMono Nerd Font Mono; choose another monospace font if needed.

This is an optional live demonstration, separate from the automated test suite. Each run sends two short prompts through your existing Claude authentication and uses your subscription or API allowance. Safe mode disables personal customizations; the right pane explicitly enables permission bypass. The prompts ask for brief explanations in an empty temporary project. The recorder does not copy credential files. Review the cast before publishing it: Claude's UI can vary by version and account.

```sh
npm run test:deps
python3 demo/run.py --record docs/assets/restore.cast
agg --theme dracula --text-font-family 'JetBrainsMono Nerd Font Mono' \
  --font-size 20 --line-height 1.15 --fps-cap 12 --last-frame-duration 6 \
  docs/assets/restore.cast docs/assets/restore.gif
```

The recorder creates a unique temporary project, tmux socket, and snapshot/state directories. Every tmux invocation targets that socket, including upstream scripts through their `TMUX` environment. The displayed `$DEMO_SOCKET` represents that run's socket path. Cleanup stops only the demo server and Claude processes with matching project paths and PID/start identities, then uses `claude project purge` for the temporary project. Existing conversations and tmux servers are left alone.

The cast contains terminal output only. Workspace trust setup and terminal teardown are omitted. Waiting for Claude to start, answer, or resume plays at three times normal speed; commands, prompts, and the final result remain readable. Save and restore invoke the same Resurrect scripts as the displayed key bindings. No conversation output is fabricated or replaced.
