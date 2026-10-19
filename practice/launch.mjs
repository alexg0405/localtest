// Runs Interview Lab (lab.py) with Python 3.9 or newer on macOS, Linux, and Windows:
//   node practice/launch.mjs [serve | setup | verify | …]     (npm run practice -- setup)
// Roomside's dev server uses findPython() from here to start the lab.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The Python commands to try, in order: $LAB_PYTHON, then the usual names (on Windows, the py launcher first). */
export function pythonCandidates(env = process.env, platform = process.platform) {
  const chosen = env.LAB_PYTHON ? [[env.LAB_PYTHON]] : [];
  return [...chosen, ...(platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']])];
}

/**
 * The first command that runs Python 3.9 or newer, as [command, ...args], or null. On Windows a missing Python can
 * still answer to `python` (the Microsoft Store shortcut), which exits with an error, so each one is tried.
 */
export function findPython(env = process.env, platform = process.platform, run = spawnSync) {
  for (const [command, ...args] of pythonCandidates(env, platform)) {
    const result = run(command, [...args, '-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (result.status === 0 && String(result.stdout).trim() === 'True') return [command, ...args];
  }
  return null;
}

export const installHint = (platform = process.platform) => platform === 'win32'
  ? 'Interview Lab needs Python 3.9 or newer. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then try again.'
  : 'Interview Lab needs Python 3.9 or newer. Install it from https://www.python.org/downloads/ or your package manager, then try again.';

function main(argv) {
  const python = findPython();
  if (!python) { console.error(installHint()); process.exit(1); }
  const [command, ...args] = python;
  const lab = join(dirname(fileURLToPath(import.meta.url)), 'lab.py');
  const child = spawn(command, [...args, lab, ...(argv.length ? argv : ['serve'])], { stdio: 'inherit' });
  process.on('SIGINT', () => undefined); // Ctrl+C reaches the lab too; wait for it to stop
  child.on('exit', code => process.exit(code ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
