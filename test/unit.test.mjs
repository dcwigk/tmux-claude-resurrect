import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseProcesses, distance, readNativeSessions, selectSessions, transcriptValid, transcriptFor, idle, processes } from '../src/claude.mjs';
import { decodeManifest, readSnapshot } from '../src/snapshot.mjs';
import { atomicJSON, readJSON } from '../src/files.mjs';
import { quote, acquireLock, unlock, paneSkipReason, activeClaims } from '../src/resurrect.mjs';

const IDS = [1, 2].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const START = 'Mon Sep 14 06:25:00 2026';
const table = () => parseProcesses(`21 10 ttys001 Mon Sep 14 06:24:27 2026 /bin/zsh
42 21 ttys001 ${START} /usr/local/bin/claude
43 42 ttys001 ${START} helper
44 21 pts/0 ${START} 2.1.272
45 44 pts/0 ${START} claude`);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  const project = path.join(root, 'projects', 'example');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, IDS[0] + '.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const record = { pid: 42, procStart: START, sessionId: IDS[0], cwd: root, kind: 'interactive', entrypoint: 'cli' };
  const write = (value, filename = '42.json') => fs.writeFileSync(path.join(root, 'sessions', filename), JSON.stringify(value));
  const panes = [{ session: 'work', window: '0', pane: '0', paneId: '%0', pid: 21, command: 'zsh', inMode: '0' }];
  const c = { claudeDir: root, stateDir: path.join(root, 'state'), panes: () => panes, processes, now: Date.now };
  return { root, project, transcript, record, write, c, panes };
}
const manifest = entries => 'claude-resurrect\t' + JSON.stringify({ version: 1, entries });

test('macOS and Linux process rows normalize start times and tolerate malformed lines', () => {
  const parsed = parseProcesses(`  42 21 pts/0 Mon Sep  7 06:25:00 2026 /path with spaces/claude\nbroken`);
  assert.equal(parsed.get(42).start, 'Mon Sep 7 06:25:00 2026');
  assert.equal(parsed.get(42).command, 'claude');
  assert.equal(parsed.size, 1);
  assert.equal(distance(43, 21, table()), 2);
  assert.equal(distance(21, 43, table()), Infinity);
  const cycle = new Map([[7, { ppid: 8 }], [8, { ppid: 7 }]]);
  assert.equal(distance(7, 2, cycle), Infinity);
});

test('native registry rejects stale PIDs, mismatched filenames and unknown identities', t => {
  const f = fixture(t);
  f.write(f.record);
  assert.equal(readNativeSessions(f.root, table()).sessions.length, 1);
  for (const override of [{ pid: 43 }, { pid: '42' }, { procStart: 'yesterday' },
    { sessionId: 'latest' }, { sessionId: [IDS[0]] }, { procStart: null }, { pid: 99999 }]) {
    f.write({ ...f.record, ...override });
    assert.deepEqual(readNativeSessions(f.root, table()).sessions, [], JSON.stringify(override));
  }
  fs.writeFileSync(path.join(f.root, 'sessions/42.json'), '{');
  f.write(f.record, 'not-a-pid.json');
  assert.deepEqual(readNativeSessions(f.root, table()).sessions, []);
  fs.writeFileSync(path.join(f.root, 'sessions/42.json'), ' '.repeat(1024 * 1024 + 1));
  assert.deepEqual(readNativeSessions(f.root, table()).sessions, []);
});

function selectionFixture() {
  const panes = [{ session: 'work', window: '0', pane: '0', paneId: '%0', pid: 21, command: 'zsh', inMode: '0' }];
  const record = { pid: 42, procStart: START, sessionId: IDS[0], cwd: '/example', kind: 'interactive', entrypoint: 'cli' };
  return { panes, record, table: table() };
}

test('selection excludes SDK sessions and keeps the outer interactive session without filesystem access', () => {
  const f = selectionFixture();
  assert.deepEqual(selectSessions(f.panes, f.table, [f.record, { ...f.record, pid: 43, sessionId: IDS[1] }]).entries.map(entry => entry.id), [IDS[0]]);
  for (const override of [{ kind: 'sdk' }, { entrypoint: 'sdk' }, { kind: undefined }, { cwd: 'relative' }]) {
    assert.equal(selectSessions(f.panes, f.table, [{ ...f.record, ...override }]).entries.length, 0);
  }
});

