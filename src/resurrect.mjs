import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJSON, directoryExists, isText, isUUID, listDirectory, readJSON } from './files.mjs';
import { processes, readNativeSessions, selectSessions, paneKey, idle,
  transcriptFor, transcriptValid, projectTranscriptPath } from './claude.mjs';
import { readLayout, snapshotPanes, readSnapshot, writeSnapshot } from './snapshot.mjs';

const RUNNER = fileURLToPath(new URL('../bin/claude-resurrect', import.meta.url));
const PREFIX = '@claude-resurrect-';
const HOOKS = ['post-save-layout', 'pre-restore-all', 'post-restore-all'];
const TMUX_QUERY_TIMEOUT_MS = 10000;
const PREVIOUS_HOOK_TIMEOUT_MS = 30000;
const PENDING_TTL_MS = 120000;
const CLAIM_TTL_MS = 60000;
const LOCK_RECOVERY_AGE_MS = 30000;
const SHELL_SETTLE_MS = 4000;
const SHELL_POLL_MS = 100;
export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const serverKey = runtime => createHash('sha256').update(runtime.server).digest('hex').slice(0, 12);
/** @typedef {ReturnType<typeof context>} Runtime */
/** @typedef {{ paneId: string, pid: number, start: string, idle: boolean }} PreviousPane */
/** @typedef {{ pid: number, start: string, time: number, server: string, paneId: string }} LaunchClaim */

export function context() {
  const match = process.env.TMUX?.match(/^(.*),\d+,\d+$/);
  if (!match) throw new Error('Run inside tmux or from a tmux hook');
  const tmux = (...args) => execFileSync('tmux', ['-S', match[1], ...args.map(String)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: TMUX_QUERY_TIMEOUT_MS,
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
  return { tmux, option, expand, claudeDir, resurrectDir, stateDir, server, panes,
    processes, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
}

export function install(runtime) {
  for (const hook of HOOKS) {
    const name = '@resurrect-hook-' + hook;
    const current = runtime.option(name), installed = runtime.option(PREFIX + 'installed-' + hook);
    const command = `${quote(RUNNER)} hook ${quote(hook)}`;
    if (current !== installed && current !== command) runtime.tmux('set-option', '-g', PREFIX + 'previous-' + hook, current);
    runtime.tmux('set-option', '-g', name, command);
    runtime.tmux('set-option', '-g', PREFIX + 'installed-' + hook, command);
  }
}

export function uninstall(runtime) {
  for (const hook of HOOKS) {
    const name = '@resurrect-hook-' + hook;
    if (runtime.option(name) === runtime.option(PREFIX + 'installed-' + hook)) {
      const previous = runtime.option(PREFIX + 'previous-' + hook);
      if (previous) runtime.tmux('set-option', '-g', name, previous);
      else runtime.tmux('set-option', '-gu', name);
    }
    runtime.tmux('set-option', '-gu', PREFIX + 'installed-' + hook);
    runtime.tmux('set-option', '-gu', PREFIX + 'previous-' + hook);
  }
  runtime.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(runtime);
}

export function report(runtime, action, value) {
  try {
    atomicJSON(path.join(runtime.stateDir, `${serverKey(runtime)}-${action}.json`), {
      time: new Date(runtime.now()).toISOString(), action, ...value,
    });
  } catch (error) {
    console.error(`Claude restore: could not write ${action} report: ${error.message}`);
  }
}

/**
 * @param {Runtime} runtime
 * @param {import('./claude.mjs').Pane[]} panes
 */
export function capture(runtime, panes, table = runtime.processes()) {
  const { sessions, warnings } = readNativeSessions(runtime.claudeDir, table);
  const selection = selectSessions(panes, table, sessions);
  const unavailable = [];
  const entries = selection.entries.map(entry => {
    let transcript = null;
    try {
      transcript = transcriptFor(runtime.claudeDir, entry.id, entry.cwd);
      if (!directoryExists(entry.cwd) || !transcript) {
        unavailable.push({ target: paneKey(entry), id: entry.id, reason: 'Missing directory or transcript' });
      }
    } catch (error) {
      unavailable.push({ target: paneKey(entry), id: entry.id, reason: error.message });
    }
    return { ...entry, transcript: transcript || projectTranscriptPath(runtime.claudeDir, entry.id, entry.cwd) };
  });
  return { entries, unavailable, skipped: selection.skipped, warnings, liveNativeSessions: sessions.length };
}

export function save(runtime, file) {
  const layout = readLayout(runtime.resurrectDir, file);
  const addresses = new Set(snapshotPanes(layout.text).map(paneKey));
  const result = capture(runtime, runtime.panes().filter(pane => addresses.has(paneKey(pane))));
  writeSnapshot(layout, result.entries);
  report(runtime, 'save', { snapshot: layout.file, captured: result.entries.length,
    ready: result.entries.length - result.unavailable.length,
    unavailable: result.unavailable, skipped: result.skipped, warnings: result.warnings });
}

function clearOverwriteGuard(runtime) {
  if (runtime.option('@resurrect-never-overwrite') === 'claude-resurrect') {
    runtime.tmux('set-option', '-gu', '@resurrect-never-overwrite');
  }
}

export function beforeRestore(runtime) {
  runtime.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(runtime);
  const panes = runtime.panes(), table = runtime.processes();
  // Protect the sole busy pane before parsing potentially damaged metadata.
  if (panes.length === 1 && !idle(panes[0], table) && !runtime.option('@resurrect-never-overwrite')) {
    runtime.tmux('set-option', '-g', '@resurrect-never-overwrite', 'claude-resurrect');
  }
  const saved = readSnapshot(runtime.resurrectDir);
  runtime.tmux('set-option', '-g', PREFIX + 'pending', JSON.stringify({
    file: saved.file, digest: saved.digest, server: runtime.server, time: runtime.now(),
    panes: panes.map(pane => ({ paneId: pane.paneId, pid: pane.pid,
      start: table.get(pane.pid)?.start, idle: idle(pane, table) })),
  }));
}

/**
 * Decide from observations only. Busy new shells may be checked again after a short wait.
 * @param {import('./claude.mjs').Pane | undefined} pane
 * @param {PreviousPane | undefined} original
 * @param {Map<number, import('./claude.mjs').Process>} table
 */
export function paneSkipReason(pane, original, table) {
  if (!pane) return { code: 'PANE_MISSING', reason: 'Pane was not restored' };
  if (original && (!original.idle || original.pid === pane.pid && original.start === table.get(pane.pid)?.start)) {
    return { code: 'PANE_EXISTED', reason: 'Pane already existed' };
  }
  if (!idle(pane, table)) return { code: 'PANE_BUSY', reason: 'Pane is busy' };
  return null;
}

export function executable(runtime) {
  const command = runtime.expand(runtime.option(PREFIX + 'command', 'claude'));
  const candidates = command.includes('/') ? [command]
    : (process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, command));
  const found = candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  });
  if (!found) throw new Error('Claude executable not found');
  return path.resolve(found);
}

