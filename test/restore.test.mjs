import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeRestore, afterRestore, status, report, runHook } from '../src/resurrect.mjs';
import { atomicJSON, readJSON } from '../src/files.mjs';
import { IDS } from './helpers.mjs';

const START = 'Tue Sep 15 12:00:00 2026';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-restore-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resurrectDir = path.join(root, 'snapshots'), stateDir = path.join(root, 'state');
  fs.mkdirSync(resurrectDir);
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(path.join(root, 'projects/example'), { recursive: true });
  const entries = IDS.slice(0, 2).map((id, index) => {
    const transcript = path.join(root, 'projects/example', `${id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    return { session: 'work', window: '0', pane: String(index), id, cwd: root, transcript };
  });
  const snapshot = path.join(resurrectDir, 'snapshot.txt');
  fs.writeFileSync(snapshot, 'claude-resurrect\t' + JSON.stringify({ version: 1, entries }) + '\n');
  fs.symlinkSync(snapshot, path.join(resurrectDir, 'last'));
  const observed = new Map([[process.pid, { pid: process.pid, ppid: 1, start: START, command: 'node' }]]);
  const options = new Map([['@claude-resurrect-command', process.execPath]]);
  const calls = [], panes = [];
  let now = 100000, onSpawn = () => {}, onAnnotation = () => {};
  const runtime = {
    claudeDir: root, resurrectDir, stateDir, server: 'isolated-test-server', expand: value => value,
    processes: () => new Map(observed), now: () => now, sleep: async ms => { now += ms; },
    option: (key, fallback = '') => options.get(key) || fallback,
    panes: () => panes.map(pane => ({ ...pane })),
    tmux(...args) {
      calls.push(args);
      if (args[0] === 'set-option' && args[1] === '-g') options.set(args[2], args[3]);
      else if (args[0] === 'set-option' && args[1] === '-gu') options.delete(args[2]);
      else if (args[0] === 'respawn-pane') {
        const paneId = args[args.indexOf('-t') + 1];
        onSpawn(paneId);
        const pane = panes.find(pane => pane.paneId === paneId);
        observed.delete(pane.pid);
        pane.pid += 100;
        observed.set(pane.pid, { pid: pane.pid, ppid: 1, start: START, command: 'sh' });
      } else if (args[0] === 'set-option' && args[1] === '-p') onAnnotation();
      return '';
    },
  };
  beforeRestore(runtime);
  for (const [index, entry] of entries.entries()) {
    const pane = { ...entry, paneId: `%${index}`, pid: 1000000 + index, command: 'sh', inMode: '0' };
    panes.push(pane);
    observed.set(pane.pid, { pid: pane.pid, ppid: 1, start: START, command: 'sh' });
  }
  return { root, runtime, calls, snapshot, stateDir,
    onSpawn: callback => { onSpawn = callback; }, onAnnotation: callback => { onAnnotation = callback; },
    restoreReport: () => status(runtime).reports.find(report => report.action === 'restore'),
  };
}

test('one failed pane launch does not prevent a later eligible pane from starting', async t => {
  const f = fixture(t);
  f.onSpawn(paneId => { if (paneId === '%0') throw new Error('pane disappeared'); });
  await afterRestore(f.runtime);
  assert.deepEqual(f.restoreReport().launched.map(entry => entry.id), [IDS[1]]);
  assert.equal(f.restoreReport().failed[0].code, 'LAUNCH_FAILED');
  assert.equal(f.calls.filter(call => call[0] === 'respawn-pane').length, 2);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'restore.lock')), false);
});

test('a tmux server failure aborts the launch pass after the first failed pane', async t => {
  const f = fixture(t);
  const tmux = f.runtime.tmux;
  f.onSpawn(() => { throw new Error('respawn failed'); });
  f.runtime.tmux = (...args) => {
    if (args[0] === 'display-message' && args[2] === '#{pid}') throw new Error('tmux server unavailable');
    return tmux(...args);
  };
  await assert.rejects(afterRestore(f.runtime), /tmux server unavailable/);
  assert.equal(f.calls.filter(call => call[0] === 'respawn-pane').length, 1);
  assert.match(f.restoreReport().error, /tmux server unavailable/);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'restore.lock')), false);
});

test('busy panes share one wait budget for the entire restore', async t => {
  const f = fixture(t);
  const processes = f.runtime.processes;
  f.runtime.processes = () => {
    const observed = processes();
    for (const pane of f.runtime.panes()) {
      const pid = pane.pid + 100;
      observed.set(pid, { pid, ppid: pane.pid, start: START, command: 'sleep' });
    }
    return observed;
  };
  const sleep = t.mock.method(f.runtime, 'sleep');
  await afterRestore(f.runtime);
  assert.equal(sleep.mock.calls.reduce((total, call) => total + call.arguments[0], 0), 4000);
  assert.deepEqual(f.restoreReport().skipped.map(entry => entry.code), ['PANE_BUSY', 'PANE_BUSY']);
  assert.equal(f.calls.some(call => call[0] === 'respawn-pane'), false);
});

for (const claims of ['{', '[]']) {
  test(`invalid shared claims (${claims}) abort before any pane launch`, async t => {
    const f = fixture(t);
    fs.mkdirSync(f.stateDir);
    fs.writeFileSync(path.join(f.stateDir, 'launches.json'), claims);
    await assert.rejects(afterRestore(f.runtime), /launch claims/);
    assert.equal(f.calls.some(call => call[0] === 'respawn-pane'), false);
    assert.match(f.restoreReport().error, /launch claims/);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'restore.lock')), false);
  });
}

test('a shared claims write failure aborts later launches and preserves the partial report', async t => {
  const f = fixture(t);
  f.onSpawn(() => fs.mkdirSync(path.join(f.stateDir, 'launches.json')));
  await assert.rejects(afterRestore(f.runtime));
  assert.equal(f.calls.filter(call => call[0] === 'respawn-pane').length, 1);
  assert.deepEqual(f.restoreReport().launched.map(entry => entry.id), [IDS[0]]);
  assert.ok(f.restoreReport().error);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'restore.lock')), false);
});

test('losing the shared lock stops subsequent launches without deleting another owner', async t => {
  const f = fixture(t);
  const lockFile = path.join(f.stateDir, 'restore.lock');
  f.onAnnotation(() => atomicJSON(lockFile, { token: 'new-owner' }));
  await assert.rejects(afterRestore(f.runtime), /lock ownership/);
  assert.equal(f.calls.filter(call => call[0] === 'respawn-pane').length, 1);
  assert.equal(readJSON(lockFile).value.token, 'new-owner');
  assert.match(f.restoreReport().error, /lock ownership/);
});

test('corrupted snapshots and reports remain distinguishable in status', t => {
  const f = fixture(t);
  report(f.runtime, 'error', { error: 'original restore error' });
  const reportFile = fs.readdirSync(f.stateDir).find(name => name.endsWith('-error.json'));
  fs.writeFileSync(path.join(f.stateDir, reportFile.replace('-error.json', '-save.json')), '{');
  fs.writeFileSync(f.snapshot, 'claude-resurrect\t{"version":99}\n');
  const result = status(f.runtime);
  assert.match(result.snapshotError, /Unsupported/);
  assert.equal(result.reports[0].error, 'original restore error');
  assert.match(result.warnings[0], /invalid/);
});

test('a report write failure cannot prevent the pre-restore busy-pane guard', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.stateDir, 'not a directory');
  const originalOption = f.runtime.option;
  f.runtime.option = (name, fallback) => name === '@claude-resurrect-previous-pre-restore-all' ? 'false' : originalOption(name, fallback);
  f.runtime.panes = () => [{ paneId: '%0', pid: 1000000, command: 'claude', inMode: '0' }];
  const errors = t.mock.method(console, 'error', () => {});
  await runHook(f.runtime, 'pre-restore-all', []);
  assert.equal(f.runtime.option('@resurrect-never-overwrite'), 'claude-resurrect');
  assert.ok(errors.mock.callCount() > 0);
  await runHook(f.runtime, 'post-restore-all', []);
  assert.equal(f.runtime.option('@resurrect-never-overwrite'), '');
  assert.equal(f.calls.some(call => call[0] === 'respawn-pane'), false);
});
