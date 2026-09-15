import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, isText, isUUID, readJSON } from './files.mjs';

const CLAIM_TTL_MS = 60000;
const LOCK_RECOVERY_AGE_MS = 30000;
/** @typedef {{ pid: number, start: string, time: number, server: string, paneId: string }} LaunchClaim */

export function acquireLock(runtime) {
  fs.mkdirSync(runtime.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(runtime.stateDir, 'restore.lock');
  const owner = { pid: process.pid, start: runtime.processes().get(process.pid)?.start, token: randomUUID() };
  if (!owner.start) throw new Error('Cannot verify restore process identity');
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Restore lock exists; use doctor, then unlock if its owner has exited');
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify(owner));
  } finally {
    fs.closeSync(descriptor);
  }
  const owned = () => {
    const result = readJSON(file);
    return result.status === 'ok' && result.value?.token === owner.token;
  };
  return {
    assertOwned() {
      if (!owned()) throw new Error('Restore lock ownership changed');
    },
    release() {
      if (owned()) fs.unlinkSync(file);
    },
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

export function readClaims(runtime) {
  const result = readJSON(path.join(runtime.stateDir, 'launches.json'));
  if (result.status === 'missing') return {};
  if (result.status !== 'ok') throw new Error(`Cannot read launch claims (${result.status}): ${result.error}`);
  return activeClaims(result.value, runtime.processes(), runtime.now());
}

export function recordLaunch(runtime, claims, id, pane) {
  const start = runtime.processes().get(pane?.pid)?.start;
  if (!start) throw new Error('Cannot verify launched pane identity');
  claims[id] = {
    time: runtime.now(), server: runtime.server, paneId: pane.paneId, pid: pane.pid, start,
  };
  atomicJSON(path.join(runtime.stateDir, 'launches.json'), claims);
}
