# Launch arguments

Arguments are captured per session, without a global configuration option. A save observes the native process identity, reads its argument vector, and verifies the identity again before accepting the arguments. Linux uses `/proc/<pid>/cmdline`; macOS uses `KERN_PROCARGS2` through a small Python standard-library helper, called once for the whole batch. Argument boundaries, empty values, Unicode, and multiline strings are preserved. Environment variables are excluded.

The restore command uses the configured Claude executable, the saved UUID, and the retained options. It does not replay the original executable path or shell command. Arguments are passed separately through tmux and the shell wrapper's quoted `"$@"`; their contents are never evaluated as shell syntax.

## Supported options

The parser understands these interactive launch options and their value boundaries:

| Purpose | Options |
| --- | --- |
| Permissions and tools | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--allowedTools` / `--allowed-tools`, `--disallowedTools` / `--disallowed-tools`, `--tools`, `--add-dir`, `--restricted` |
| Model and agents | `--model`, `--fallback-model`, `--effort`, `--advisor`, `--agent`, `--agents`, `--betas`, `--autocompact` |
| Prompts and settings | `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt-snapshot`, `--settings`, `--setting-sources`, `--exclude-dynamic-system-prompt-sections` |
| Integrations | `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--plugin-url`, `--chrome`, `--no-chrome`, `--ide`, `--channels`, `--dangerously-load-development-channels`, `--remote-control` / `--rc`, `--remote-control-session-name-prefix` |
| Interface and diagnostics | `--name` / `-n`, `--verbose`, `--debug` / `-d`, `--debug-file`, `--disable-slash-commands`, `--bare`, `--brief`, `--safe-mode`, `--ax-screen-reader` |

Required values accept separate arguments or `--option=value`. Debug filters use the documented `--debug=filter` form. Variadic options retain their original argument boundaries. Combined short options and attached short values such as `-cr` or `-rID` are unsupported; use `-c -r ID` or long options.

An initial prompt has already been sent to the conversation and is omitted. `--continue` / `-c`, `--resume` / `-r`, `--session-id`, `--from-pr`, `--teleport`, and `--fork-session` are omitted so restore can use the verified UUID. `--worktree` / `-w` and `--tmux` are omitted because restore already supplies the saved pane and working directory.

Unknown options and non-interactive launch modes are not silently removed. The snapshot keeps the mapping with an argument error, and restore skips that session. This avoids launching a conversation after dropping a restriction or misreading an option's value as a prompt. Add a parser rule and regression fixture when supporting a new Claude flag. The recognized forms follow the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference); Claude still decides which combinations it accepts.

## Limits

- Options changed inside Claude, environment variables, shell aliases/functions, interpreter flags, and an original executable version are not reconstructed. Native executables named `claude` or a version number and ordinary Node/Bun script launches are supported. Unrecognized process titles and empty positional arguments are rejected because they can indicate overwritten argument memory; empty option values remain supported.
- Relative paths resolve from the saved working directory, which can differ from the original launch directory after entering a worktree. Referenced files and plugins must still be available.
- Command-line options can contain secrets, especially inline JSON settings. Snapshots store retained values with mode `0600`. Reports describe failures without including raw argument values. Do not publish snapshots or unredacted `status` output.
- An exited process, reused PID, changed conversation identity, modified argument memory, or operating-system restrictions can prevent capture. There is no fallback to splitting `ps` text or replaying shell history.
- Version-1 snapshots lack arguments and preserve their original restore behavior. A new save creates version-2 metadata; older plugin versions deliberately reject it instead of silently discarding launch options.
