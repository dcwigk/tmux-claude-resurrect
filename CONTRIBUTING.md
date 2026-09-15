# Contributing

Keep the plugin focused on exact local Claude session restoration through tmux-resurrect. Changes to native metadata handling need a synthetic fixture showing both the supported case and the case that must be rejected.

Run `npm run test:deps`, `npm run lint`, and `npm test`. Integration dependencies are pinned in `test/setup-deps.sh`. The suite starts its own tmux servers and cleans up only its temporary files and processes. Do not use production sessions or credentials in tests.

For a bug report, include your OS, tmux/Node/Claude versions, whether Continuum is enabled, and the relevant skip reason from `doctor` or `status`. Redact working directories, session IDs, and other identifying data. Do not attach Claude transcripts or credential files.

Describe the failing behavior, the expected behavior, and a minimal reproduction. Avoid broadening compatibility claims without evidence on the target platform.
