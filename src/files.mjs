import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
export const isText = value => typeof value === 'string' && value.length > 0
  && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value);
export const isUUID = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function readFile(file, limit = MAX_FILE_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) {
    throw Object.assign(new Error('File is not regular or exceeds size limit'), { code: 'INVALID_FILE' });
  }
  return fs.readFileSync(file, 'utf8');
}

/** @returns {{ status: 'ok', value: any } | { status: 'missing' | 'invalid' | 'unreadable', error: string }} */
export function readJSON(file) {
  try {
    return { status: 'ok', value: JSON.parse(readFile(file, MAX_JSON_BYTES)) };
  } catch (error) {
    const status = error.code === 'ENOENT' ? 'missing'
      : error instanceof SyntaxError || error.code === 'INVALID_FILE' ? 'invalid' : 'unreadable';
    return { status, error: error.message };
  }
}

export function listDirectory(dir) {
  try { return fs.readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function directoryExists(dir) {
  try { return fs.statSync(dir).isDirectory(); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
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
