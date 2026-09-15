import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isText, isUUID, readJSON, listDirectory, directoryExists } from './files.mjs';

/** @typedef {{ session: string, window: string, pane: string }} PaneAddress */
/** @typedef {PaneAddress & { paneId: string, pid: number, command: string, inMode: string }} Pane */
/** @typedef {{ pid: number, ppid: number, tty: string, start: string, command: string }} Process */
/** @typedef {{ pid: number, procStart: string, sessionId: string, cwd: unknown, kind: unknown, entrypoint: unknown }} NativeSession */
/** @typedef {PaneAddress & { id: string, cwd: string }} CapturedSession */

const PROCESS_QUERY_TIMEOUT_MS = 10000;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const normalizeStart = value => String(value ?? '').trim().replace(/\s+/g, ' ');
export const paneKey = address => JSON.stringify([address.session, address.window, address.pane]);

/** @returns {Map<number, Process>} */
export function parseProcesses(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if (!match) continue;
    table.set(Number(match[1]), {
      pid: Number(match[1]), ppid: Number(match[2]), tty: match[3],
      start: normalizeStart(match[4]), command: path.basename(match[5].trim()),
    });
  }
  return table;
}

export function processes() {
  return parseProcesses(execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,comm='], {
    encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    maxBuffer: 16 * 1024 * 1024, timeout: PROCESS_QUERY_TIMEOUT_MS,
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
export function readNativeSessions(root, table) {
  const directory = path.join(root, 'sessions');
  const sessions = [], warnings = [];
  if (!directoryExists(directory)) {
    warnings.push({ code: 'REGISTRY_MISSING', reason: 'Native session registry is missing', file: directory });
    return { sessions, warnings };
  }
  for (const name of listDirectory(directory).filter(name => /^\d+\.json$/.test(name))) {
    const file = path.join(directory, name);
    const result = readJSON(file);
    if (result.status === 'missing') continue;
    if (result.status === 'unreadable') throw new Error(`Cannot read native session record: ${file}: ${result.error}`);
    if (result.status === 'invalid') {
      warnings.push({ code: 'INVALID_RECORD', file, reason: result.error });
      continue;
    }
    const record = result.value;
    const processInfo = table.get(record?.pid);
    if (!record || record.pid !== Number(name.slice(0, -5)) || !isUUID(record.sessionId) || !isText(record.procStart)) {
      warnings.push({ code: 'INVALID_RECORD', file, reason: 'Unsupported native session identity' });
      continue;
    }
    if (!processInfo || normalizeStart(record.procStart) !== processInfo.start) continue;
    sessions.push({ pid: record.pid, procStart: processInfo.start, sessionId: record.sessionId.toLowerCase(),
      cwd: record.cwd, kind: record.kind, entrypoint: record.entrypoint });
  }
  return { sessions, warnings };
}

/**
 * Select identities using observed data only; no filesystem or tmux access.
 * @param {Pane[]} panes
 * @param {Map<number, Process>} table
 * @param {NativeSession[]} registry
 */
export function selectSessions(panes, table, registry) {
  const entries = [], skipped = [];
  for (const pane of panes) {
    const candidates = registry.filter(record => record.kind === 'interactive' && record.entrypoint === 'cli')
      .map(record => ({ record, depth: distance(record.pid, pane.pid, table) }))
      .filter(candidate => Number.isFinite(candidate.depth));
    const nearest = Math.min(...candidates.map(candidate => candidate.depth));
    const sessions = candidates.filter(candidate => candidate.depth === nearest).map(candidate => candidate.record);
    const skip = (code, reason) => skipped.push({ target: paneKey(pane), code, reason });
    if (!sessions.length) {
      // Native Claude binaries can use version filenames; this only flags missing metadata.
      if ([...table.values()].some(process => /^(claude|\d+\.\d+\.\d+)$/.test(process.command)
        && Number.isFinite(distance(process.pid, pane.pid, table)))) {
        skip('NO_NATIVE_SESSION', 'No compatible live native session record');
      }
      continue;
    }
    if (sessions.length !== 1) {
      skip('AMBIGUOUS_SESSION', 'Ambiguous sessions');
      continue;
    }
    const { sessionId: id, cwd } = sessions[0];
    if (!isText(cwd) || !path.isAbsolute(cwd)) {
      skip('INVALID_CWD', 'Invalid working directory');
      continue;
    }
    entries.push({ session: pane.session, window: pane.window, pane: pane.pane, id, cwd });
  }
  const counts = new Map();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  const unique = entries.filter(entry => {
    if (counts.get(entry.id) === 1) return true;
    skipped.push({ target: paneKey(entry), code: 'DUPLICATE_SESSION', reason: 'Session active in multiple panes' });
    return false;
  }).sort((left, right) => paneKey(left).localeCompare(paneKey(right)));
  return { entries: unique, skipped };
}

export function idle(pane, table) {
  return Boolean(pane && SHELLS.has(pane.command) && pane.inMode === '0'
    && table.has(pane.pid) && ![...table.values()].some(process => process.pid !== pane.pid
      && Number.isFinite(distance(process.pid, pane.pid, table))));
}

export function projectTranscriptPath(root, id, cwd) {
  return path.join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}

export function transcriptValid(root, file, id) {
  try {
    const projects = fs.realpathSync(path.join(root, 'projects')) + path.sep;
    const stat = fs.statSync(file);
    return fs.realpathSync(file).startsWith(projects) && path.basename(file) === `${id}.jsonl`
      && stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export function transcriptFor(root, id, cwd) {
  const expected = projectTranscriptPath(root, id, cwd);
  if (transcriptValid(root, expected, id)) return expected;
  const matches = [...new Set(listDirectory(path.join(root, 'projects'))
    .map(directory => path.join(root, 'projects', directory, `${id}.jsonl`))
    .filter(file => transcriptValid(root, file, id)).map(file => fs.realpathSync(file)))];
  return matches.length === 1 ? matches[0] : null;
}
