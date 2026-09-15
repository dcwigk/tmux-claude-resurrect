import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quote } from '../src/resurrect.mjs';
import { processes, readNativeSessions } from '../src/claude.mjs';
import { decodeManifest } from '../src/snapshot.mjs';
import { IDS, fixture, savedFixture, waitFor, events } from './helpers.mjs';

test('Node launcher expands ~/ and preserves literal executable paths', t => {
  const f = fixture({ install: false });
  t.after(f.clean);
  f.start();
  const node = path.join(f.root, "node ' $(touch INJECTED_NODE)");
  fs.symlinkSync(process.execPath, node);
  const launcher = fileURLToPath(new URL('../bin/claude-resurrect', import.meta.url));
  const env = { ...process.env, TMUX: f.tmux('display-message', '-p', '#{socket_path},#{pid},0'),
    PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
  for (const configured of ['node', node, '~/' + path.relative(os.homedir(), node)]) {
    f.tmux('set-option', '-g', '@claude-resurrect-node', configured);
    const output = execFileSync(launcher, ['--version'], { env, cwd: f.root, encoding: 'utf8', timeout: 5000 });
    assert.equal(output.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'INJECTED_NODE')), false);
});

test('profile selection distinguishes the default from explicit configuration', t => {
  const f = fixture({ install: false });
  t.after(f.clean);
  f.start();
  f.tmux('set-option', '-gu', '@claude-resurrect-claude-dir');
  const env = { ...process.env, TMUX: f.tmux('display-message', '-p', '#{socket_path},#{pid},0') };
  delete env.CLAUDE_CONFIG_DIR;
  const module = new URL('../src/resurrect.mjs', import.meta.url).href;
  const inspect = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {context} from ${JSON.stringify(module)}; const {claudeDir,claudeConfigDir}=context();`
      + 'console.log(JSON.stringify({claudeDir,claudeConfigDir}));'], { env, encoding: 'utf8' }));
  const defaultDir = path.join(os.homedir(), '.claude');
  assert.deepEqual(inspect(), { claudeDir: defaultDir, claudeConfigDir: '' });
  env.CLAUDE_CONFIG_DIR = path.join(f.root, 'environment-profile');
  assert.deepEqual(inspect(), { claudeDir: env.CLAUDE_CONFIG_DIR, claudeConfigDir: env.CLAUDE_CONFIG_DIR });
  f.tmux('set-option', '-g', '@claude-resurrect-claude-dir', f.claudeDir);
  assert.deepEqual(inspect(), { claudeDir: f.claudeDir, claudeConfigDir: f.claudeDir });
  f.tmux('set-option', '-g', '@claude-resurrect-claude-dir', '~/.claude');
  assert.deepEqual(inspect(), { claudeDir: defaultDir, claudeConfigDir: defaultDir });
});

test('doctor validates the native platform timestamp and reports a live PID mismatch', async t => {
  const f = fixture();
  t.after(f.clean);
  f.start();
  f.run('work:0.0', IDS[0]);
  await waitFor(() => events(f.root).length === 1);
  const pid = events(f.root)[0].pid;
  const file = path.join(f.claudeDir, 'sessions', `${pid}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    assert.match(record.procStart, /^\d+$/);
    assert.equal(record.procStart, stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
  } else {
    assert.equal(record.procStart, processes().get(pid).start);
  }
  const ready = JSON.parse(f.plugin('doctor'));
  assert.equal(ready.liveNativeSessions, 1);
  assert.equal(ready.captured, 1);
  assert.deepEqual(ready.warnings, []);
  record.procStart = process.platform === 'linux' ? (BigInt(record.procStart) + 1n).toString() : 'stale start time';
  fs.writeFileSync(file, JSON.stringify(record));
  const stale = JSON.parse(f.plugin('doctor'));
  assert.equal(stale.liveNativeSessions, 0);
  assert.equal(stale.captured, 0);
  assert.ok(stale.warnings.some(warning => warning.includes('start time does not match')));
});

