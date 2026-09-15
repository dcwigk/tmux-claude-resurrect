"""Record real Claude conversations on a private tmux socket."""

import json
import os
import pathlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
RESURRECT = REPO / '.test-deps/tmux-resurrect'
COLS, ROWS = 144, 42
OPTIONS = ['--model', 'sonnet', '--effort', 'low', '--tools', '']
PROMPTS = [
    'Give me two benefits of cursor pagination. Keep it brief.',
    'Give me two checks for secure session cookies. Keep it brief.',
]
END_MARKER = '\x1b]demo-recording-complete\x07'
SPEED_MARKER = re.compile(r'\x1b\]demo-speed=(\d+)\x07')


def wait_for(predicate, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError('Demo did not reach the expected state')


def speed(value):
    sys.stdout.write(f'\x1b]demo-speed={value}\x07')
    sys.stdout.flush()


class Demo:
    def __init__(self, directory):
        self.root = pathlib.Path(directory).resolve()
        self.socket = self.root / 'tmux.sock'
        self.project = self.root / 'atlas'
        self.project.mkdir()
        self.profile = pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR', pathlib.Path.home() / '.claude')).resolve()
        self.claude = shutil.which('claude')
        if not self.claude:
            raise RuntimeError('An authenticated Claude Code installation is required')
        inherited = ('HOME', 'PATH', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR',
                     'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN')
        self.env = {key: os.environ[key] for key in inherited if key in os.environ}
        self.env.update(TERM='xterm-256color', LANG='en_US.UTF-8', SHELL='/bin/sh',
                        PS1='$ ', CLAUDE_CODE_SAFE_MODE='1', DISABLE_AUTOUPDATER='1')
        self.client = None
        self.children = {}

    def tmux(self, *args, check=True):
        # Every operation, including cleanup, names this run's unique socket.
        return subprocess.run(['tmux', '-S', str(self.socket), *map(str, args)], env=self.env,
                              text=True, capture_output=True, timeout=15, check=check).stdout.strip()

    def start(self):
        self.env.pop('TMUX', None)
        self.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'atlas', '-x', COLS, '-y', ROWS,
                  '-c', self.project, '/bin/sh')
        self.env['TMUX'] = self.tmux('display-message', '-p', '#{socket_path},#{pid},0')
        options = {
            'default-shell': '/bin/sh', 'default-command': 'exec /bin/sh -i',
            'status': '2', 'status-position': 'top', 'status-interval': '1',
            'set-titles': 'off', 'focus-events': 'on', 'mouse': 'on',
            'status-style': 'fg=#f8f8f2,bg=#282a36', 'message-style': 'fg=#282a36,bg=#bd93f9',
            'pane-border-status': 'top', 'pane-border-style': 'fg=#44475a',
            'pane-active-border-style': 'fg=#6272a4',
            'pane-border-format': '#[fg=#bd93f9] atlas/ · pane #{pane_index} ',
            'window-style': 'fg=#f8f8f2,bg=#282a36', 'window-active-style': 'fg=#f8f8f2,bg=#282a36',
            '@resurrect-dir': str(self.root / 'snapshots'), '@resurrect-capture-pane-contents': 'off',
            '@resurrect-processes': 'false',
            '@claude-resurrect-state-dir': str(self.root / 'state'),
            '@claude-resurrect-command': self.claude,
        }
        for name, value in options.items():
            self.tmux('set-option', '-g', name, value)
        self.tmux('set-option', '-as', 'terminal-features', ',xterm-256color:RGB')
        self.tmux('set-option', '-g', 'status-format[0]',
                  '#[align=left,bold,fg=#f8f8f2]  tmux-claude-resurrect'
                  '#[align=right,nobold,fg=#979db5]Real Claude Code · isolated demo server  ')
        self.phase('START', 'Open tmux. Start two conversations in the same project.')
        for entrypoint in (RESURRECT / 'resurrect.tmux', REPO / 'claude-resurrect.tmux'):
            subprocess.run([str(entrypoint)], env=self.env, check=True, capture_output=True)

    def phase(self, stage, caption):
        self.tmux('set-option', '-g', 'status-format[1]',
                  '#[align=left,fg=#282a36,bg=#bd93f9,bold]  ' + stage + '  '
                  '#[nobold,fg=#f8f8f2,bg=#282a36]  ' + caption)
        self.tmux('refresh-client', '-S', check=False)

    def screen(self, index):
        return self.tmux('capture-pane', '-p', '-t', f'atlas:0.{index}')

    def type(self, index, text):
        self.tmux('select-pane', '-t', f'atlas:0.{index}')
        for offset in range(0, len(text), 3):
            self.tmux('send-keys', '-t', f'atlas:0.{index}', '-l', '--', text[offset:offset + 3])
            time.sleep(0.025)
        time.sleep(0.3)
        self.tmux('send-keys', '-t', f'atlas:0.{index}', 'Enter')

    def attach(self):
        self.client = subprocess.Popen(
            ['tmux', '-S', str(self.socket), 'new-session', '-A', '-s', 'atlas'],
            env={**self.env, 'TMUX': ''})

    def detach(self):
        self.tmux('detach-client')
        self.client.wait(timeout=5)
        self.client = None

    def native_records(self):
        records = []
        for file in (self.profile / 'sessions').glob('*.json'):
            try:
                record = json.loads(file.read_text())
            except (OSError, ValueError):
                continue
            if record.get('cwd') == str(self.project):
                records.append(record)
                self.children[record['pid']] = ' '.join(record['procStart'].split())
        return records

    def capture(self):
        code = ('import {context,capture} from "./src/resurrect.mjs"; '
                'const runtime=context(); console.log(JSON.stringify(capture(runtime,runtime.panes())));')
        result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=REPO,
                                env=self.env, capture_output=True, text=True, check=True, timeout=20)
        return json.loads(result.stdout)

    def answered(self):
        key = re.sub('[^a-zA-Z0-9]', '-', str(self.project))
        answers = 0
        for record in self.native_records():
            transcript = self.profile / 'projects' / key / (record['sessionId'] + '.jsonl')
            try:
                entries = [json.loads(line) for line in transcript.read_text().splitlines()]
            except (OSError, ValueError):
                continue
            answers += any(entry.get('type') == 'assistant'
                           and entry.get('message', {}).get('stop_reason') == 'end_turn' for entry in entries)
        return answers == 2

    def action(self, name):
        subprocess.run(['/bin/bash', str(RESURRECT / 'scripts' / f'{name}.sh'), 'quiet'],
                       env=self.env, check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def stop(self):
        self.native_records()
        pane_pids = self.tmux('list-panes', '-a', '-F', '#{pane_pid}', check=False).splitlines()
        owned = {int(pid) for pid in pane_pids if pid.isdecimal()}
        table = subprocess.run(['ps', '-axo', 'pid=,ppid=,lstart='], capture_output=True,
                               text=True, check=True, env={**self.env, 'LC_ALL': 'C', 'TZ': 'UTC'})
        rows = [line.split(None, 2) for line in table.stdout.splitlines()]
        while True:
            descendants = {int(pid) for pid, parent, _ in rows if int(parent) in owned}
            if descendants <= owned:
                break
            owned.update(descendants)
        for pid, _, start in rows:
            if int(pid) in owned:
                self.children[int(pid)] = ' '.join(start.split())
        self.tmux('kill-server', check=False)
        if self.client:
            self.client.wait(timeout=5)
            self.client = None
        # Claude may outlive its terminal; never signal a reused PID.
        for pid, start in self.children.items():
            result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True,
                                    text=True, env={**self.env, 'LC_ALL': 'C', 'TZ': 'UTC'})
            if ' '.join(result.stdout.split()) == start:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        wait_for(lambda: not any(subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode == 0
                                 for pid in self.children), timeout=10)
        self.children.clear()

    def prepare(self):
        # Accept trust only for the empty project this recorder just created.
        self.start()
        self.tmux('respawn-pane', '-k', '-t', 'atlas:0.0', '-c', self.project, self.claude, *OPTIONS)
        wait_for(lambda: 'Yes, I trust this folder' in self.screen(0) or 'Claude Code v' in self.screen(0))
        if 'Yes, I trust this folder' in self.screen(0):
            time.sleep(1)
            self.tmux('send-keys', '-t', 'atlas:0.0', 'Down', 'Enter')
        wait_for(lambda: 'Claude Code v' in self.screen(0) and '❯' in self.screen(0))
        self.stop()

    def cleanup(self):
        self.stop()
        subprocess.run([self.claude, 'project', 'purge', str(self.project), '-y'],
                       env=self.env, check=True, capture_output=True, timeout=30)

    def shell_command(self, command):
        sys.stdout.write('\r\n\x1b[38;2;80;250;123m$ \x1b[0m')
        for char in command:
            sys.stdout.write(char)
            sys.stdout.flush()
            time.sleep(0.025)
        sys.stdout.write('\r\n')
        sys.stdout.flush()
        time.sleep(0.5)

    def record(self):
        self.prepare()
        sys.stdout.write('\x1b[2J\x1b[H\x1b[38;2;189;147;249mtmux-claude-resurrect\x1b[0m\r\n'
                         'DEMO_SOCKET points to a separate, temporary tmux server.\r\n')
        sys.stdout.flush()
        self.shell_command('tmux -S "$DEMO_SOCKET" new-session -A -s atlas')
        self.start()
        self.attach()
        time.sleep(1.2)
        self.tmux('split-window', '-h', '-d', '-t', 'atlas:0', '-c', self.project, '/bin/sh')
        time.sleep(0.7)
        for index in range(2):
            self.type(index, shlex.join(['claude', *OPTIONS]))
        speed(3)
        wait_for(lambda: all('Claude Code v' in self.screen(i) and '❯' in self.screen(i) for i in range(2)))
        speed(1)
        for index, prompt in enumerate(PROMPTS):
            self.type(index, prompt)
        speed(3)
        wait_for(self.answered, timeout=120)
        speed(1)
        time.sleep(3)
        before = self.capture()
        assert len(before['entries']) == 2 and not before['unavailable'] and not before['skipped'], before
        assert all(entry['args'] == OPTIONS for entry in before['entries'])
        self.phase('SAVE', 'prefix + Ctrl-s  ·  Save the layout, exact session IDs, and launch options.')
        self.action('save')
        snapshot = (self.root / 'snapshots/last').read_text()
        manifest = json.loads(next(line.split('\t', 1)[1] for line in snapshot.splitlines()
                                   if line.startswith('claude-resurrect\t')))
        assert manifest['entries'] == before['entries']
        time.sleep(2)
        self.phase('DETACH', 'prefix + d  ·  Leave tmux before stopping the demo server.')
        time.sleep(1.5)
        self.detach()
        self.shell_command('tmux -S "$DEMO_SOCKET" kill-server')
        self.stop()
        sys.stdout.write('Demo server stopped. Both Claude processes exited.\r\n')
        sys.stdout.flush()
        time.sleep(1.5)
        self.shell_command('tmux -S "$DEMO_SOCKET" new-session -A -s atlas')
        self.start()
        self.phase('FRESH SERVER', 'One empty shell. Restore the saved workspace with prefix + Ctrl-r.')
        self.attach()
        time.sleep(2)
        self.phase('RESTORE', 'prefix + Ctrl-r  ·  Resume each saved conversation in its original pane.')
        speed(3)
        self.action('restore')
        wait_for(lambda: all('Claude Code v' in self.screen(i) and PROMPTS[i] in self.screen(i)
                            for i in range(2)))
        wait_for(self.answered)
        speed(1)
        after = self.capture()
        assert after['entries'] == before['entries'] and not after['unavailable'], after
        self.phase('RESTORED', 'Same conversations. Same panes. Same project. Same launch options.')
        time.sleep(6)
        sys.stdout.write(END_MARKER)
        sys.stdout.flush()
        self.detach()


