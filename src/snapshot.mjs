import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isText, isUUID, readFile, atomicWrite } from './files.mjs';
import { paneKey } from './claude.mjs';

/** @typedef {import('./claude.mjs').CapturedSession & { transcript: string }} SavedSession */
/** @typedef {{ version: 1, entries: SavedSession[] }} Manifest */
const ROW = 'claude-resurrect\t';
const MAX_ENTRIES = 10000;
const PANE_FIELDS = { session: 1, window: 2, pane: 5, command: 10 };
const hash = text => createHash('sha256').update(text).digest('hex');

function paneAddress(fields) {
  return { session: fields[PANE_FIELDS.session], window: fields[PANE_FIELDS.window], pane: fields[PANE_FIELDS.pane] };
}

export function snapshotPanes(text) {
  return text.split('\n').filter(line => line.startsWith('pane\t')).map(line => paneAddress(line.split('\t')));
}

export function decodeManifest(text) {
  const rows = text.split('\n').filter(line => line.startsWith(ROW));
  if (rows.length !== 1) throw new Error('Snapshot has no unique Claude metadata');
  const manifest = JSON.parse(rows[0].slice(ROW.length));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) {
    throw new Error('Unsupported Claude metadata');
  }
  const positions = new Set(), ids = new Set();
  for (const entry of manifest.entries) {
    if (!entry || !isText(entry.session) || typeof entry.window !== 'string' || !/^\d{1,10}$/.test(entry.window)
      || typeof entry.pane !== 'string' || !/^\d{1,10}$/.test(entry.pane) || !isUUID(entry.id)
      || !isText(entry.cwd) || !path.isAbsolute(entry.cwd)
      || !isText(entry.transcript) || !path.isAbsolute(entry.transcript)
      || positions.has(paneKey(entry)) || ids.has(entry.id.toLowerCase())) {
      throw new Error('Invalid or ambiguous Claude metadata');
    }
    entry.id = entry.id.toLowerCase();
    positions.add(paneKey(entry));
    ids.add(entry.id);
  }
  return manifest;
}

/** @param {SavedSession[]} entries */
export function encodeSnapshot(text, entries) {
  const manifest = { version: 1, entries };
  const metadata = ROW + JSON.stringify(manifest);
  decodeManifest(metadata);
  const captured = new Set(entries.map(paneKey));
  const rows = text.trimEnd().split('\n').filter(line => !line.startsWith(ROW)).map(line => {
    if (!line.startsWith('pane\t')) return line;
    const fields = line.split('\t');
    // Upstream must not also replay the command of a captured Claude pane.
    if (captured.has(paneKey(paneAddress(fields)))) fields[PANE_FIELDS.command] = ':';
    return fields.join('\t');
  });
  return [...rows, metadata].join('\n') + '\n';
}

export function readLayout(directory, file) {
  if (!file) throw new Error('Snapshot path is missing');
  const resolved = fs.realpathSync(file);
  if (path.dirname(resolved) !== fs.realpathSync(directory)) throw new Error('Snapshot is outside the Resurrect directory');
  return { file: resolved, text: readFile(resolved) };
}

export function readSnapshot(directory) {
  const layout = readLayout(directory, path.join(directory, 'last'));
  return { file: layout.file, digest: hash(layout.text), manifest: decodeManifest(layout.text) };
}

export function writeSnapshot(layout, entries) {
  atomicWrite(layout.file, encodeSnapshot(layout.text, entries));
}
