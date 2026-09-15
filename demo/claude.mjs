// Synthetic conversations for the demo; save and restore use the real plugin.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const resumed = args.includes('--resume');
const id = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
const root = process.env.CLAUDE_CONFIG_DIR;
const transcript = path.join(root, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const conversation = JSON.parse(fs.readFileSync(transcript, 'utf8'));
const start = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
  encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
}).trim().replace(/\s+/g, ' ');
const record = path.join(root, 'sessions', `${process.pid}.json`);
fs.writeFileSync(record, JSON.stringify({ pid: process.pid, procStart: start, sessionId: id,
  cwd: process.cwd(), kind: 'interactive', entrypoint: 'cli' }));
fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ id, pid: process.pid, start,
  pane: process.env.TMUX_PANE, cwd: process.cwd(), args, resumed }) + '\n');

const color = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const purple = text => color('38;2;189;147;249', text);
const cyan = text => color('38;2;139;233;253', text);
const green = text => color('38;2;80;250;123', text);
const muted = text => color('38;2;151;157;181', text);
const option = args.includes('--dangerously-skip-permissions')
  ? '--dangerously-skip-permissions' : '--permission-mode plan';
process.stdout.write(`\x1b]2;${conversation.title}\x07\x1b[2J\x1b[H\x1b[?25l`);
const lines = [
  '', `  ${purple('CLAUDE SESSION')}  ${muted('· demo data')}`, '',
  `  ${muted('PROJECT')}  atlas/`,
  `  ${muted('SESSION')}  ${cyan(id.slice(0, 8))}`, '',
  `  ${muted('START OPTIONS')}`, `  ${purple(option)}`, '',
  `  ${muted('─'.repeat(43))}`, '',
  `  ${cyan('›')} ${conversation.prompt}`, '',
  `  ${green('●')} ${conversation.answer}`, ...conversation.details.map(line => `    ${line}`), '',
  `  ${muted('─'.repeat(43))}`, '',
  `  ${resumed ? green('✓ Conversation resumed') : muted('Waiting for your next message')}`, '',
  `  ${cyan('›')} `,
];
process.stdout.write(lines.join('\r\n'));
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => { fs.rmSync(record, { force: true }); process.exit(0); });
}
setInterval(() => {}, 1000);
