import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProcesses, readNativeSessions } from '../src/claude.mjs';

const START = 'Mon Sep 14 06:25:00 2026';
const TICKS = '4150422';
const STAT = '42 (claude worker) S 21 42 42 34816 42 4194304 120 0 0 0 4 2 0 0 20 0 1 0 4150422 1048576 256\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const procRoot = path.join(root, 'proc');
  fs.mkdirSync(path.join(procRoot, '42'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'));
  const stat = path.join(procRoot, '42/stat');
  fs.writeFileSync(stat, STAT);
  const record = { pid: 42, procStart: TICKS, sessionId: '00000000-0000-4000-8000-000000000001',
    cwd: root, kind: 'interactive', entrypoint: 'cli' };
  const write = value => fs.writeFileSync(path.join(root, 'sessions/42.json'), JSON.stringify(value));
  write(record);
  const table = parseProcesses(`42 21 pts/0 ${START} claude`);
  const read = (platform = 'linux') => readNativeSessions(root, table, { platform, procRoot });
  return { record, write, read, table, stat };
}

test('Linux native identities use exact clock ticks, accepting decimal strings and safe integers', t => {
  const f = fixture(t);
  for (const procStart of [TICKS, Number(TICKS)]) {
    f.write({ ...f.record, procStart });
    const result = f.read();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].procStart, TICKS);
    assert.deepEqual(result.warnings, []);
  }
  const large = '9007199254740993';
  fs.writeFileSync(f.stat, STAT.replace(TICKS, large));
  f.write({ ...f.record, procStart: large });
  assert.equal(f.read().sessions[0].procStart, large, 'string ticks must not lose integer precision');
});

test('Linux stat parsing tolerates spaces, parentheses, and newlines inside comm', t => {
  const f = fixture(t);
  for (const name of ['claude', 'claude worker', 'claude ) (job)', 'claude\nworker)']) {
    fs.writeFileSync(f.stat, STAT.replace('(claude worker)', `(${name})`));
    assert.equal(f.read().sessions[0].procStart, TICKS);
  }
});

test('Linux native identities reject unsupported timestamps and diagnose reused live PIDs', t => {
  const f = fixture(t);
  for (const procStart of [START, '4.150422e6', '', ' 4150422 ', -1, 1.5, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    f.write({ ...f.record, procStart });
    const result = f.read();
    assert.deepEqual(result.sessions, []);
    assert.equal(result.warnings[0].code, 'INVALID_RECORD');
  }
  f.write({ ...f.record, procStart: '4150423' });
  assert.deepEqual(f.read().sessions, []);
  assert.equal(f.read().warnings[0].code, 'PROCESS_START_MISMATCH');
  f.table.clear();
  assert.deepEqual(f.read(), { sessions: [], warnings: [] }, 'exited processes are ordinary stale records');
});

test('Linux native identities skip vanished processes and fail closed on unreadable or malformed stat', t => {
  const f = fixture(t);
  for (const stat of ['', '42 claude S 21', STAT.replace('42 (', '43 ('), STAT.replace(TICKS, 'invalid'),
    STAT.slice(0, STAT.indexOf(TICKS))]) {
    fs.writeFileSync(f.stat, stat);
    assert.throws(() => f.read(), /Cannot verify Linux process start time/);
  }
  fs.unlinkSync(f.stat);
  assert.deepEqual(f.read(), { sessions: [], warnings: [] });
  fs.writeFileSync(f.stat, STAT);
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === f.stat) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readFileSync(file, ...args);
  });
  assert.throws(() => f.read(), /Cannot verify Linux process start time/);
});

test('macOS native identities retain normalized ps start times and diagnose mismatches', t => {
  const f = fixture(t);
  f.write({ ...f.record, procStart: START.replace('Sep 14', 'Sep  14') });
  assert.equal(f.read('darwin').sessions[0].procStart, START);
  f.write({ ...f.record, procStart: TICKS });
  assert.deepEqual(f.read('darwin').sessions, []);
  assert.equal(f.read('darwin').warnings[0].code, 'PROCESS_START_MISMATCH');
});
