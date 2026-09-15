import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJSON, directoryExists, isText, listDirectory, readJSON } from './files.mjs';
import { processes, readNativeSessions, selectSessions, paneKey, idle,
  transcriptFor, transcriptValid, projectTranscriptPath } from './claude.mjs';
import { readLayout, snapshotPanes, readSnapshot, writeSnapshot } from './snapshot.mjs';
import { acquireLock, readClaims, recordLaunch } from './coordination.mjs';
import { readProcessArguments, claudeArguments, restoreArguments } from './arguments.mjs';

const RUNNER = fileURLToPath(new URL('../bin/claude-resurrect', import.meta.url));
const PREFIX = '@claude-resurrect-';
const HOOKS = ['post-save-layout', 'pre-restore-all', 'post-restore-all'];
const TMUX_QUERY_TIMEOUT_MS = 10000;
const PREVIOUS_HOOK_TIMEOUT_MS = 30000;
const PENDING_TTL_MS = 120000;
const SHELL_SETTLE_MS = 4000;
const SHELL_POLL_MS = 100;
export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const serverKey = runtime => createHash('sha256').update(runtime.server).digest('hex').slice(0, 12);
/** @typedef {ReturnType<typeof context>} Runtime */
/** @typedef {{ paneId: string, pid: number, start: string, idle: boolean }} PreviousPane */

export function context() {
  // Startup run-shell commands have session ID -1 before the first session exists.
  const match = process.env.TMUX?.match(/^(.*),\d+,(?:-1|\d+)$/);
  if (!match) throw new Error('Run inside tmux or from a tmux hook');
  const tmux = (...args) => execFileSync('tmux', ['-S', match[1], ...args.map(String)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: TMUX_QUERY_TIMEOUT_MS,
  }).trimEnd();
  const option = (name, fallback = '') => tmux('show-option', '-gqv', name) || fallback;
  const expand = value => value.replace(/^~(?=\/|$)/, os.homedir())
    .replaceAll('$HOME', os.homedir()).replaceAll('$HOSTNAME', os.hostname());
  const claudeConfigDir = expand(option(PREFIX + 'claude-dir', process.env.CLAUDE_CONFIG_DIR || ''));
  const claudeDir = claudeConfigDir || path.join(os.homedir(), '.claude');
  const legacy = path.join(os.homedir(), '.tmux/resurrect');
  const resurrectDir = expand(option('@resurrect-dir', fs.existsSync(legacy) ? legacy
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'tmux/resurrect')));
  const stateDir = expand(option(PREFIX + 'state-dir',
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'tmux/claude-resurrect')));
  const server = tmux('display-message', '-p', '#{pid}:#{start_time}');
  const panes = () => tmux('list-panes', '-a', '-F', [
    '#{session_name}', '#{window_index}', '#{pane_index}', '#{pane_id}', '#{pane_pid}',
    '#{pane_current_command}', '#{pane_current_path}', '#{pane_in_mode}',
  ].join('\t')).split('\n').filter(Boolean).map(line => {
    const [session, window, pane, paneId, pid, command, cwd, inMode] = line.split('\t');
    return { session, window, pane, paneId, pid: Number(pid), command, cwd, inMode };
  });
  return { tmux, option, expand, claudeDir, claudeConfigDir, resurrectDir, stateDir, server, panes, platform: process.platform,
    processes, readArguments: readProcessArguments,
    now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
}

