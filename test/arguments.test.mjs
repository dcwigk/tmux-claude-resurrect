import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { decodeCmdline, readProcessArguments, claudeArguments, restoreArguments,
  validArguments } from '../src/arguments.mjs';

test('Linux argv decoding preserves empty values and rejects truncated or non-UTF-8 input', () => {
  assert.deepEqual(decodeCmdline(Buffer.from('claude\0--tools\0\0hello world\0')), ['claude', '--tools', '', 'hello world']);
  for (const raw of [Buffer.alloc(0), Buffer.from('claude'), Buffer.from([0xff, 0])]) {
    assert.throws(() => decodeCmdline(raw));
  }
  assert.equal(validArguments(['\ud800']), false);
  assert.equal(validArguments(['🧛']), true);
});

test('macOS argc decoding excludes environment and preserves empty argv elements', () => {
  const source = fileURLToPath(new URL('../src/procargs.py', import.meta.url));
  execFileSync('python3', ['-B', '-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('procargs', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
args = [b'claude', b'--tools', b'', b'--settings', b'{"name":"a b"}']
raw = len(args).to_bytes(4, sys.byteorder) + b'/bin/claude\\0\\0\\0' + b'\\0'.join(args) + b'\\0PRIVATE=secret\\0'
assert module.decode_procargs(raw) == [a.decode() for a in args]
for raw in [b'', raw[:12], raw[:4] + b'missing terminator']:
    try:
        module.decode_procargs(raw)
    except ValueError:
        pass
    else:
        raise AssertionError('accepted truncated argv')
`, source]);
});

test('native process argument reads preserve boundaries and omit environment variables', async t => {
  const values = ['space value', '', "'quotes'", '$(touch INJECTED)', 'line\nbreak', '🧛'];
  const source = 'console.log("ready"); setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', source, '--', ...values], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ARGV_TEST_SECRET: 'not-an-argument' },
  });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  const result = readProcessArguments([child.pid]).get(child.pid);
  assert.deepEqual(result.args, [process.execPath, '-e', source, '--', ...values]);
  child.kill();
  await once(child, 'exit');
  assert.ok(readProcessArguments([child.pid]).get(child.pid).error);
});

test('native and interpreter launches expose only Claude arguments', () => {
  assert.deepEqual(claudeArguments(['claude', '--verbose']), ['--verbose']);
  assert.deepEqual(claudeArguments(['/path/2.1.272', '--verbose']), ['--verbose']);
  assert.deepEqual(claudeArguments(['/path/node', '/path/cli.js', '--verbose']), ['--verbose']);
  assert.throws(() => claudeArguments(['node', '--inspect', 'cli.js']), /interpreter/);
  assert.throws(() => claudeArguments(['overwritten process title']), /overwritten/);
});

test('restoration retains explicit options while dropping selectors, worktree creation, and initial prompts', () => {
  const args = ['--dangerously-skip-permissions', '--resume=old-id', '--fork-session', '--worktree', 'old-tree',
    '--tmux=classic', '--session-id', 'old-id', '-c', '--model=opus', '--effort', 'high',
    '--permission-mode', 'plan', '--tools', '', '--settings', '{"env":{"VALUE":"a b"}}',
    '--append-system-prompt', "line one\n'line two'", 'already delivered prompt'];
  assert.deepEqual(restoreArguments(args), ['--dangerously-skip-permissions', '--model=opus', '--effort', 'high',
    '--permission-mode', 'plan', '--tools', '', '--settings', '{"env":{"VALUE":"a b"}}',
    '--append-system-prompt', "line one\n'line two'"]);
  assert.deepEqual(restoreArguments(['-r', 'id', '--chrome', '--', '--this-is-a-prompt']), ['--chrome']);
  assert.deepEqual(restoreArguments(['--debug=api', 'prompt', '--verbose']), ['--debug=api', '--verbose']);
  assert.deepEqual(restoreArguments(['--add-dir', '/a b', '/c', '--model', 'opus']), ['--add-dir', '/a b', '/c', '--model', 'opus']);
});

test('unknown and non-interactive options cannot silently change the restored launch', () => {
  for (const args of [['--unknown', 'value'], ['--print', 'prompt'], ['--background'], ['--model'],
    ['--tools'], ['--session-id'], ['--dangerously-skip-permissions=false'], ['-cr'], ['', '']]) {
    assert.throws(() => restoreArguments(args));
  }
  assert.deepEqual(restoreArguments(['--system-prompt', '--resume']), ['--system-prompt', '--resume']);
  assert.deepEqual(restoreArguments(['--permission-mode', 'plan']), ['--permission-mode', 'plan']);
  assert.deepEqual(restoreArguments([]), []);
});