test('real Resurrect saves exact sessions, survives changed pane IDs, and reloads idempotently', async () => {
  const f = fixture();
  try {
    f.start();
    const previous = path.join(f.root, 'previous-hook.txt');
    f.tmux('set-option', '-g', '@resurrect-hook-post-save-layout', `printf '%s\\n' >> ${quote(previous)}`);
    f.plugin('install'); f.plugin('install'); f.plugin('install');
    const firstHook = f.tmux('show-option', '-gqv', '@resurrect-hook-post-save-layout');
    assert.equal((firstHook.match(/bin\/claude-resurrect/g) || []).length, 1);
    f.tmux('split-window', '-d', '-t', 'work:0', '/bin/sh');
    f.tmux('split-window', '-d', '-t', 'work:0', '/bin/sh');
    f.tmux('respawn-pane', '-k', '-t', 'work:0.2', '/bin/sh', '-c', 'sleep 60; exec /bin/sh');
    f.run('work:0.0', IDS[0]); f.run('work:0.1', IDS[1]);
    await waitFor(() => events(f.root).length === 2);
    const oldPanes = [f.pane('work:0.0'), f.pane('work:0.1')];
    f.save();
    const snapshot = fs.readFileSync(f.last(), 'utf8');
    const manifest = decodeManifest(snapshot);
    assert.deepEqual(manifest.entries.map(e => e.id), IDS.slice(0, 2));
    assert.ok(manifest.entries.every(e => e.cwd === f.cwd));
    assert.equal(fs.readFileSync(previous, 'utf8').trim(), f.last());
    const rows = snapshot.split('\n').filter(line => line.startsWith('pane\t')).map(line => line.split('\t'));
    assert.equal(rows[0][10], ':'); assert.equal(rows[1][10], ':');
    assert.ok(rows[2][10].includes('sleep'), 'ordinary process row preserved');
    f.hook('post-save-layout', f.last());
    assert.equal(fs.readFileSync(f.last(), 'utf8'), snapshot, 'metadata is deterministic');
    f.stop();
    f.start('keep');
    // Consume IDs so saved %0/%1 cannot identify the restored sessions.
    for (let i = 0; i < 3; i++) {
      const id = f.tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '/bin/sh');
      f.tmux('kill-pane', '-t', id);
    }
    f.restore();
    try { await waitFor(() => events(f.root).length === 4); }
    catch (error) {
      const reports = fs.readdirSync(path.join(f.root, 'state')).filter(n => /-(error|restore)\.json$/.test(n))
        .map(n => JSON.parse(fs.readFileSync(path.join(f.root, 'state', n), 'utf8')));
      throw new Error(JSON.stringify({ error: error.message, reports, panes: f.tmux('list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}') }));
    }
    const resumed = events(f.root).slice(2).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(resumed.map(e => e.args), IDS.slice(0, 2).map(id => ['--resume', id]));
    assert.ok(resumed.every(e => e.cwd === f.cwd));
    assert.notEqual(f.pane('work:0.0'), oldPanes[0]);
    assert.equal(resumed[0].pane, f.pane('work:0.0'));
    assert.equal(resumed[1].pane, f.pane('work:0.1'));
    assert.equal(fs.existsSync(path.join(f.cwd, 'INJECTED')), false);
    const pids = f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}');
    f.restore(); f.hook('post-restore-all');
    assert.equal(f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'), pids);
    assert.equal(events(f.root).length, 4, 'repeat restore must not start duplicate agents');
    // Exiting Claude returns to a shell in the same pane.
    f.tmux('send-keys', '-t', resumed[0].pane, 'C-c');
    await waitFor(() => ['sh', 'bash'].includes(f.tmux('display-message', '-p', '-t', resumed[0].pane, '#{pane_current_command}')));
  } finally { f.clean(); }
});

test('an idle bootstrap pane at the saved address is replaced and resumed', async () => {
  const f = fixture();
  try {
    f.start(); f.run('work:0.0', IDS[0]);
    await waitFor(() => events(f.root).length === 1);
    f.save(); f.stop(); f.start();
    const bootstrap = f.pane('work:0.0');
    f.restore();
    await waitFor(() => events(f.root).length === 2);
    assert.notEqual(f.pane('work:0.0'), bootstrap);
    assert.deepEqual(events(f.root)[1].args, ['--resume', IDS[0]]);
  } finally { f.clean(); }
});

