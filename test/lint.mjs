import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

execFileSync('python3', ['-c', 'import ast, pathlib; [ast.parse(p.read_text()) for d in ("src", "demo") for p in pathlib.Path(d).glob("*.py")]'], { stdio: 'inherit' });
for (const directory of ['src', 'test', 'demo']) {
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
  }
}
execFileSync('shellcheck', [
  'claude-resurrect.tmux', 'bin/claude-resurrect', 'test/setup-deps.sh', '.githooks/pre-commit',
], { stdio: 'inherit' });
