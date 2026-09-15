import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAC_READER = fileURLToPath(new URL('./procargs.py', import.meta.url));
const MAX_BYTES = 1024 * 1024;
const MAX_ARGS = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

const rules = new Map();
const register = (kind, names) => names.split(' ').forEach(name => rules.set(name, kind));
register('flag', '--dangerously-skip-permissions --allow-dangerously-skip-permissions --chrome --no-chrome'
  + ' --verbose --ide --strict-mcp-config --disable-slash-commands --bare --brief --restricted --safe-mode'
  + ' --ax-screen-reader --exclude-dynamic-system-prompt-sections');
register('value', '--model --fallback-model --effort --permission-mode --agent --agents --name -n'
  + ' --system-prompt --system-prompt-file --append-system-prompt --append-system-prompt-file'
  + ' --settings --setting-sources --plugin-dir --plugin-url --debug-file --autocompact --advisor'
  + ' --system-prompt-snapshot --remote-control-session-name-prefix');
register('many', '--add-dir --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools'
  + ' --mcp-config --betas --channels --dangerously-load-development-channels');
register('optional', '--remote-control --rc');
register('equals', '--debug -d');
register('drop', '--continue -c --fork-session --tmux');
register('drop-value', '--session-id');
register('drop-optional', '--resume -r --from-pr --teleport --worktree -w');

export function validArguments(args) {
  return Array.isArray(args) && args.length <= MAX_ARGS
    && args.every(arg => typeof arg === 'string' && !arg.includes('\0')
      && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(arg))
    && args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) <= MAX_BYTES;
}

export function decodeCmdline(buffer) {
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.at(-1) !== 0) {
    throw new Error('Process arguments are missing or truncated');
  }
  const args = decoder.decode(buffer.subarray(0, -1)).split('\0');
  if (!validArguments(args) || !args[0]) throw new Error('Invalid process arguments');
  return args;
}

// Preserve values as argv elements. Replaying a shell-formatted ps line loses boundaries.
export function readProcessArguments(pids) {
  if (!pids.length) return new Map();
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('Invalid process ID');
  if (process.platform === 'darwin') {
    let records;
    try {
      records = JSON.parse(execFileSync('python3', ['-I', MAC_READER, ...pids.map(String)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 16 * MAX_BYTES,
      }));
    } catch {
      throw new Error('Cannot read native arguments on macOS; Python 3 must be available in the tmux PATH');
    }
    return new Map(pids.map(pid => {
      const record = records?.[pid];
      return [pid, validArguments(record?.args) && record.args[0]
        ? { args: record.args } : { error: 'Native process arguments are unavailable' }];
    }));
  }
  if (process.platform !== 'linux') throw new Error('Unsupported process argument platform');
  return new Map(pids.map(pid => {
    try { return [pid, { args: decodeCmdline(fs.readFileSync(`/proc/${pid}/cmdline`)) }]; }
    catch { return [pid, { error: 'Native process arguments are unavailable' }]; }
  }));
}

export function claudeArguments(argv) {
  if (!validArguments(argv) || !argv[0]) throw new Error('Invalid process arguments');
  const executable = path.basename(argv[0]);
  if (/^(node|nodejs|bun)$/.test(executable)) {
    if (!argv[1] || argv[1].startsWith('-')) throw new Error('Unsupported Claude interpreter invocation');
    return argv.slice(2);
  }
  if (!/^(claude|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(executable)) {
    throw new Error('Unrecognized or overwritten Claude argument vector');
  }
  return argv.slice(1);
}

export function restoreArguments(args) {
  if (!validArguments(args)) throw new Error('Invalid Claude arguments');
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg) throw new Error('Empty positional argument or overwritten process arguments');
    // Initial prompts have already been delivered to the saved conversation.
    if (!arg.startsWith('-') || arg === '-') continue;
    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    const kind = rules.get(name);
    if (!kind) throw new Error('Unsupported Claude launch option');
    const values = [arg];
    if (kind === 'flag' && equal >= 0) throw new Error('Unexpected value for a Claude switch');
    if (kind.endsWith('value') && equal < 0) {
      if (++i >= args.length) throw new Error('Missing Claude option value');
      values.push(args[i]);
    } else if (kind.endsWith('optional') && equal < 0) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
    } else if (kind === 'many') {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      if (equal < 0 && values.length === 1) throw new Error('Missing Claude option values');
    }
    if (!kind.startsWith('drop')) kept.push(...values);
  }
  return kept;
}

export function validRestoreArguments(args) {
  if (!validArguments(args)) return false;
  try { return JSON.stringify(restoreArguments(args)) === JSON.stringify(args); }
  catch { return false; }
}
