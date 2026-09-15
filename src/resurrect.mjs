#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RUNNER = fileURLToPath(new URL('../bin/claude-resurrect', import.meta.url));
export const PREFIX = '@claude-resurrect-';
const ROW = 'claude-resurrect\t';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
export const HOOKS = ['post-save-layout', 'pre-restore-all', 'post-restore-all'];
export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const key = entry => JSON.stringify([entry.session, entry.window, entry.pane]);
const hash = text => createHash('sha256').update(text).digest('hex');
const clean = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value);
export const readJSON = file => { try { return JSON.parse(readFile(file, 1024 * 1024)); } catch { return null; } };
export function readFile(file, limit = 16 * 1024 * 1024) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error('File is not regular or exceeds size limit');
  return fs.readFileSync(file, 'utf8');
}
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const normalizeStart = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseProcesses(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if (match) result.set(Number(match[1]), {
      pid: Number(match[1]), ppid: Number(match[2]), tty: match[3],
      start: normalizeStart(match[4]), command: path.basename(match[5].trim()),
    });
  }
  return result;
}

export function processes() {
  return parseProcesses(execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,comm='], {
    encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 10000,
  }));
}

export function distance(pid, ancestor, table) {
  const seen = new Set();
  for (let depth = 0; pid > 1 && !seen.has(pid); depth++) {
    if (pid === ancestor) return depth;
    seen.add(pid);
    pid = table.get(pid)?.ppid ?? 0;
  }
  return Infinity;
}

// Claude's native registry is internal. Unknown records must not become guesses.
export function liveRegistry(root, table) {
  return list(path.join(root, 'sessions')).filter(name => /^\d+\.json$/.test(name)).flatMap(name => {
    const item = readJSON(path.join(root, 'sessions', name));
    const proc = table.get(item?.pid);
    if (!proc || item.pid !== Number(name.slice(0, -5)) || typeof item.sessionId !== 'string' || !UUID.test(item.sessionId)
      || !clean(item.procStart) || normalizeStart(item.procStart) !== proc.start) return [];
    return [{ pid: item.pid, procStart: proc.start, sessionId: item.sessionId.toLowerCase(),
      cwd: item.cwd, kind: item.kind, entrypoint: item.entrypoint }];
  });
}

export function decodeManifest(snapshot) {
  const rows = snapshot.split('\n').filter(line => line.startsWith(ROW));
  if (rows.length !== 1) throw new Error('Snapshot has no unique Claude metadata');
  const manifest = JSON.parse(rows[0].slice(ROW.length));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 10000) throw new Error('Unsupported Claude metadata');
  const positions = new Set(), ids = new Set();
  for (const e of manifest.entries) {
    if (!e || !clean(e.session) || typeof e.window !== 'string' || !/^\d{1,10}$/.test(e.window)
      || typeof e.pane !== 'string' || !/^\d{1,10}$/.test(e.pane)
      || typeof e.id !== 'string' || !UUID.test(e.id) || !clean(e.cwd) || !path.isAbsolute(e.cwd)
      || !clean(e.transcript) || !path.isAbsolute(e.transcript)
      || positions.has(key(e)) || ids.has(e.id.toLowerCase())) throw new Error('Invalid or ambiguous Claude metadata');
    e.id = e.id.toLowerCase();
    positions.add(key(e)); ids.add(e.id);
  }
  return manifest;
}

