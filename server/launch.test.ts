import { describe, expect, it } from 'vitest';
import { findPython, installHint, pythonCandidates } from '../practice/launch.mjs';

/** A stand-in for spawnSync that answers like the named Pythons. */
const pythons = (answers: Record<string, { status: number; stdout?: string }>) => (command: string, args: string[]) => {
  const answer = answers[[command, ...args.slice(0, args.indexOf('-c'))].join(' ')];
  return answer ? { status: answer.status, stdout: answer.stdout ?? '' } : { status: null, stdout: '', error: new Error('ENOENT') };
};

describe('finding Python for Interview Lab', () => {
  it('tries the py launcher first on Windows, and python3 elsewhere', () => {
    expect(pythonCandidates({}, 'win32')).toEqual([['py', '-3'], ['python'], ['python3']]);
    expect(pythonCandidates({}, 'darwin')).toEqual([['python3'], ['python']]);
    expect(pythonCandidates({ LAB_PYTHON: 'C:\\Python312\\python.exe' }, 'win32')[0]).toEqual(['C:\\Python312\\python.exe']);
  });

  it("skips Windows' Microsoft Store shortcut and Pythons older than 3.9", () => {
    const run = pythons({ 'py -3': { status: 9009 }, python: { status: 0, stdout: 'False\r\n' }, python3: { status: 0, stdout: 'True\r\n' } });
    expect(findPython({}, 'win32', run as never)).toEqual(['python3']);
    expect(findPython({}, 'win32', pythons({ 'py -3': { status: 0, stdout: 'True\r\n' } }) as never)).toEqual(['py', '-3']);
  });

  it('says how to install Python when there is none', () => {
    expect(findPython({}, 'win32', pythons({}) as never)).toBeNull();
    expect(installHint('win32')).toMatch(/python\.org.*Add python\.exe to PATH/);
  });
});