test('selection rejects equally near sessions and duplicate IDs in distinct panes', () => {
  const f = selectionFixture();
  assert.equal(selectSessions(f.panes, f.table, [f.record, { ...f.record, pid: 44, sessionId: IDS[1] }]).skipped[0].code, 'AMBIGUOUS_SESSION');
  f.panes.push({ ...f.panes[0], pane: '1', paneId: '%1', pid: 44 });
  f.table.get(44).ppid = 10;
  const result = selectSessions(f.panes, f.table, [f.record, { ...f.record, pid: 44 }]);
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped.length, 2);
});

test('no verified native record means no guessed session', () => {
  const f = selectionFixture();
  const result = selectSessions(f.panes, f.table, []);
  assert.deepEqual(result.entries, []);
  assert.equal(result.skipped[0].code, 'NO_NATIVE_SESSION');
});

test('transcripts require a unique, nonempty file contained in the selected Claude profile', t => {
  const f = fixture(t);
  assert.equal(transcriptValid(f.root, f.transcript, IDS[0]), true);
  assert.equal(transcriptFor(f.root, IDS[0], '/unrelated'), fs.realpathSync(f.transcript));
  const other = path.join(f.root, 'projects', 'other');
  fs.mkdirSync(other);
  fs.copyFileSync(f.transcript, path.join(other, IDS[0] + '.jsonl'));
  assert.equal(transcriptFor(f.root, IDS[0], '/unrelated'), null);
  fs.writeFileSync(f.transcript, '');
  assert.equal(transcriptValid(f.root, f.transcript, IDS[0]), false);
  const outside = path.join(f.root, IDS[0] + '.jsonl');
  fs.writeFileSync(outside, '{}\n');
  fs.unlinkSync(f.transcript);
  fs.symlinkSync(outside, f.transcript);
  assert.equal(transcriptValid(f.root, f.transcript, IDS[0]), false);
});

test('manifest rejects malformed schemas, duplicate positions, duplicate IDs and control characters', t => {
  const f = fixture(t);
  const entry = { session: 'work', window: '0', pane: '0', id: IDS[0], cwd: f.root, transcript: f.transcript };
  assert.equal(decodeManifest(manifest([entry])).entries.length, 1);
  for (const input of ['', 'claude-resurrect\tnull', manifest([entry]) + '\n' + manifest([]),
    'claude-resurrect\t{"version":2,"entries":[]}', manifest([entry, entry]),
    manifest([entry, { ...entry, pane: '1' }]), manifest([{ ...entry, cwd: 'relative' }]),
    manifest([{ ...entry, window: 0 }]), manifest([{ ...entry, id: [IDS[0]] }]),
    manifest([{ ...entry, session: 'bad\nname' }]), manifest([{ ...entry, transcript: '../file' }])]) {
    assert.throws(() => decodeManifest(input), input);
  }
});

test('snapshot selection refuses external paths and oversized files', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'snapshots');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'snapshot.txt');
  fs.writeFileSync(file, manifest([]));
  fs.symlinkSync(file, path.join(dir, 'last'));
  const c = { resurrectDir: dir };
  assert.equal(readSnapshot(c.resurrectDir).manifest.entries.length, 0);
  fs.unlinkSync(path.join(dir, 'last'));
  fs.symlinkSync(f.transcript, path.join(dir, 'last'));
  assert.throws(() => readSnapshot(c.resurrectDir), /outside/);
  fs.unlinkSync(path.join(dir, 'last'));
  fs.symlinkSync(file, path.join(dir, 'last'));
  fs.truncateSync(file, 16 * 1024 * 1024 + 1);
  assert.throws(() => readSnapshot(c.resurrectDir), /size limit/);
});

