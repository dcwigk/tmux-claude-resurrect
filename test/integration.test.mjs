import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quote } from '../src/resurrect.mjs';
import { decodeManifest } from '../src/snapshot.mjs';
import { IDS, fixture, savedFixture, waitFor, events } from './helpers.mjs';

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