export function acquireLock(runtime) {
  fs.mkdirSync(runtime.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(runtime.stateDir, 'restore.lock');
  const owner = { pid: process.pid, start: runtime.processes().get(process.pid)?.start, token: randomUUID() };
  if (!owner.start) throw new Error('Cannot verify restore process identity');
  let descriptor;
  try { descriptor = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Restore lock exists; use doctor, then unlock if its owner has exited');
  }
  try { fs.writeFileSync(descriptor, JSON.stringify(owner)); }
  finally { fs.closeSync(descriptor); }
  const owned = () => {
    const result = readJSON(file);
    return result.status === 'ok' && result.value?.token === owner.token;
  };
  return {
    assertOwned() { if (!owned()) throw new Error('Restore lock ownership changed'); },
    release() { if (owned()) fs.unlinkSync(file); },
  };
}

export function unlock(runtime) {
  const file = path.join(runtime.stateDir, 'restore.lock');
  const result = readJSON(file);
  if (result.status === 'missing') return;
  if (result.status === 'unreadable') throw new Error(`Cannot inspect restore lock: ${result.error}`);
  const owner = result.status === 'ok' ? result.value : null;
  if (owner?.start && runtime.processes().get(owner.pid)?.start === owner.start) {
    throw new Error('Restore lock owner is still running');
  }
  if (runtime.now() - fs.statSync(file).mtimeMs < LOCK_RECOVERY_AGE_MS) {
    throw new Error('Restore lock is too recent; wait at least 30 seconds');
  }
  fs.unlinkSync(file);
}

/** @returns {Record<string, LaunchClaim>} */
export function activeClaims(claims, table, now) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Invalid launch claims');
  const active = {};
  for (const [id, claim] of Object.entries(claims)) {
    if (!isUUID(id) || !claim || !Number.isFinite(claim.time) || !Number.isInteger(claim.pid) || claim.pid <= 1
      || !isText(claim.start) || !isText(claim.server) || typeof claim.paneId !== 'string' || !/^%\d+$/.test(claim.paneId)) {
      throw new Error('Invalid launch claim; refusing to discard duplicate-launch protection');
    }
    if (now - claim.time <= CLAIM_TTL_MS && table.get(claim.pid)?.start === claim.start) {
      active[id] = claim;
    }
  }
  return active;
}

