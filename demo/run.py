"""Run the recorded scenario on a private tmux socket with synthetic Claude data."""

import json
import os
import pathlib
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
RESURRECT = REPO / '.test-deps/tmux-resurrect'
IDS = ['a1b2c3d4-1111-4111-8111-111111111111', 'e5f6a7b8-2222-4222-8222-222222222222']
OPTIONS = [['--dangerously-skip-permissions'], ['--permission-mode', 'plan']]
COLS, ROWS = 100, 28
END_MARKER = '\x1b]demo-recording-complete\x07'


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise RuntimeError('Demo did not reach the expected state')


class Demo:
    def __init__(self, directory):
        self.root = pathlib.Path(directory).resolve()
        self.socket = self.root / 'tmux.sock'
        self.profile = self.root / 'claude'
        self.project = self.root / 'atlas'
        self.project.mkdir()
        (self.profile / 'sessions').mkdir(parents=True)
        project_key = ''.join(c if c.isascii() and c.isalnum() else '-' for c in str(self.project))
        transcripts = self.profile / 'projects' / project_key
        transcripts.mkdir(parents=True)
        conversations = [
            {'title': 'API pagination', 'prompt': 'Refactor API pagination.',
             'answer': 'Cursor pagination is ready.', 'details': ['Updated src/api/list.ts', 'Added regression tests']},
            {'title': 'Auth review', 'prompt': 'Review the auth boundary.',
             'answer': 'Here is the proposed plan.', 'details': ['Check token validation', 'Keep changes read-only']},
        ]
        for session_id, conversation in zip(IDS, conversations):
            (transcripts / f'{session_id}.jsonl').write_text(json.dumps(conversation) + '\n')
        self.fake = self.root / 'claude.mjs'
        self.fake.write_text((REPO / 'demo/claude.mjs').read_text())
        (self.root / 'bin').mkdir()
        self.launcher = self.root / 'bin/claude'
        # A native argv vector, not a shell alias; the plugin captures the fixture's actual options.
        self.launcher.write_text('#!/bin/sh\nexec ' + shlex.join([shutil.which('node'), str(self.fake)]) + ' "$@"\n')
        self.launcher.chmod(0o700)
        self.env = {'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
                    'CLAUDE_CONFIG_DIR': str(self.profile), 'XDG_CONFIG_HOME': str(self.root / 'config'),
                    'SHELL': '/bin/sh', 'PS1': '  $ '}
        self.client = None

    def tmux(self, *args, check=True):
        return subprocess.run(['tmux', '-S', str(self.socket), *map(str, args)], env=self.env,
                              text=True, capture_output=True, timeout=15, check=check).stdout.strip()

    def start(self):
        self.env.pop('TMUX', None)
        self.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'atlas', '-x', COLS, '-y', ROWS,
                  '-c', self.project, '/bin/sh')
        self.env['TMUX'] = self.tmux('display-message', '-p', '#{socket_path},#{pid},0')
        options = {
            'default-shell': '/bin/sh', 'default-command': 'exec /bin/sh -i',
            'status': '2', 'status-position': 'top', 'status-interval': '1', 'set-titles': 'off',
            'status-style': 'fg=#f8f8f2,bg=#282a36', 'message-style': 'fg=#282a36,bg=#bd93f9',
            'pane-border-status': 'top', 'pane-border-style': 'fg=#44475a',
            'pane-active-border-style': 'fg=#6272a4',
            'pane-border-format': '#[fg=#bd93f9] pane #{pane_index} · atlas/ ',
            'window-style': 'fg=#f8f8f2,bg=#282a36', 'window-active-style': 'fg=#f8f8f2,bg=#282a36',
            '@resurrect-dir': str(self.root / 'snapshots'), '@resurrect-capture-pane-contents': 'off',
            '@resurrect-processes': 'false', '@claude-resurrect-claude-dir': str(self.profile),
            '@claude-resurrect-state-dir': str(self.root / 'state'),
            '@claude-resurrect-command': str(self.launcher),
        }
        for name, value in options.items():
            self.tmux('set-option', '-g', name, value)
        self.tmux('set-option', '-as', 'terminal-features', ',xterm-256color:RGB')
        self.tmux('set-option', '-g', 'status-format[0]',
                  '#[align=left,bold,fg=#f8f8f2]  tmux-claude-resurrect'
                  '#[align=right,nobold,fg=#979db5]Demo data · real tmux restore  ')
        self.phase('LIVE', 'Two conversations. Same project. Different options.')
        subprocess.run([str(RESURRECT / 'resurrect.tmux')], env=self.env, check=True, capture_output=True)
        subprocess.run([str(REPO / 'claude-resurrect.tmux')], env=self.env, check=True, capture_output=True)

    def phase(self, stage, caption):
        self.tmux('set-option', '-g', 'status-format[1]',
                  '#[align=left,fg=#282a36,bg=#bd93f9,bold]  ' + stage + '  '
                  '#[nobold,fg=#f8f8f2,bg=#282a36]  ' + caption)
        self.tmux('refresh-client', '-S', check=False)

    def attach(self):
        self.client = subprocess.Popen(['tmux', '-S', str(self.socket), 'attach-session', '-t', 'atlas'],
                                       env={**self.env, 'TMUX': ''})

    def events(self):
        file = self.profile / 'events.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def action(self, name):
        subprocess.run(['/bin/bash', str(RESURRECT / 'scripts' / f'{name}.sh'), 'quiet'],
                       env=self.env, check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def stop(self):
        self.tmux('kill-server', check=False)
        if self.client:
            self.client.wait(timeout=5)
            self.client = None
        # Stop only demo processes whose PID and start time still match our event log.
        for event in self.events():
            result = subprocess.run(['ps', '-p', str(event['pid']), '-o', 'lstart='],
                                    capture_output=True, text=True, env={**self.env, 'LC_ALL': 'C', 'TZ': 'UTC'})
            if ' '.join(result.stdout.split()) == event['start']:
                try:
                    os.kill(event['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def record(self):
        self.start()
        self.tmux('split-window', '-h', '-d', '-t', 'atlas:0', '-c', self.project, '/bin/sh')
        for index, (session_id, args) in enumerate(zip(IDS, OPTIONS)):
            self.tmux('respawn-pane', '-k', '-t', f'atlas:0.{index}', '-c', self.project,
                      'node', self.fake, '--session-id', session_id, *args)
        wait_for(lambda: len(self.events()) == 2)
        self.attach()
        time.sleep(4)
        self.phase('SAVE', 'prefix + Ctrl-s   →   capture conversations and options')
        self.action('save')
        text = (self.root / 'snapshots/last').read_text()
        manifest = json.loads(next(line.split('\t', 1)[1] for line in text.splitlines()
                                   if line.startswith('claude-resurrect\t')))
        assert [entry['id'] for entry in manifest['entries']] == IDS
        assert [entry['args'] for entry in manifest['entries']] == OPTIONS
        time.sleep(3)
        self.phase('RESTART', 'The tmux server stops. Both Claude processes exit.')
        time.sleep(1.5)
        self.stop()
        self.start()
        self.tmux('select-pane', '-t', 'atlas:0.0', '-T', 'Fresh tmux server')
        self.phase('RESTARTED', 'One empty shell. The conversations are still on disk.')
        self.attach()
        time.sleep(2.5)
        self.phase('RESTORE', 'prefix + Ctrl-r   →   restore the saved workspace')
        self.action('restore')
        wait_for(lambda: len(self.events()) == 4)
        restored = sorted(self.events()[2:], key=lambda event: event['id'])
        for index, (event, session_id, args) in enumerate(zip(restored, IDS, OPTIONS)):
            assert event['id'] == session_id and event['resumed']
            assert event['args'] == ['--resume', session_id, *args]
            assert event['pane'] == self.tmux('display-message', '-p', '-t', f'atlas:0.{index}', '#{pane_id}')
            assert event['cwd'] == str(self.project)
        self.phase('RESTORED', 'Same conversations. Same panes. Same options.')
        time.sleep(5)
        # The recording ends before tmux leaves the alternate screen during cleanup.
        sys.stdout.write(END_MARKER)
        sys.stdout.flush()
        self.tmux('detach-client')
        self.client.wait(timeout=5)
        self.client = None


def record(output):
    output = pathlib.Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    recorder = ['asciinema'] if shutil.which('asciinema') else ['uvx', '--from', 'asciinema==2.4.0', 'asciinema']
    subprocess.run([*recorder, 'rec', '--overwrite', '-q', '--cols', str(COLS), '--rows', str(ROWS),
                    '-c', shlex.join([sys.executable, str(pathlib.Path(__file__).resolve())]), str(output)], check=True)
    lines = output.read_text().splitlines()
    header = json.loads(lines[0])
    header.pop('command', None)
    header['title'] = 'tmux-claude-resurrect: save, restart, restore'
    header['env'] = {'SHELL': '/bin/sh', 'TERM': 'xterm-256color'}
    events = []
    for line in lines[1:]:
        event = json.loads(line)
        if event[1] == 'o' and END_MARKER in event[2]:
            event[2] = event[2].split(END_MARKER, 1)[0]
            events.append(event)
            break
        events.append(event)
    else:
        raise RuntimeError('Demo failed before verification completed; recording was not finalized')
    start = events[0][0]
    for event in events:
        event[0] = round(event[0] - start, 6)
    header['duration'] = events[-1][0]
    output.write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in [header, *events]) + '\n')
    print(f'Recorded {header["duration"]:.1f}s; verified both session IDs, pane addresses, directories, and options.')


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--record':
    record(sys.argv[2])
elif __name__ == '__main__':
    if not (RESURRECT / 'resurrect.tmux').exists():
        raise SystemExit('Run npm run test:deps first')
    with tempfile.TemporaryDirectory(prefix='claude-demo-', dir='/tmp') as temporary:
        demo = Demo(temporary)
        try:
            demo.record()
        finally:
            demo.stop()
