import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quote, parseProcesses, distance, liveRegistry, decodeManifest, processes } from '../src/resurrect.mjs';

const SCRIPT = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const NODE = fs.realpathSync(process.execPath);
const RESURRECT = fileURLToPath(new URL('../.test-deps/tmux-resurrect/scripts', import.meta.url));
const IDS = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for fixture');
};
const events = root => { try { return fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/claude-resurrect-test-'));
  const socket = path.join(root, 'tmux.sock');
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, "project ' $(touch INJECTED)");
  const binDir = path.join(root, "bin with ' spaces");
  fs.mkdirSync(cwd); fs.mkdirSync(binDir); fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  for (const id of IDS) fs.writeFileSync(path.join(project, id + '.jsonl'), '{}\n');
  const fake = path.join(binDir, 'claude');
  fs.writeFileSync(fake, `#!${NODE}\nimport fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const id = process.argv[3];
const start = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim().replace(/\\s+/g, ' ');
fs.writeFileSync(path.join(root, 'claude/sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, procStart: start, sessionId: id, cwd: process.cwd(), kind: 'interactive', entrypoint: 'cli' }));
fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ args: process.argv.slice(2), id, cwd: process.cwd(), pane: process.env.TMUX_PANE, pid: process.pid, start }) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  let env;
  const start = (name = 'work') => {
    execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', '200', '-y', '80', '/bin/sh'], { env: { ...process.env, TMUX: '', XDG_CONFIG_HOME: path.join(root, 'config') } });
    env = { ...process.env, TMUX: tmux('display-message', '-p', '#{socket_path},#{pid},0'), TERM: 'xterm-256color' };
    for (const [name, value] of Object.entries({
      'default-shell': '/bin/sh', '@resurrect-dir': path.join(root, 'snapshots'),
      '@resurrect-capture-pane-contents': 'off', '@resurrect-processes': 'false',
      '@claude-resurrect-claude-dir': claudeDir,
      '@claude-resurrect-state-dir': path.join(root, 'state'), '@claude-resurrect-command': fake,
    })) tmux('set-option', '-g', name, value);
    plugin('install');
  };
  const plugin = (...args) => execFileSync(NODE, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 15000 });
  const hook = (name, ...args) => plugin('hook', name, ...args);
  const save = () => execFileSync('/bin/bash', [path.join(RESURRECT, 'save.sh'), 'quiet'], { env, encoding: 'utf8', timeout: 30000 });
  const restore = () => execFileSync('/bin/bash', [path.join(RESURRECT, 'restore.sh')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const stop = () => {
    try { tmux('kill-server'); } catch {}
    // Non-interactive test shells do not necessarily forward SIGHUP.
    for (const e of events(root).filter(e => e.pane)) {
      try { if (processes().get(e.pid)?.start === e.start) process.kill(e.pid, 'SIGTERM'); } catch {}
    }
  };
  const pane = target => tmux('display-message', '-p', '-t', target, '#{pane_id}');
  const run = (target, id) => tmux('respawn-pane', '-k', '-t', target, '-c', cwd, '/bin/sh', '-c', `${quote(fake)} --resume ${quote(id)}; exec /bin/sh`);
  const last = () => fs.realpathSync(path.join(root, 'snapshots/last'));
  const writeLast = value => fs.writeFileSync(last(), value);
  return { root, cwd, fake, project, claudeDir, tmux, start, stop, plugin, hook, save, restore, pane, run, last, writeLast,
    clean: () => { stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}

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

test('busy panes, active sessions, missing transcripts, and changed snapshots are skipped', async () => {
  const f = fixture();
  let outside;
  try {
    f.start();
    f.run('work:0.0', IDS[0]);
    await waitFor(() => events(f.root).length === 1);
    f.save();
    const transcript = path.join(f.project, IDS[0] + '.jsonl');
    fs.unlinkSync(transcript);
    f.hook('post-save-layout', f.last());
    assert.equal(decodeManifest(fs.readFileSync(f.last(), 'utf8')).entries[0].id, IDS[0], 'verified IDs survive a missing transcript at save time');
    const saveReport = fs.readdirSync(path.join(f.root, 'state')).find(n => n.endsWith('-save.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'state', saveReport), 'utf8')).unavailable.length, 1);
    fs.writeFileSync(transcript, '{}\n');
    f.hook('post-save-layout', f.last());
    const savedText = fs.readFileSync(f.last(), 'utf8');
    const onlyPane = f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}');
    f.restore();
    assert.equal(f.tmux('list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'), onlyPane, 'Resurrect must not replace a sole busy pane');
    assert.equal(events(f.root).length, 1);
    assert.equal(f.tmux('show-option', '-gqv', '@resurrect-never-overwrite'), '', 'temporary overwrite guard is cleared');
    f.stop(); f.start('keep');
    f.hook('pre-restore-all');
    f.tmux('new-session', '-d', '-s', 'work', '/bin/sh', '-c', 'sleep 60');
    const busyPid = f.tmux('display-message', '-p', '-t', 'work:0.0', '#{pane_pid}');
    f.hook('post-restore-all');
    assert.equal(f.tmux('display-message', '-p', '-t', 'work:0.0', '#{pane_pid}'), busyPid);
    assert.equal(events(f.root).length, 1);
    f.tmux('kill-session', '-t', 'work');
    outside = spawn(f.fake, ['--resume', IDS[0]], { cwd: f.cwd, stdio: 'ignore', env: { ...process.env, TMUX: '', TMUX_PANE: '' } });
    await waitFor(() => events(f.root).length === 2);
    f.restore();
    assert.equal(events(f.root).length, 2, 'already running outside tmux is not duplicated');
    outside.kill(); await new Promise(resolve => outside.once('exit', resolve)); outside = null;
    f.tmux('kill-session', '-t', 'work');
    fs.unlinkSync(path.join(f.project, IDS[0] + '.jsonl'));
    f.restore();
    assert.equal(events(f.root).length, 2, 'missing transcript is not resumed');
    f.tmux('kill-session', '-t', 'work');
    fs.writeFileSync(path.join(f.project, IDS[0] + '.jsonl'), '{}\n');
    fs.renameSync(f.cwd, f.cwd + '-missing');
    f.restore();
    assert.equal(events(f.root).length, 2, 'missing working directory is not resumed');
    fs.renameSync(f.cwd + '-missing', f.cwd);
    f.tmux('kill-session', '-t', 'work');
    f.hook('pre-restore-all');
    f.tmux('new-session', '-d', '-s', 'work', '/bin/sh');
    f.writeLast(savedText + '\n');
    f.hook('post-restore-all');
    assert.equal(events(f.root).length, 2, 'changed snapshot invalidates pending restore');
    f.writeLast('claude-resurrect\t{"version":1,"entries":[{}]}\n');
    f.hook('pre-restore-all'); f.hook('post-restore-all');
    assert.equal(events(f.root).length, 2, 'malformed metadata cannot launch a command');
  } finally { outside?.kill(); f.clean(); }
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
    for (const relative of ['src', 'bin', 'claude-resurrect.tmux']) {
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