export function install(runtime) {
  for (const hook of HOOKS) {
    const name = '@resurrect-hook-' + hook;
    const current = runtime.option(name);
    const installed = runtime.option(PREFIX + 'installed-' + hook);
    const command = `${quote(RUNNER)} hook ${quote(hook)}`;
    if (current !== installed && current !== command) {
      runtime.tmux('set-option', '-g', PREFIX + 'previous-' + hook, current);
    }
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
  const { sessions, warnings } = readNativeSessions(runtime.claudeDir, table, { platform: runtime.platform });
  const selection = selectSessions(panes, table, sessions);
  const unavailable = [];
  let argumentsByPid = new Map(), argumentsError;
  try {
    argumentsByPid = runtime.readArguments(selection.entries.map(entry => entry.pid));
  } catch (error) {
    argumentsError = error.message;
  }
  // A process may exit or switch conversations while its arguments are being read.
  const current = selection.entries.length
    ? readNativeSessions(runtime.claudeDir, runtime.processes(), { platform: runtime.platform }).sessions : [];
  const entries = selection.entries.map(entry => {
    const { pid, procStart, ...saved } = entry;
    let args, argsError;
    try {
      if (argumentsError) throw new Error(argumentsError);
      const observed = argumentsByPid.get(pid);
      if (!observed?.args) throw new Error(observed?.error || 'Native process arguments are unavailable');
      if (!current.some(record => record.pid === pid && record.procStart === procStart && record.sessionId === entry.id)) {
        throw new Error('Claude process identity changed while reading arguments');
      }
      args = restoreArguments(claudeArguments(observed.args));
    } catch (error) {
      argsError = error.message;
    }
    let transcript = null;
    let fileError;
    try {
      transcript = transcriptFor(runtime.claudeDir, entry.id, entry.cwd);
      if (!directoryExists(entry.cwd) || !transcript) {
        fileError = 'Missing directory or transcript';
      }
    } catch (error) {
      fileError = error.message;
    }
    if (argsError || fileError) unavailable.push({ target: paneKey(entry), id: entry.id,
      reason: [argsError, fileError].filter(Boolean).join('; ') });
    return { ...saved, ...(argsError ? { argsError } : { args }),
      transcript: transcript || projectTranscriptPath(runtime.claudeDir, entry.id, entry.cwd) };
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
  const panes = runtime.panes();
  const table = runtime.processes();
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
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new Error('Claude executable not found');
  return path.resolve(found);
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

async function preparePane(runtime, entry, pending, deadline) {
  if (entry.argsError) return { skipped: { code: 'ARGUMENTS_UNAVAILABLE', reason: entry.argsError } };
  let pane = runtime.panes().find(pane => paneKey(pane) === paneKey(entry));
  const original = pending.panes.find(previous => previous.paneId === pane?.paneId);
  let reason = paneSkipReason(pane, original, runtime.processes());
  if (reason && reason.code !== 'PANE_BUSY') return { skipped: reason };

  try {
    const available = directoryExists(entry.cwd)
      && (transcriptValid(runtime.claudeDir, entry.transcript, entry.id)
        || transcriptFor(runtime.claudeDir, entry.id, entry.cwd));
    if (!available) {
      return { skipped: { code: 'FILES_MISSING', reason: 'Missing directory or transcript' } };
    }
  } catch (error) {
    return { failed: { code: 'FILES_UNREADABLE', reason: error.message } };
  }

  while (reason?.code === 'PANE_BUSY' && runtime.now() < deadline) {
    await runtime.sleep(SHELL_POLL_MS);
    pane = runtime.panes().find(pane => paneKey(pane) === paneKey(entry));
    reason = paneSkipReason(pane, original, runtime.processes());
  }
  return reason ? { skipped: reason } : { pane, original };
}

function launchPane(runtime, entry, pane, { command, shell, claims }, result) {
  const target = { target: paneKey(entry), id: entry.id };
  // Setting CLAUDE_CONFIG_DIR even to ~/.claude moves Claude's default ~/.claude.json.
  const profile = runtime.claudeConfigDir ? ['-e', `CLAUDE_CONFIG_DIR=${runtime.claudeConfigDir}`] : [];
  const resetProfile = runtime.claudeConfigDir ? '' : 'unset CLAUDE_CONFIG_DIR; ';
  // Keep the wrapper alive on Ctrl-C so it can open a login shell after Claude exits.
  const wrapper = `${resetProfile}trap ':' INT; "$@"; exec ${quote(shell)} -l`;
  try {
    runtime.tmux('respawn-pane', '-k', '-t', pane.paneId, '-c', entry.cwd,
      ...profile, '/bin/sh', '-c', wrapper,
      'claude-resurrect', command, '--resume', entry.id, ...(entry.args || []));
  } catch (error) {
    // Continue after a pane failure only if the tmux server is still reachable.
    runtime.tmux('display-message', '-p', '#{pid}');
    result.failed.push({ ...target, code: 'LAUNCH_FAILED', reason: error.message });
    return;
  }

  result.launched.push(target);
  const startedPane = runtime.panes().find(candidate => candidate.paneId === pane.paneId);
  recordLaunch(runtime, claims, entry.id, startedPane);
  try {
    runtime.tmux('set-option', '-p', '-t', pane.paneId, PREFIX + 'session', entry.id);
  } catch (error) {
    result.failed.push({ ...target, code: 'PANE_ANNOTATION_FAILED', reason: error.message });
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
    const launch = {
      command: executable(runtime), shell: runtime.option('default-shell', '/bin/sh'), claims: readClaims(runtime),
    };
    const deadline = runtime.now() + SHELL_SETTLE_MS;
    for (const entry of saved.manifest.entries) {
      const target = { target: paneKey(entry), id: entry.id };
      const prepared = await preparePane(runtime, entry, pending, deadline);
      if (prepared.skipped) {
        result.skipped.push({ ...target, ...prepared.skipped });
        continue;
      }
      if (prepared.failed) {
        result.failed.push({ ...target, ...prepared.failed });
        continue;
      }

      // Registry and shared-state failures abort the whole pass; pane failures do not.
      const registry = readNativeSessions(runtime.claudeDir, runtime.processes(), { platform: runtime.platform });
      if (launch.claims[entry.id] || registry.sessions.some(session => session.sessionId === entry.id)) {
        result.skipped.push({ ...target, code: 'SESSION_ACTIVE', reason: 'Session is already running or starting' });
        continue;
      }
      lock.assertOwned();
      const { pane, original } = prepared;
      const fresh = runtime.panes().find(candidate => candidate.paneId === pane.paneId);
      if (!fresh || fresh.pid !== pane.pid || paneSkipReason(fresh, original, runtime.processes())) {
        result.skipped.push({ ...target, code: 'PANE_CHANGED', reason: 'Pane changed' });
        continue;
      }
      launchPane(runtime, entry, pane, launch, result);
    }
    if (result.launched.length || result.skipped.length || result.failed.length) {
      runtime.tmux('display-message',
        `Claude: ${result.launched.length} launched, ${result.skipped.length} skipped, ${result.failed.length} failed`);
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
      if (record.status === 'ok' && record.value && typeof record.value.action === 'string') {
        result.reports.push(record.value);
      } else if (record.status === 'ok') {
        result.warnings.push(`${name}: invalid report schema`);
      } else if (record.status !== 'missing') {
        result.warnings.push(`${name} (${record.status}): ${record.error}`);
      }
    }
  } catch (error) {
    result.warnings.push(`Cannot read reports: ${error.message}`);
  }
  try {
    const saved = readSnapshot(runtime.resurrectDir);
    result.snapshot = saved.file;
    result.entries = saved.manifest.entries;
  } catch (error) {
    result.snapshotError = error.message;
  }
  return result;
}

export function doctor(runtime) {
  const warnings = [];
  let command;
  let captured = null;
  try {
    command = executable(runtime);
  } catch (error) {
    warnings.push(error.message);
  }
  try {
    captured = capture(runtime, runtime.panes());
    warnings.push(...captured.warnings.map(warning => `${warning.reason}: ${warning.file}`));
  } catch (error) {
    warnings.push(`Session detection failed: ${error.message}`);
  }
  const installed = HOOKS.every(hook => runtime.option('@resurrect-hook-' + hook)
    && runtime.option('@resurrect-hook-' + hook) === runtime.option(PREFIX + 'installed-' + hook));
  if (!installed) warnings.push('Plugin is not installed on this tmux server');
  if (/\s/.test(runtime.resurrectDir)) {
    warnings.push('Upstream tmux-resurrect does not reliably support whitespace in its snapshot directory');
  }
  const lock = readJSON(path.join(runtime.stateDir, 'restore.lock'));
  if (lock.status !== 'missing') warnings.push(`Restore lock exists (${lock.status}); inspect before using unlock`);
  try {
    readClaims(runtime);
  } catch (error) {
    warnings.push(error.message);
  }
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
    } catch (error) {
      report(runtime, 'previous-hook-error', { hook, error: error.message });
    }
  }
  try {
    if (hook === 'post-save-layout') save(runtime, args[0]);
    else if (hook === 'pre-restore-all') beforeRestore(runtime);
    else await afterRestore(runtime);
  } catch (error) {
    report(runtime, 'error', { hook, error: error.message });
    try {
      runtime.tmux('display-message', 'Claude restore: skipped; run bin/claude-resurrect status for details');
    } catch {
      console.error(`Claude restore: ${error.message}`);
    }
  }
}