def record(output):
    output = pathlib.Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    recorder = ['asciinema'] if shutil.which('asciinema') else ['uvx', '--from', 'asciinema==2.4.0', 'asciinema']
    subprocess.run([*recorder, 'rec', '--overwrite', '-q', '--cols', str(COLS), '--rows', str(ROWS),
                    '-c', shlex.join([sys.executable, str(pathlib.Path(__file__).resolve())]), str(output)], check=True)
    lines = output.read_text().splitlines()
    header = json.loads(lines[0])
    header.pop('command', None)
    header.update(title='tmux-claude-resurrect: start, save, detach, restart, restore',
                  env={'SHELL': '/bin/sh', 'TERM': 'xterm-256color'})
    events, rate, previous, elapsed, pending = [], 1, None, 0, ''
    for line in lines[1:]:
        timestamp, kind, data = json.loads(line)
        if previous is None:
            previous = timestamp
        elapsed += (timestamp - previous) / rate
        previous = timestamp
        if kind != 'o':
            continue
        data = pending + data
        pending = ''
        # Control strings can straddle recorder chunks.
        marker = data.rfind('\x1b]demo-')
        if marker >= 0 and '\x07' not in data[marker:]:
            data, pending = data[:marker], data[marker:]
        complete = END_MARKER in data
        data = data.split(END_MARKER, 1)[0]
        for match in SPEED_MARKER.finditer(data):
            rate = int(match[1])
        data = SPEED_MARKER.sub('', data)
        events.append([round(elapsed, 6), kind, data])
        if complete:
            break
    else:
        raise RuntimeError('Demo failed before verification completed; recording was not finalized')
    header['duration'] = events[-1][0]
    output.write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in [header, *events]) + '\n')
    print(f'Recorded {header["duration"]:.1f}s; verified both session IDs, pane addresses, directories, and options.')


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--record':
    record(sys.argv[2])
elif __name__ == '__main__':
    if not (RESURRECT / 'resurrect.tmux').exists():
        raise SystemExit('Run npm run test:deps first')
    with tempfile.TemporaryDirectory(prefix='tcr-demo-', dir='/tmp') as temporary:
        demo = Demo(temporary)
        try:
            demo.record()
        finally:
            demo.cleanup()
