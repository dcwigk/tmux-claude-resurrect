# README demo

The GIF records a real tmux server, tmux-resurrect, and this plugin. Two synthetic Claude processes publish native session records and read their conversations from temporary transcript files. No Claude account, API calls, or personal conversations are involved.

Both sessions use the same project directory, with different UUIDs and launch options. The scenario saves them, stops its tmux server, starts a fresh server, and restores through the installed Resurrect hooks. Assertions verify both session IDs, pane addresses, working directories, and argument arrays before the recording is finalized.

## Record

Use the plugin's development requirements, [asciinema 2.4](https://docs.asciinema.org/manual/cli/usage/) (or `uv` to run it temporarily), and [agg 1.9](https://docs.asciinema.org/manual/agg/). The rendering command uses JetBrainsMono Nerd Font Mono; choose another monospace font if needed.

```sh
npm run test:deps
python3 demo/run.py --record docs/assets/restore.cast
agg --theme dracula --text-font-family 'JetBrainsMono Nerd Font Mono' \
  --font-size 20 --line-height 1.25 --fps-cap 12 --last-frame-duration 4 \
  docs/assets/restore.cast docs/assets/restore.gif
```

The recorder creates a unique temporary directory, tmux socket, Claude profile, and snapshot directory. Every tmux invocation targets that server, including upstream scripts through their `TMUX` environment. Cleanup stops only that server and processes whose PID/start identity matches the demo event log, then removes its temporary state.

The cast contains terminal output only. Setup delay and terminal teardown are trimmed; save and restore run normally during the recording. The scenario uses the same Resurrect scripts as the displayed key bindings. The final frame remains visible briefly before the GIF loops.