export function context() {
  const match = process.env.TMUX?.match(/^(.*),\d+,\d+$/);
  if (!match) throw new Error('Run inside tmux or from a tmux hook');
  const tmux = (...args) => execFileSync('tmux', ['-S', match[1], ...args.map(String)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 10000,
  }).trimEnd();
  const option = (name, fallback = '') => tmux('show-option', '-gqv', name) || fallback;
  const expand = value => value.replace(/^~(?=\/|$)/, os.homedir())
    .replaceAll('$HOME', os.homedir()).replaceAll('$HOSTNAME', os.hostname());
  const claudeDir = expand(option(PREFIX + 'claude-dir', process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')));
  const legacy = path.join(os.homedir(), '.tmux/resurrect');
  const resurrectDir = expand(option('@resurrect-dir', fs.existsSync(legacy) ? legacy
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'tmux/resurrect')));
  const stateDir = expand(option(PREFIX + 'state-dir', path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'tmux/claude-resurrect')));
  const server = tmux('display-message', '-p', '#{pid}:#{start_time}');
  const panes = () => tmux('list-panes', '-a', '-F', [
    '#{session_name}', '#{window_index}', '#{pane_index}', '#{pane_id}', '#{pane_pid}',
    '#{pane_current_command}', '#{pane_current_path}', '#{pane_in_mode}',
  ].join('\t')).split('\n').filter(Boolean).map(line => {
    const [session, window, pane, paneId, pid, command, cwd, inMode] = line.split('\t');
    return { session, window, pane, paneId, pid: Number(pid), command, cwd, inMode };
  });
  return { tmux, option, expand, claudeDir, resurrectDir, stateDir, server, panes };
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

export function atomicJSON(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function report(c, action, value) {
  atomicJSON(path.join(c.stateDir, `${hash(c.server).slice(0, 12)}-${action}.json`), {
    time: new Date().toISOString(), action, ...value,
  });
}

export function transcriptValid(c, file, id) {
  try {
    const root = fs.realpathSync(path.join(c.claudeDir, 'projects')) + path.sep;
    return fs.realpathSync(file).startsWith(root) && path.basename(file) === `${id}.jsonl`
      && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch { return false; }
}

export function transcriptFor(c, id, cwd) {
  const root = path.join(c.claudeDir, 'projects');
  const expected = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  if (transcriptValid(c, expected, id)) return expected;
  const matches = [...new Set(list(root).map(dir => path.join(root, dir, `${id}.jsonl`))
    .filter(file => transcriptValid(c, file, id)).map(file => fs.realpathSync(file)))];
  return matches.length === 1 ? matches[0] : null;
}

function directoryExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

export function capture(c, snapshot, table = processes()) {
  const registry = liveRegistry(c.claudeDir, table);
  const savedKeys = new Set(snapshot.split('\n').filter(line => line.startsWith('pane\t')).map(line => {
    const fields = line.split('\t');
    return key({ session: fields[1], window: fields[2], pane: fields[5] });
  }));
  const entries = [], skipped = [], unavailable = [];
  for (const pane of c.panes()) {
    if (!savedKeys.has(key(pane))) continue;
    const candidates = registry.filter(r => r.kind === 'interactive' && r.entrypoint === 'cli'
      && distance(r.pid, pane.pid, table) < Infinity);
    // Nested Claude processes belong to the outer interactive session.
    const nearest = Math.min(...candidates.map(r => distance(r.pid, pane.pid, table)));
    const sessions = candidates.filter(r => distance(r.pid, pane.pid, table) === nearest)
      .map(r => ({ id: r.sessionId, cwd: r.cwd }));
    if (!sessions.length && [...table.values()].some(p => /^(claude|\d+\.\d+\.\d+)$/.test(p.command)
      && distance(p.pid, pane.pid, table) < Infinity)) {
      skipped.push({ target: key(pane), reason: 'No compatible live native session record' });
    }
    if (!sessions.length) continue;
    if (sessions.length !== 1) { skipped.push({ target: key(pane), reason: 'Ambiguous sessions' }); continue; }
    const { id, cwd } = sessions[0];
    if (!clean(cwd) || !path.isAbsolute(cwd)) { skipped.push({ target: key(pane), reason: 'Invalid working directory' }); continue; }
    const transcript = transcriptFor(c, id, cwd);
    if (!directoryExists(cwd) || !transcript) unavailable.push({ target: key(pane), id,
      reason: !directoryExists(cwd) ? 'Working directory is missing' : 'Transcript is missing or ambiguous' });
    entries.push({ session: pane.session, window: pane.window, pane: pane.pane, id, cwd,
      transcript: transcript || path.join(c.claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`) });
  }
  const counts = new Map();
  for (const e of entries) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  const unique = entries.filter(e => {
    if (counts.get(e.id) === 1) return true;
    skipped.push({ target: key(e), reason: 'Session active in multiple panes' }); return false;
  }).sort((a, b) => key(a).localeCompare(key(b)));
  return { manifest: { version: 1, entries: unique }, skipped,
    unavailable: unavailable.filter(item => unique.some(e => e.id === item.id)) };
}

export function save(c, file) {
  if (!file || path.dirname(fs.realpathSync(file)) !== fs.realpathSync(c.resurrectDir)) {
    throw new Error('Snapshot must be inside the Resurrect directory');
  }
  const snapshot = readFile(file);
  const { manifest, skipped, unavailable } = capture(c, snapshot);
  const captured = new Set(manifest.entries.map(key));
  const rows = snapshot.trimEnd().split('\n').filter(line => !line.startsWith(ROW)).map(line => {
    if (!line.startsWith('pane\t')) return line;
    const fields = line.split('\t');
    if (captured.has(key({ session: fields[1], window: fields[2], pane: fields[5] }))) {
      // Let this plugin resume Claude instead of replaying a saved child command.
      fields[10] = ':';
    }
    return fields.join('\t');
  });
  rows.push(ROW + JSON.stringify(manifest));
  atomicWrite(file, rows.join('\n') + '\n');
  report(c, 'save', { snapshot: file, captured: manifest.entries.length,
    ready: manifest.entries.length - unavailable.length, unavailable, skipped });
}

export function snapshot(c) {
  const file = fs.realpathSync(path.join(c.resurrectDir, 'last'));
  if (path.dirname(file) !== fs.realpathSync(c.resurrectDir)) throw new Error('Snapshot is outside the Resurrect directory');
  const text = readFile(file);
  return { file, digest: hash(text), manifest: decodeManifest(text) };
}

function clearOverwriteGuard(c) {
  if (c.option('@resurrect-never-overwrite') === 'claude-resurrect') {
    c.tmux('set-option', '-gu', '@resurrect-never-overwrite');
  }
}

export function beforeRestore(c) {
  c.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(c);
  const panes = c.panes(), table = processes();
  // Resurrect normally replaces the first pane when it is the only pane.
  if (panes.length === 1 && !idle(panes[0], table) && !c.option('@resurrect-never-overwrite')) {
    c.tmux('set-option', '-g', '@resurrect-never-overwrite', 'claude-resurrect');
  }
  const saved = snapshot(c);
  c.tmux('set-option', '-g', PREFIX + 'pending', JSON.stringify({
    file: saved.file, digest: saved.digest, server: c.server, time: Date.now(),
    panes: panes.map(p => ({ paneId: p.paneId, pid: p.pid, start: table.get(p.pid)?.start, idle: idle(p, table) })),
  }));
}

export function idle(pane, table) {
  return pane && SHELLS.has(pane.command) && pane.inMode === '0'
    && table.has(pane.pid) && ![...table.values()].some(p => p.pid !== pane.pid
      && distance(p.pid, pane.pid, table) < Infinity);
}

export function executable(c) {
  const command = c.expand(c.option(PREFIX + 'command', 'claude'));
  const options = command.includes('/') ? [command]
    : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command));
  const found = options.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!found) throw new Error('Claude executable not found');
  return path.resolve(found);
}

export function acquireLock(c) {
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(c.stateDir, 'restore.lock');
  const owner = { pid: process.pid, start: processes().get(process.pid)?.start, token: randomUUID() };
  if (!owner.start) throw new Error('Cannot verify restore process identity');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Restore lock exists; use doctor, then unlock if its owner has exited');
  }
  try { fs.writeFileSync(fd, JSON.stringify(owner)); }
  finally { fs.closeSync(fd); }
  return () => { if (readJSON(file)?.token === owner.token) fs.unlinkSync(file); };
}

export function unlock(c) {
  const file = path.join(c.stateDir, 'restore.lock');
  if (!fs.existsSync(file)) return;
  const owner = readJSON(file);
  if (owner?.start && processes().get(owner.pid)?.start === owner.start) throw new Error('Restore lock owner is still running');
  if (Date.now() - fs.statSync(file).mtimeMs < 30000) throw new Error('Restore lock is too recent; wait at least 30 seconds');
  fs.unlinkSync(file);
}

export async function afterRestore(c) {
  const rawPending = c.option(PREFIX + 'pending', 'null');
  c.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(c);
  const pending = JSON.parse(rawPending);
  if (!pending) return;
  const saved = snapshot(c);
  if (pending.server !== c.server || !Array.isArray(pending.panes) || !Number.isFinite(pending.time)
    || Date.now() < pending.time || Date.now() - pending.time > 120000
    || saved.file !== pending.file || saved.digest !== pending.digest) throw new Error('Snapshot changed during restore');
  const release = acquireLock(c);
  const launched = [], skipped = [];
  try {
    const command = executable(c);
    const shell = c.option('default-shell', '/bin/sh');
    const claimsFile = path.join(c.stateDir, 'launches.json');
    const claims = readJSON(claimsFile) || {};
    const initialTable = processes();
    for (const [id, claim] of Object.entries(claims)) {
      if (!claim || !Number.isFinite(claim.time) || Date.now() - claim.time > 60000
        || !claim.start || initialTable.get(claim.pid)?.start !== claim.start) delete claims[id];
    }
    const deadline = Date.now() + 4000;
    for (const entry of saved.manifest.entries) {
      const skip = reason => skipped.push({ target: key(entry), id: entry.id, reason });
      let pane = c.panes().find(p => key(p) === key(entry));
      if (!pane) { skip('Pane was not restored'); continue; }
      const original = pending.panes.find(p => p.paneId === pane.paneId);
      if (original && (!original.idle || original.pid === pane.pid
        && original.start === processes().get(pane.pid)?.start)) { skip('Pane already existed'); continue; }
      if (!directoryExists(entry.cwd) || !transcriptValid(c, entry.transcript, entry.id) && !transcriptFor(c, entry.id, entry.cwd)) {
        skip('Missing directory or transcript'); continue;
      }
      let table = processes();
      while (!idle(pane, table) && Date.now() < deadline) {
        await delay(100);
        pane = c.panes().find(p => key(p) === key(entry)); table = processes();
      }
      if (!idle(pane, table)) { skip('Pane is busy'); continue; }
      if (claims[entry.id] || liveRegistry(c.claudeDir, table).some(r => r.sessionId === entry.id)) {
        skip('Session is already running or starting'); continue;
      }
      // Recheck just before replacing a new or recreated idle shell.
      const fresh = c.panes().find(p => p.paneId === pane.paneId);
      if (!fresh || fresh.pid !== pane.pid || !idle(fresh, processes())) { skip('Pane changed'); continue; }
      const wrapper = `trap ':' INT; ${quote(command)} --resume ${quote(entry.id)}; exec ${quote(shell)} -l`;
      c.tmux('respawn-pane', '-k', '-t', pane.paneId, '-c', entry.cwd,
        '-e', `CLAUDE_CONFIG_DIR=${c.claudeDir}`, '/bin/sh', '-c', wrapper);
      c.tmux('set-option', '-p', '-t', pane.paneId, PREFIX + 'session', entry.id);
      const startedPane = c.panes().find(p => p.paneId === pane.paneId);
      claims[entry.id] = { time: Date.now(), server: c.server, paneId: pane.paneId,
        pid: startedPane?.pid, start: processes().get(startedPane?.pid)?.start };
      atomicJSON(claimsFile, claims);
      launched.push({ target: key(entry), id: entry.id });
    }
    report(c, 'restore', { snapshot: saved.file, launched, skipped });
    if (launched.length || skipped.length) c.tmux('display-message', `Claude: ${launched.length} launched, ${skipped.length} skipped`);
  } finally { release(); }
}

export function install(c) {
  for (const hook of HOOKS) {
    const name = '@resurrect-hook-' + hook;
    const current = c.option(name), installed = c.option(PREFIX + 'installed-' + hook);
    const command = `${quote(RUNNER)} hook ${quote(hook)}`;
    if (current !== installed && current !== command) c.tmux('set-option', '-g', PREFIX + 'previous-' + hook, current);
    c.tmux('set-option', '-g', name, command);
    c.tmux('set-option', '-g', PREFIX + 'installed-' + hook, command);
  }
}

export function uninstall(c) {
  for (const hook of HOOKS) {
    const name = '@resurrect-hook-' + hook;
    if (c.option(name) === c.option(PREFIX + 'installed-' + hook)) {
      const previous = c.option(PREFIX + 'previous-' + hook);
      if (previous) c.tmux('set-option', '-g', name, previous);
      else c.tmux('set-option', '-gu', name);
    }
    c.tmux('set-option', '-gu', PREFIX + 'installed-' + hook);
    c.tmux('set-option', '-gu', PREFIX + 'previous-' + hook);
  }
  c.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(c);
}
