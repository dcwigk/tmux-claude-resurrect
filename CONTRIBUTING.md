# Contributing

Keep the plugin focused on exact local Claude session restoration through tmux-resurrect. Changes to native metadata handling need a synthetic fixture showing both the supported case and the case that must be rejected.

Run `npm run test:deps`, `npm run lint`, and `npm test`. Integration dependencies are pinned in `test/setup-deps.sh`. The suite starts its own tmux servers and cleans up only its temporary files and processes. Do not use production sessions or credentials in tests.

Use Conventional Commits such as `feat:`, `fix:`, `refactor:`, `test:`, and `docs:`. Keep each commit focused on one coherent change.

An optional pre-commit hook runs lint and unit tests. Enable it for this checkout with:

```sh
git config --local core.hooksPath .githooks
```

The hook requires Node.js and ShellCheck. It checks the working tree; CI checks the committed files and runs the integration tests as well. TPM installation does not enable Git hooks.

For a bug report, include your OS, tmux/Node/Claude versions, whether Continuum is enabled, and the relevant skip reason from `doctor` or `status`. Redact working directories, session IDs, and other identifying data. Do not attach Claude transcripts or credential files.

Describe the failing behavior, the expected behavior, and a minimal reproduction. Avoid broadening compatibility claims without evidence on the target platform.