test('real save and restore preserve different arguments per session without replaying prompts or shell syntax', async t => {
  const f = fixture();
  t.after(f.clean);
  f.start();
  f.tmux('split-window', '-d', '-t', 'work:0', '/bin/sh');
  const literal = "literal 'quoted' $(touch INJECTED_ARGS) `touch INJECTED_ARGS`\nsecond line";
  const first = ['--dangerously-skip-permissions', '--model=opus', '--append-system-prompt', literal,
    '--settings', '{"env":{"EXAMPLE":"a b"}}'];
  const second = ['--permission-mode', 'plan', '--tools', ''];
  f.run('work:0.0', IDS[0], [...first, 'one-shot prompt must not run again']);
  f.run('work:0.1', IDS[1], second);
  await waitFor(() => events(f.root).length === 2);
  f.save();
  const manifest = decodeManifest(fs.readFileSync(f.last(), 'utf8'));
  assert.equal(manifest.version, 2);
  const savedAt = Date.now();
  assert.deepEqual(manifest.entries.map(entry => entry.args), [first, second]);
  assert.equal(JSON.stringify(manifest).includes('one-shot prompt'), false);
  f.stop(); f.start('keep'); f.restore();
  await waitFor(() => events(f.root).length === 4);
  const resumed = events(f.root).slice(2).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(resumed.map(entry => entry.args), [first, second].map((args, i) => ['--resume', IDS[i], ...args]));
  assert.equal(fs.existsSync(path.join(f.cwd, 'INJECTED_ARGS')), false);
  // Upstream reuses and can delete the same snapshot filename when saves share a second.
  await waitFor(() => Date.now() - savedAt >= 1000);
  f.save();
  assert.deepEqual(decodeManifest(fs.readFileSync(f.last(), 'utf8')).entries.map(entry => entry.args), [first, second]);
});

test('unsupported launch arguments keep the session mapping but prevent a partial restore', async t => {
  const f = fixture();
  t.after(f.clean);
  f.start();
  f.run('work:0.0', IDS[0], ['--future-unknown-option', 'private value']);
  await waitFor(() => events(f.root).length === 1);
  f.save();
  const manifest = decodeManifest(fs.readFileSync(f.last(), 'utf8'));
  assert.equal(manifest.entries[0].id, IDS[0]);
  assert.equal(manifest.entries[0].argsError, 'Unsupported Claude launch option');
  assert.equal(JSON.stringify(manifest).includes('private value'), false);
  f.stop(); f.start('keep'); f.restore();
  const report = JSON.parse(f.plugin('status')).reports.find(report => report.action === 'restore');
  assert.equal(report.skipped[0].code, 'ARGUMENTS_UNAVAILABLE');
  assert.equal(events(f.root).length, 1);
});

test('legacy version 1 snapshots remain restorable without captured arguments', async t => {
  const f = await savedFixture(t);
  const text = fs.readFileSync(f.last(), 'utf8');
  const manifest = decodeManifest(text);
  manifest.version = 1;
  for (const entry of manifest.entries) delete entry.args;
  f.writeLast(text.replace(/^claude-resurrect\t.*$/m, 'claude-resurrect\t' + JSON.stringify(manifest)));
  f.stop(); f.start('keep'); f.restore();
  await waitFor(() => events(f.root).length === 2);
  assert.deepEqual(events(f.root)[1].args, ['--resume', IDS[0]]);
});

test('malformed metadata still protects the sole busy pane from upstream overwrite', async () => {
  const f = fixture();
  try {
    f.start(); f.run('work:0.0', IDS[0]);
    await waitFor(() => events(f.root).length === 1);
    f.save();
    const before = f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}');
    f.writeLast(fs.readFileSync(f.last(), 'utf8').replace(/^claude-resurrect\t.*$/m, 'claude-resurrect\t{"version":1,"entries":[null]}'));
    f.restore();
    assert.equal(f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'), before);
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-never-overwrite'), '');
    assert.equal(events(f.root).length, 1);
    const errors = fs.readdirSync(path.join(f.root, 'state')).filter(n => n.endsWith('-error.json'));
    assert.equal(errors.length, 1);
    assert.match(JSON.parse(fs.readFileSync(path.join(f.root, 'state', errors[0]))).error, /metadata/);
  } finally { f.clean(); }
});