function readClaims(runtime) {
  const result = readJSON(path.join(runtime.stateDir, 'launches.json'));
  if (result.status === 'missing') return {};
  if (result.status !== 'ok') throw new Error(`Cannot read launch claims (${result.status}): ${result.error}`);
  return activeClaims(result.value, runtime.processes(), runtime.now());
}

function validatePending(pending, saved, runtime) {
  const validPanes = Array.isArray(pending.panes) && pending.panes.every(pane => pane
    && typeof pane.paneId === 'string' && /^%\d+$/.test(pane.paneId)
    && Number.isInteger(pane.pid) && pane.pid > 1 && typeof pane.idle === 'boolean'
    && (!pane.idle || isText(pane.start)));
  const age = runtime.now() - pending.time;
  const validTime = Number.isFinite(pending.time) && age >= 0 && age <= PENDING_TTL_MS;
  const sameSnapshot = saved.file === pending.file && saved.digest === pending.digest;
  if (!validPanes || !validTime || !sameSnapshot || pending.server !== runtime.server) {
    throw new Error('Snapshot changed during restore');
  }
}

export async function afterRestore(runtime) {
  const rawPending = runtime.option(PREFIX + 'pending', 'null');
  runtime.tmux('set-option', '-gu', PREFIX + 'pending');
  clearOverwriteGuard(runtime);
  const pending = JSON.parse(rawPending);
  if (!pending) return;
  const saved = readSnapshot(runtime.resurrectDir);
  validatePending(pending, saved, runtime);
  const lock = acquireLock(runtime);
  const result = { snapshot: saved.file, launched: [], skipped: [], failed: [] };
  try {
    const command = executable(runtime);
    const shell = runtime.option('default-shell', '/bin/sh');
    const claims = readClaims(runtime);
    const deadline = runtime.now() + SHELL_SETTLE_MS;
    for (const entry of saved.manifest.entries) {
      const target = { target: paneKey(entry), id: entry.id };
      let pane = runtime.panes().find(pane => paneKey(pane) === paneKey(entry));
      const original = pending.panes.find(previous => previous.paneId === pane?.paneId);
      let reason = paneSkipReason(pane, original, runtime.processes());
      if (reason && reason.code !== 'PANE_BUSY') { result.skipped.push({ ...target, ...reason }); continue; }
      try {
        if (!directoryExists(entry.cwd) || !transcriptValid(runtime.claudeDir, entry.transcript, entry.id)
          && !transcriptFor(runtime.claudeDir, entry.id, entry.cwd)) {
          result.skipped.push({ ...target, code: 'FILES_MISSING', reason: 'Missing directory or transcript' });
          continue;
        }
      } catch (error) {
        result.failed.push({ ...target, code: 'FILES_UNREADABLE', reason: error.message });
        continue;
      }
      while (reason?.code === 'PANE_BUSY' && runtime.now() < deadline) {
        await runtime.sleep(SHELL_POLL_MS);
        pane = runtime.panes().find(pane => paneKey(pane) === paneKey(entry));
        reason = paneSkipReason(pane, original, runtime.processes());
      }
      if (reason) { result.skipped.push({ ...target, ...reason }); continue; }
      // Registry and shared-state failures abort the whole pass; pane failures do not.
      const registry = readNativeSessions(runtime.claudeDir, runtime.processes());
      if (claims[entry.id] || registry.sessions.some(session => session.sessionId === entry.id)) {
        result.skipped.push({ ...target, code: 'SESSION_ACTIVE', reason: 'Session is already running or starting' });
        continue;
      }
      lock.assertOwned();
      const fresh = runtime.panes().find(candidate => candidate.paneId === pane.paneId);
      if (!fresh || fresh.pid !== pane.pid || paneSkipReason(fresh, original, runtime.processes())) {
        result.skipped.push({ ...target, code: 'PANE_CHANGED', reason: 'Pane changed' });
        continue;
      }
      const wrapper = `trap ':' INT; ${quote(command)} --resume ${quote(entry.id)}; exec ${quote(shell)} -l`;
      try {
        runtime.tmux('respawn-pane', '-k', '-t', pane.paneId, '-c', entry.cwd,
          '-e', `CLAUDE_CONFIG_DIR=${runtime.claudeDir}`, '/bin/sh', '-c', wrapper);
      } catch (error) {
        runtime.tmux('display-message', '-p', '#{pid}');
        result.failed.push({ ...target, code: 'LAUNCH_FAILED', reason: error.message });
        continue;
      }
      result.launched.push(target);
      const startedPane = runtime.panes().find(candidate => candidate.paneId === pane.paneId);
      const start = runtime.processes().get(startedPane?.pid)?.start;
      if (!start) throw new Error('Cannot verify launched pane identity');
      claims[entry.id] = { time: runtime.now(), server: runtime.server, paneId: pane.paneId, pid: startedPane.pid, start };
      atomicJSON(path.join(runtime.stateDir, 'launches.json'), claims);
      try { runtime.tmux('set-option', '-p', '-t', pane.paneId, PREFIX + 'session', entry.id); }
      catch (error) { result.failed.push({ ...target, code: 'PANE_ANNOTATION_FAILED', reason: error.message }); }
    }
    if (result.launched.length || result.skipped.length || result.failed.length) {
      runtime.tmux('display-message', `Claude: ${result.launched.length} launched, ${result.skipped.length} skipped, ${result.failed.length} failed`);
    }
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
    report(runtime, 'restore', result);
    lock.release();
  }
}