test('shell quoting preserves literal filenames without evaluating their contents', t => {
  const f = fixture(t);
  const literal = "spaces ' $(touch INJECTED) ; `echo nope`";
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${quote(literal)}`], { encoding: 'utf8', cwd: f.root }), literal);
  assert.equal(fs.existsSync(path.join(f.root, 'INJECTED')), false);
});

test('state is written atomically with private permissions and no leftover temporary files', t => {
  const f = fixture(t);
  const file = path.join(f.c.stateDir, 'test.json');
  atomicJSON(file, { first: true });
  atomicJSON(file, { second: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { second: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.c.stateDir), ['test.json']);
});

test('restore locks reject concurrent owners and require explicit stale recovery', t => {
  const f = fixture(t);
  const lock = acquireLock(f.c);
  assert.throws(() => acquireLock(f.c), /lock exists/);
  assert.throws(() => unlock(f.c), /still running/);
  lock.release();
  const file = path.join(f.c.stateDir, 'restore.lock');
  atomicJSON(file, { pid: process.pid, start: 'stale process identity' });
  assert.throws(() => unlock(f.c), /too recent/);
  fs.utimesSync(file, 1, 1);
  unlock(f.c);
  assert.equal(fs.existsSync(file), false);
  const oldLock = acquireLock(f.c);
  atomicJSON(file, { token: 'replacement' });
  oldLock.release();
  assert.equal(fs.existsSync(file), true, 'release cannot remove another owner’s lock');
});

test('only shells without descendants or copy mode qualify as idle', () => {
  const map = new Map([[21, { pid: 21, ppid: 1, start: START }]]);
  const pane = { pid: 21, command: 'sh', inMode: '0' };
  assert.equal(idle(pane, map), true);
  assert.equal(idle({ ...pane, command: 'claude' }, map), false);
  assert.equal(idle({ ...pane, inMode: '1' }, map), false);
  map.set(22, { pid: 22, ppid: 21 });
  assert.equal(idle(pane, map), false);
});

test('JSON reads distinguish missing files, damaged content, and filesystem errors', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'state.json');
  assert.equal(readJSON(file).status, 'missing');
  fs.writeFileSync(file, '{');
  assert.equal(readJSON(file).status, 'invalid');
  assert.equal(readJSON(path.join(file, 'child')).status, 'unreadable');
  fs.writeFileSync(file, 'null');
  assert.deepEqual(readJSON(file), { status: 'ok', value: null });
});

test('native registry distinguishes an empty directory, missing registry, and malformed records', t => {
  const f = fixture(t);
  assert.deepEqual(readNativeSessions(f.root, table()), { sessions: [], warnings: [] });
  fs.writeFileSync(path.join(f.root, 'sessions/42.json'), '{');
  assert.equal(readNativeSessions(f.root, table()).warnings[0].code, 'INVALID_RECORD');
  fs.rmSync(path.join(f.root, 'sessions'), { recursive: true });
  assert.equal(readNativeSessions(f.root, table()).warnings[0].code, 'REGISTRY_MISSING');
});

test('pane eligibility preserves existing processes and permits only idle replacements', () => {
  const pane = { paneId: '%1', pid: 21, command: 'sh', inMode: '0' };
  const original = { paneId: '%1', pid: 21, start: START, idle: true };
  const observed = new Map([[21, { pid: 21, ppid: 1, start: START }]]);
  assert.equal(paneSkipReason(undefined, undefined, observed).code, 'PANE_MISSING');
  assert.equal(paneSkipReason(pane, original, observed).code, 'PANE_EXISTED');
  assert.equal(paneSkipReason(pane, undefined, observed), null);
  assert.equal(paneSkipReason({ ...pane, inMode: '1' }, undefined, observed).code, 'PANE_BUSY');
  observed.get(21).start = 'Tue Sep 15 06:25:00 2026';
  assert.equal(paneSkipReason(pane, original, observed), null, 'a changed process identity can qualify');
  assert.equal(paneSkipReason(pane, { ...original, idle: false }, observed).code, 'PANE_EXISTED');
  observed.set(22, { pid: 22, ppid: 21 });
  assert.equal(paneSkipReason(pane, undefined, observed).code, 'PANE_BUSY');
});

test('launch claims require valid metadata and expire using supplied observations and time', () => {
  const claim = { pid: 21, start: START, time: 100000, paneId: '%1', server: 'test' };
  const observed = new Map([[21, { pid: 21, start: START }]]);
  assert.ok(activeClaims({ [IDS[0]]: claim }, observed, 110000)[IDS[0]]);
  assert.ok(activeClaims({ [IDS[0]]: claim }, observed, 90000)[IDS[0]], 'a clock rollback does not remove startup protection');
  assert.deepEqual(activeClaims({ [IDS[0]]: claim }, observed, 170000), {});
  observed.get(21).start = 'reused PID';
  assert.deepEqual(activeClaims({ [IDS[0]]: claim }, observed, 110000), {});
  assert.throws(() => activeClaims([], observed, 110000), /Invalid launch claims/);
  assert.throws(() => activeClaims({ [IDS[0]]: { time: 100000 } }, observed, 110000), /Invalid launch claim/);
});