test('uninstall restores prior hooks, respects later edits, and never removes user overwrite settings', () => {
  const f = fixture();
  try {
    f.start(); f.plugin('uninstall');
    f.tmux('set-option', '-g', '@resurrect-hook-post-save-layout', 'false');
    f.tmux('set-option', '-g', '@resurrect-never-overwrite', 'on');
    f.plugin('install'); f.plugin('install');
    f.save();
    assert.equal(decodeManifest(fs.readFileSync(f.last(), 'utf8')).entries.length, 0, 'failed prior hook does not prevent our save');
    f.tmux('set-option', '-g', '@resurrect-hook-pre-restore-all', 'printf custom');
    f.plugin('uninstall'); f.plugin('uninstall');
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-hook-post-save-layout'), 'false');
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-hook-pre-restore-all'), 'printf custom');
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-hook-post-restore-all'), '');
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-never-overwrite'), 'on');
  } finally { f.clean(); }
});

test('TPM entry and hook runner work from a plugin path containing quotes and spaces', async () => {
  const f = fixture();
  try {
    f.start();
    const pluginPath = path.join(f.root, "plugin ' with spaces");
    fs.mkdirSync(pluginPath);
    for (const relative of ['src', 'bin', 'package.json', 'claude-resurrect.tmux']) {
      fs.cpSync(fileURLToPath(new URL('../' + relative, import.meta.url)), path.join(pluginPath, relative), { recursive: true });
    }
    const tmuxEnv = f.tmux('display-message', '-p', '#{socket_path},#{pid},0');
    execFileSync(path.join(pluginPath, 'claude-resurrect.tmux'), { env: { ...process.env, TMUX: tmuxEnv }, timeout: 15000 });
    f.run('work:0.0', IDS[0]);
    await waitFor(() => events(f.root).length === 1);
    f.save();
    assert.equal(decodeManifest(fs.readFileSync(f.last(), 'utf8')).entries[0].id, IDS[0]);
    const diagnostic = JSON.parse(f.plugin('doctor'));
    assert.equal(diagnostic.installed, true);
    assert.equal(diagnostic.captured, 1);
    assert.equal(diagnostic.liveNativeSessions, 1);
    assert.deepEqual(diagnostic.warnings, []);
  } finally { f.clean(); }
});

