import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const directory of ['src', 'test']) {
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
  }
}
execFileSync('shellcheck', ['claude-resurrect.tmux', 'bin/claude-resurrect', 'test/setup-deps.sh'], { stdio: 'inherit' });