export function status(runtime) {
  const result = { snapshot: null, entries: [], reports: [], warnings: [] };
  try {
    const prefix = serverKey(runtime) + '-';
    for (const name of listDirectory(runtime.stateDir).filter(name => name.startsWith(prefix)
      && /-(save|restore|error|previous-hook-error)\.json$/.test(name)).sort()) {
      const record = readJSON(path.join(runtime.stateDir, name));
      if (record.status === 'ok' && record.value && typeof record.value.action === 'string') result.reports.push(record.value);
      else if (record.status === 'ok') result.warnings.push(`${name}: invalid report schema`);
      else if (record.status !== 'missing') result.warnings.push(`${name} (${record.status}): ${record.error}`);
    }
  } catch (error) { result.warnings.push(`Cannot read reports: ${error.message}`); }
  try {
    const saved = readSnapshot(runtime.resurrectDir);
    result.snapshot = saved.file;
    result.entries = saved.manifest.entries;
  } catch (error) { result.snapshotError = error.message; }
  return result;
}

export function doctor(runtime) {
  const warnings = [];
  let command, captured = null;
  try { command = executable(runtime); } catch (error) { warnings.push(error.message); }
  try {
    captured = capture(runtime, runtime.panes());
    warnings.push(...captured.warnings.map(warning => `${warning.reason}: ${warning.file}`));
  } catch (error) { warnings.push(`Session detection failed: ${error.message}`); }
  const installed = HOOKS.every(hook => runtime.option('@resurrect-hook-' + hook)
    && runtime.option('@resurrect-hook-' + hook) === runtime.option(PREFIX + 'installed-' + hook));
  if (!installed) warnings.push('Plugin is not installed on this tmux server');
  if (/\s/.test(runtime.resurrectDir)) warnings.push('Upstream tmux-resurrect does not reliably support whitespace in its snapshot directory');
  const lock = readJSON(path.join(runtime.stateDir, 'restore.lock'));
  if (lock.status !== 'missing') warnings.push(`Restore lock exists (${lock.status}); inspect before using unlock`);
  try { readClaims(runtime); } catch (error) { warnings.push(error.message); }
  return { node: process.versions.node, tmux: runtime.tmux('-V'), command,
    claudeDir: runtime.claudeDir, stateDir: runtime.stateDir, resurrectDir: runtime.resurrectDir, installed,
    liveNativeSessions: captured?.liveNativeSessions ?? null, captured: captured?.entries.length ?? null,
    unavailable: captured?.unavailable ?? [], skipped: captured?.skipped ?? [],
    lock: lock.status === 'ok' ? lock.value : null, warnings };
}

export async function runHook(runtime, hook, args) {
  if (!HOOKS.includes(hook)) throw new Error('Unknown Resurrect hook');
  const previous = runtime.option(PREFIX + 'previous-' + hook);
  if (previous) {
    try {
      execFileSync('/bin/bash', ['-c', previous + (args.length ? ' ' + args.map(quote).join(' ') : '')],
        { stdio: 'ignore', timeout: PREVIOUS_HOOK_TIMEOUT_MS });
    } catch (error) { report(runtime, 'previous-hook-error', { hook, error: error.message }); }
  }
  try {
    if (hook === 'post-save-layout') save(runtime, args[0]);
    else if (hook === 'pre-restore-all') beforeRestore(runtime);
    else await afterRestore(runtime);
  } catch (error) {
    report(runtime, 'error', { hook, error: error.message });
    try { runtime.tmux('display-message', 'Claude restore: skipped; run bin/claude-resurrect status for details'); }
    catch { console.error(`Claude restore: ${error.message}`); }
  }
}