test('TPM clones, loads, and reloads the plugin before saving and restoring exact sessions', async t => {
  const f = fixture({ install: false });
  t.after(f.clean);
  const tpm = fileURLToPath(new URL('../.test-deps/tpm/', import.meta.url));
  const resurrect = fileURLToPath(new URL('../.test-deps/tmux-resurrect', import.meta.url));
  const source = path.join(f.root, 'source/tmux-claude-resurrect');
  const plugins = path.join(f.root, 'plugins');
  const config = path.join(f.root, 'config');
  const installed = path.join(plugins, 'tmux-claude-resurrect');
  fs.mkdirSync(source, { recursive: true });
  for (const relative of ['src', 'bin', 'package.json', 'claude-resurrect.tmux']) {
    fs.cpSync(fileURLToPath(new URL('../' + relative, import.meta.url)), path.join(source, relative), { recursive: true });
  }
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { env: gitEnv, encoding: 'utf8', timeout: 15000 });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture');
  fs.mkdirSync(path.join(config, 'tmux'), { recursive: true });
  fs.writeFileSync(path.join(config, 'tmux/tmux.conf'), [
    `set -g @plugin 'file://${resurrect}'`,
    `set -g @plugin 'file://${source}'`,
  ].join('\n') + '\n');
  const run = (script, ...args) => execFileSync(script, args, {
    env: { ...gitEnv, XDG_CONFIG_HOME: config,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      TMUX: f.tmux('display-message', '-p', '#{socket_path},#{pid},0') },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  const load = () => {
    f.tmux('set-environment', '-g', 'TMUX_PLUGIN_MANAGER_PATH', plugins + '/');
    run(path.join(tpm, 'tpm'));
  };
  const resurrectAction = action => run(f.tmux('show-option', '-gqv', `@resurrect-${action}-script-path`), ...(action === 'save' ? ['quiet'] : []));

  f.start();
  assert.equal(f.tmux('show-option', '-gqv', '@resurrect-hook-post-save-layout'), '');
  f.tmux('set-environment', '-g', 'TMUX_PLUGIN_MANAGER_PATH', plugins + '/');
  run(path.join(tpm, 'scripts/install_plugins.sh'));
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.equal(execFileSync('git', ['-C', installed, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), git('rev-parse', 'HEAD'));
  run(path.join(tpm, 'scripts/install_plugins.sh'));
  load(); load(); load();
  const diagnostic = JSON.parse(run(path.join(installed, 'bin/claude-resurrect'), 'doctor'));
  assert.equal(diagnostic.node, process.versions.node);
  assert.equal(diagnostic.installed, true);
  assert.deepEqual(diagnostic.warnings, []);
  for (const hook of ['post-save-layout', 'pre-restore-all', 'post-restore-all']) {
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-hook-' + hook), `${quote(path.join(installed, 'bin/claude-resurrect'))} hook ${quote(hook)}`);
    assert.equal(f.tmux('show-option', '-gqv', '@claude-resurrect-previous-' + hook), '');
  }
  f.run('work:0.0', IDS[0]);
  await waitFor(() => events(f.root).length === 1);
  resurrectAction('save');
  assert.equal(decodeManifest(fs.readFileSync(f.last(), 'utf8')).entries[0].id, IDS[0]);
  f.stop(); f.start('keep'); load();
  resurrectAction('restore');
  await waitFor(() => events(f.root).length === 2);
  assert.deepEqual(events(f.root)[1].args, ['--resume', IDS[0]]);
  assert.equal(events(f.root)[1].pane, f.pane('work:0.0'));
  resurrectAction('restore');
  assert.equal(events(f.root).length, 2);
});

test('a missing transcript is reported at save time and retained for later recovery', async t => {
  const f = await savedFixture(t);
  fs.unlinkSync(path.join(f.project, IDS[0] + '.jsonl'));
  f.hook('post-save-layout', f.last());
  const status = JSON.parse(f.plugin('status'));
  assert.equal(status.entries[0].id, IDS[0]);
  assert.equal(status.reports.find(report => report.action === 'save').unavailable.length, 1);
});

test('a live sole pane survives repeated restores', async t => {
  const f = await savedFixture(t);
  const original = f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}');
  f.restore(); f.restore();
  assert.equal(f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'), original);
  assert.equal(events(f.root).length, 1);
  assert.equal(f.tmux('show-option', '-gqv', '@resurrect-never-overwrite'), '');
});

test('a newly created busy pane is skipped', async t => {
  const f = await savedFixture(t);
  f.stop(); f.start('keep');
  f.hook('pre-restore-all');
  f.tmux('new-session', '-d', '-s', 'work', '/bin/sh', '-c', 'sleep 60');
  const originalPid = f.tmux('display-message', '-p', '-t', 'work:0.0', '#{pane_pid}');
  f.hook('post-restore-all');
  assert.equal(f.tmux('display-message', '-p', '-t', 'work:0.0', '#{pane_pid}'), originalPid);
  assert.equal(JSON.parse(f.plugin('status')).reports.find(report => report.action === 'restore').skipped[0].code, 'PANE_BUSY');
});

test('a session already running outside tmux is not duplicated', async t => {
  const f = await savedFixture(t);
  f.stop(); f.start('keep');
  const outside = spawn(f.fake, ['--resume', IDS[0]], { cwd: f.cwd, stdio: 'ignore', env: { ...process.env, TMUX: '', TMUX_PANE: '' } });
  try {
    await waitFor(() => events(f.root).length === 2);
    f.restore();
    assert.equal(events(f.root).length, 2);
    assert.equal(JSON.parse(f.plugin('status')).reports.find(report => report.action === 'restore').skipped[0].code, 'SESSION_ACTIVE');
  } finally {
    outside.kill();
    await new Promise(resolve => outside.once('exit', resolve));
  }
});

test('two servers share startup claims before Claude publishes its native registry record', async t => {
  const first = fixture();
  const second = fixture();
  t.after(() => { second.clean(); first.clean(); });
  first.start();
  first.run('work:0.0', IDS[0]);
  await waitFor(() => events(first.root).length === 1);
  first.save();
  first.stop();

  const gate = path.join(first.root, 'hold-registry');
  fs.writeFileSync(gate, '');
  first.start('keep');
  second.start('keep');
  for (const [option, value] of Object.entries({
    '@resurrect-dir': path.join(first.root, 'snapshots'),
    '@claude-resurrect-state-dir': path.join(first.root, 'state'),
    '@claude-resurrect-claude-dir': first.claudeDir,
    '@claude-resurrect-command': first.fake,
  })) second.tmux('set-option', '-g', option, value);

  first.restore();
  await waitFor(() => events(first.root).length === 2);
  const resumed = events(first.root)[1];
  const record = path.join(first.claudeDir, 'sessions', resumed.pid + '.json');
  assert.equal(fs.existsSync(record), false, 'the resumed process has not registered yet');
  assert.deepEqual(readNativeSessions(first.claudeDir, processes()).sessions, []);
  assert.equal(fs.existsSync(path.join(first.root, 'state/restore.lock')), false, 'the first launch pass has finished');

  second.restore();
  const report = JSON.parse(second.plugin('status')).reports.find(report => report.action === 'restore');
  assert.deepEqual(report.launched, []);
  assert.deepEqual(report.skipped.map(entry => entry.code), ['SESSION_ACTIVE']);
  assert.equal(events(first.root).length, 2, 'the shared claim prevents a second launch');

  fs.unlinkSync(gate);
  await waitFor(() => fs.existsSync(record));
  assert.equal(readNativeSessions(first.claudeDir, processes()).sessions[0].sessionId, IDS[0]);
  first.stop();
  second.tmux('kill-session', '-t', 'work');
  second.restore();
  await waitFor(() => events(first.root).length === 3);
  assert.deepEqual(events(first.root)[2].args, ['--resume', IDS[0]]);
  assert.equal(events(first.root)[2].pane, second.pane('work:0.0'));
});

for (const missing of ['transcript', 'directory']) {
  test(`restore skips a missing ${missing}`, async t => {
    const f = await savedFixture(t);
    f.stop(); f.start('keep');
    if (missing === 'transcript') fs.unlinkSync(path.join(f.project, IDS[0] + '.jsonl'));
    else fs.renameSync(f.cwd, f.cwd + '-missing');
    f.restore();
    assert.equal(events(f.root).length, 1);
    assert.equal(JSON.parse(f.plugin('status')).reports.find(report => report.action === 'restore').skipped[0].code, 'FILES_MISSING');
  });
}

test('changed snapshots abort restore and remain diagnosable through the CLI', async t => {
  const f = await savedFixture(t);
  f.stop(); f.start('keep');
  f.hook('pre-restore-all');
  f.tmux('new-session', '-d', '-s', 'work', '/bin/sh');
  f.writeLast(fs.readFileSync(f.last(), 'utf8') + '\n');
  f.hook('post-restore-all');
  assert.equal(events(f.root).length, 1);
  const status = JSON.parse(f.plugin('status'));
  assert.match(status.reports.find(report => report.action === 'error').error, /Snapshot changed/);
});

test('status still shows the error report when the snapshot metadata is damaged', async t => {
  const f = await savedFixture(t);
  f.writeLast('claude-resurrect\t{"version":1,"entries":[null]}\n');
  f.hook('pre-restore-all'); f.hook('post-restore-all');
  const status = JSON.parse(f.plugin('status'));
  assert.equal(status.snapshot, null);
  assert.match(status.snapshotError, /metadata/);
  assert.match(status.reports.find(report => report.action === 'error').error, /metadata/);
  assert.equal(events(f.root).length, 1);
});
