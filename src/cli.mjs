#!/usr/bin/env node
import fs from 'node:fs';
import { context, install, uninstall, doctor, status, runHook } from './resurrect.mjs';
import { unlock } from './coordination.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const help = `tmux-claude-resurrect ${version}

Usage: bin/claude-resurrect <command>
  install       Connect to tmux-resurrect (normally called by TPM)
  uninstall     Restore previous tmux-resurrect hooks
  doctor        Inspect dependencies and native session detection (JSON)
  status        Inspect the saved snapshot and recent reports (JSON)
  unlock        Remove a stale restore lock after its owner has exited
  help          Show this help

Run inside tmux. No Claude hooks, background watcher, or npm install needed.`;

async function main() {
  const [action = 'help', hook, ...args] = process.argv.slice(2);
  if (action === 'help' || action === '--help' || action === '-h') return console.log(help);
  if (action === '--version') return console.log(version);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  if (!['install', 'uninstall', 'unlock', 'doctor', 'status', 'hook'].includes(action)) throw new Error(help);
  const runtime = context();
  if (action === 'install') return install(runtime);
  if (action === 'uninstall') return uninstall(runtime);
  if (action === 'unlock') return unlock(runtime);
  if (action === 'doctor') return console.log(JSON.stringify(doctor(runtime), null, 2));
  if (action === 'status') return console.log(JSON.stringify(status(runtime), null, 2));
  await runHook(runtime, hook, args);
}

main().catch(error => { console.error(`Claude restore: ${error.message}`); process.exitCode = 1; });
