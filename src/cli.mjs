#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PREFIX, HOOKS, quote, context, install, uninstall, snapshot, capture,
  save, beforeRestore, afterRestore, report, processes, liveRegistry, executable, readJSON, unlock } from './resurrect.mjs';

const help = `tmux-claude-resurrect 0.1.0

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
  if (action === '--version') return console.log('0.1.0');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  const c = context();
  if (action === 'install') return install(c);
  if (action === 'uninstall') return uninstall(c);
  if (action === 'unlock') return unlock(c);
  if (action === 'doctor') {
    const warnings = [];
    let command;
    try { command = executable(c); } catch (error) { warnings.push(error.message); }
    const panes = c.panes();
    const probe = panes.map(p => ['pane', p.session, p.window, '', '', p.pane].join('\t')).join('\n');
    const captured = capture(c, probe);
    const installed = HOOKS.every(h => c.option('@resurrect-hook-' + h)
      && c.option('@resurrect-hook-' + h) === c.option(PREFIX + 'installed-' + h));
    if (!installed) warnings.push('Plugin is not installed on this tmux server');
    if (/\s/.test(c.resurrectDir)) warnings.push('Upstream tmux-resurrect does not reliably support whitespace in its snapshot directory');
    if (!fs.existsSync(path.join(c.claudeDir, 'sessions'))) warnings.push('Native session registry is missing; this Claude version or profile may be incompatible');
    if (fs.existsSync(path.join(c.stateDir, 'restore.lock'))) warnings.push('Restore lock exists; inspect its owner before using unlock');
    console.log(JSON.stringify({ node: process.versions.node, tmux: c.tmux('-V'), command,
      claudeDir: c.claudeDir, stateDir: c.stateDir, resurrectDir: c.resurrectDir, installed,
      liveNativeSessions: liveRegistry(c.claudeDir, processes()).length,
      captured: captured.manifest.entries.length, unavailable: captured.unavailable, skipped: captured.skipped,
      lock: readJSON(path.join(c.stateDir, 'restore.lock')), warnings }, null, 2));
    return;
  }
  if (action === 'status') {
    const saved = snapshot(c);
    let reports = [];
    try { reports = fs.readdirSync(c.stateDir).filter(n => /-(save|restore|error|previous-hook-error)\.json$/.test(n))
      .map(n => readJSON(path.join(c.stateDir, n))).filter(Boolean); } catch {}
    console.log(JSON.stringify({ snapshot: saved.file, entries: saved.manifest.entries, reports }, null, 2));
    return;
  }
  if (action !== 'hook' || !HOOKS.includes(hook)) throw new Error(help);
  const previous = c.option(PREFIX + 'previous-' + hook);
  if (previous) {
    try { execFileSync('/bin/bash', ['-c', previous + (args.length ? ' ' + args.map(quote).join(' ') : '')],
      { stdio: 'ignore', timeout: 30000 }); }
    catch { report(c, 'previous-hook-error', { hook, error: 'Previous hook failed or timed out' }); }
  }
  try {
    if (hook === 'post-save-layout') save(c, args[0]);
    else if (hook === 'pre-restore-all') beforeRestore(c);
    else await afterRestore(c);
  } catch (error) {
    report(c, 'error', { hook, error: error.message });
    c.tmux('display-message', 'Claude restore: skipped; run bin/claude-resurrect status for details');
  }
}

main().catch(error => { console.error(`Claude restore: ${error.message}`); process.exitCode = 1; });
