import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processes } from '../src/claude.mjs';
import { quote } from '../src/resurrect.mjs';
export const IDS = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const SCRIPT = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const NODE = fs.realpathSync(process.execPath);
const RESURRECT = fileURLToPath(new URL('../.test-deps/tmux-resurrect/scripts', import.meta.url));
export const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for fixture');
};
export const events = root => { try { return fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };

export function fixture({ install = true } = {}) {
  // Keep tmux socket paths below Unix limits even when the system temp path is long.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/claude-resurrect-test-'));
  const socket = path.join(root, 'tmux.sock');
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, "project ' $(touch INJECTED)");
  const binDir = path.join(root, "bin with ' spaces");
  fs.mkdirSync(cwd); fs.mkdirSync(binDir); fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  for (const id of IDS) fs.writeFileSync(path.join(project, id + '.jsonl'), '{}\n');
  const fake = path.join(binDir, 'claude');
  fs.writeFileSync(fake, `#!${NODE}\nimport fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const id = process.argv[process.argv.indexOf('--resume') + 1];
const start = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim().replace(/\\s+/g, ' ');
const stat = process.platform === 'linux' ? fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8') : null;
const procStart = stat === null ? start : stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
const publish = () => fs.writeFileSync(path.join(root, 'claude/sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, procStart, sessionId: id, cwd: process.cwd(), kind: 'interactive', entrypoint: 'cli' }));
const gate = path.join(root, 'hold-registry');
if (fs.existsSync(gate)) {
  const timer = setInterval(() => {
    if (fs.existsSync(gate)) return;
    publish();
    clearInterval(timer);
  }, 25);
} else publish();
fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ args: process.argv.slice(2), id, cwd: process.cwd(), pane: process.env.TMUX_PANE, pid: process.pid, start }) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  let env;
  const start = (name = 'work') => {
    execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', name, '-x', '200', '-y', '80', '/bin/sh'], { env: { ...process.env, TMUX: '', XDG_CONFIG_HOME: path.join(root, 'config') } });
    env = { ...process.env, TMUX: tmux('display-message', '-p', '#{socket_path},#{pid},0'), TERM: 'xterm-256color' };
    for (const [name, value] of Object.entries({
      'default-shell': '/bin/sh', '@resurrect-dir': path.join(root, 'snapshots'),
      '@resurrect-capture-pane-contents': 'off', '@resurrect-processes': 'false',
      '@claude-resurrect-claude-dir': claudeDir,
      '@claude-resurrect-state-dir': path.join(root, 'state'), '@claude-resurrect-command': fake,
    })) tmux('set-option', '-g', name, value);
    if (install) plugin('install');
  };
  const plugin = (...args) => execFileSync(NODE, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 15000 });
  const hook = (name, ...args) => plugin('hook', name, ...args);
  const save = () => execFileSync('/bin/bash', [path.join(RESURRECT, 'save.sh'), 'quiet'], { env, encoding: 'utf8', timeout: 30000 });
  const restore = () => execFileSync('/bin/bash', [path.join(RESURRECT, 'restore.sh')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const stop = () => {
    try { tmux('kill-server'); } catch {}
    // Non-interactive test shells do not necessarily forward SIGHUP.
    for (const e of events(root).filter(e => e.pane)) {
      try { if (processes().get(e.pid)?.start === e.start) process.kill(e.pid, 'SIGTERM'); } catch {}
    }
  };
  const pane = target => tmux('display-message', '-p', '-t', target, '#{pane_id}');
  const run = (target, id, args = []) => tmux('respawn-pane', '-k', '-t', target, '-c', cwd, '/bin/sh', '-c',
    `${[fake, '--resume', id, ...args].map(quote).join(' ')}; exec /bin/sh`);
  const last = () => fs.realpathSync(path.join(root, 'snapshots/last'));
  const writeLast = value => fs.writeFileSync(last(), value);
  return { root, cwd, fake, project, claudeDir, tmux, start, stop, plugin, hook, save, restore, pane, run, last, writeLast,
    clean: () => { stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}


export async function savedFixture(t) {
  const fixtureState = fixture();
  t.after(fixtureState.clean);
  fixtureState.start();
  fixtureState.run('work:0.0', IDS[0]);
  await waitFor(() => events(fixtureState.root).length === 1);
  fixtureState.save();
  return fixtureState;
}
