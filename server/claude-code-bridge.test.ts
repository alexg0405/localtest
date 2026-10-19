import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { claudeModels, isClaudeModel } from '../src/claude';
import { childEnv, claudeArgs, claudeCommand, findClaudeBinary, startClaude, streamAnswer, translateLine, WarmClaude, type BridgeEvent } from './claude-code-bridge';

const root = mkdtempSync(join(tmpdir(), 'roomside-bridge-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const windows = process.platform === 'win32';

/** A command-line program that runs `body` with this Node: a script with a shebang, or on Windows an npm-style .cmd shim. */
function nodeCli(name: string, body: string) {
  if (windows) {
    writeFileSync(join(root, `${name}.cjs`), body);
    const shim = join(root, `${name}.cmd`); writeFileSync(shim, `@ECHO off\r\n"${process.execPath}"  "%dp0%\\${name}.cjs" %*\r\n`);
    return shim;
  }
  const path = join(root, name); writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
  return path;
}

/** A stand-in for the Claude Code CLI: records its process ID, arguments, prompt, and environment in its working directory, then prints lines. */
function fakeClaude(name: string, lines: string[], { exitCode = 0, sleep = 0, stderr = '' } = {}) {
  return nodeCli(name, `const fs = require('node:fs');
fs.appendFileSync('started.txt', process.pid + '\\n');
fs.writeFileSync('args.txt', process.argv.slice(2).map(arg => arg + '\\n').join(''));
const input = [];
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync('prompt.txt', Buffer.concat(input));
  fs.writeFileSync('env.txt', Object.entries(process.env).map(([key, value]) => key + '=' + value + '\\n').join(''));
  setTimeout(() => { process.stdout.write(${JSON.stringify(lines.map(line => `${line}\n`).join(''))}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode}; }, ${sleep * 1000});
});
`);
}
const workDir = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' });
async function run(binary: string, cwd: string, extra: Partial<Parameters<typeof streamAnswer>[0]> = {}) {
  const events: BridgeEvent[] = [];
  await streamAnswer({ child: startClaude(binary, 'claude-haiku-4-5', 'Be brief.', cwd), prompt: 'Question: What is a hash map?', onEvent: event => events.push(event), ...extra });
  return events;
}
/** Process IDs of the fake CLIs started in a folder, in order. */
const startedPids = (cwd: string) => { try { return readFileSync(join(cwd, 'started.txt'), 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };

describe('translateLine', () => {
  it('turns text deltas into text events and ignores other lines', () => {
    const state = { streamed: false };
    expect(translateLine(delta('Hi'), state)).toEqual([{ text: 'Hi' }]);
    expect(translateLine(JSON.stringify({ type: 'system', subtype: 'init' }), state)).toEqual([]);
    expect(translateLine('not json', state)).toEqual([]);
    expect(translateLine(JSON.stringify({ type: 'result', is_error: false, result: 'Hi' }), state)).toEqual([{ done: true }]);
  });

  it('uses the final result when no deltas streamed', () => {
    expect(translateLine(JSON.stringify({ type: 'result', is_error: false, result: 'Whole answer' }), { streamed: false })).toEqual([{ text: 'Whole answer' }, { done: true }]);
  });

  it('explains how to sign in when Claude Code is not logged in', () => {
    const [event] = translateLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }), { streamed: false });
    expect(event).toEqual({ error: expect.stringMatching(/claude auth login/) });
  });
});

describe('command line and environment', () => {
  it('disables tools, MCP servers, your own Claude Code setup, thinking, and session files', () => {
    const args = claudeArgs('claude-haiku-4-5', 'Be brief.');
    expect(args).toEqual(expect.arrayContaining(['-p', '--include-partial-messages', '--strict-mcp-config', '--safe-mode', '--no-session-persistence']));
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ alwaysThinkingEnabled: false });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Be brief.');
    expect(args).not.toContain('--effort');
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const) expect(claudeArgs(model, 'x')).toEqual(expect.arrayContaining(['--effort', 'low']));
  });

  it('runs only the models Settings offers', () => {
    expect(claudeModels.map(model => model.id)).toEqual(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5'].map(isClaudeModel)).toEqual([true, true, false, false]);
  });

  it('never passes API keys or other Claude session variables to the CLI', () => {
    const env = childEnv({ HOME: '/Users/me', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_OAUTH_TOKEN: 'secret' });
    expect(env).toEqual({ HOME: '/Users/me', PATH: '/usr/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });

  it("keeps what Windows programs need to find the user's profile and system folders, and still no secrets", () => {
    const windowsEnv = { PATH: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Temp', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' };
    expect(childEnv({ ...windowsEnv, ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDECODE: '1' })).toEqual({ ...windowsEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });
});

describe.skipIf(windows)('findClaudeBinary on macOS and Linux', () => {
  it('prefers CLAUDE_BIN, then PATH, then the newest desktop app copy', () => {
    const home = workDir('home'); const bin = workDir('bin');
    const bundled = (version: string) => { const dir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'claude.app', 'Contents', 'MacOS'); mkdirSync(dir, { recursive: true }); const path = join(dir, 'claude'); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, 0o755); return path; };
    bundled('2.1.9'); const newest = bundled('2.1.10');
    expect(findClaudeBinary({ PATH: '/nonexistent' }, home)).toBe(newest);
    const onPath = join(bin, 'claude'); writeFileSync(onPath, '#!/bin/sh\n'); chmodSync(onPath, 0o755);
    expect(findClaudeBinary({ PATH: bin }, home)).toBe(onPath);
    expect(findClaudeBinary({ PATH: bin, CLAUDE_BIN: newest }, home)).toBe(newest);
    expect(findClaudeBinary({ PATH: '/nonexistent' }, workDir('empty-home'))).toBeNull();
  });

  it("finds the native installer's copy in ~/.local/bin when it isn't on PATH", () => {
    const home = workDir('home-local'); mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const path = join(home, '.local', 'bin', 'claude'); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, 0o755);
    expect(findClaudeBinary({ PATH: '/nonexistent' }, home)).toBe(path);
  });

  it("finds the desktop app's copy a level down in a build folder, where newer versions keep it", () => {
    const home = workDir('home-builds'); const versions = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    const copy = (version: string, build: string) => { const dir = join(versions, version, build, 'claude.app', 'Contents', 'MacOS'); mkdirSync(dir, { recursive: true }); const path = join(dir, 'claude'); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, 0o755); return path; };
    copy('2.1.281', '01c192d55a6f'); const newest = copy('2.1.286', 'f2326db61802');
    expect(findClaudeBinary({ PATH: '/nonexistent' }, home)).toBe(newest);
    mkdirSync(join(versions, '2.1.290', 'a1b2c3d4e5f6'), { recursive: true }); // A newer version still being installed, with no copy yet.
    expect(findClaudeBinary({ PATH: '/nonexistent' }, home)).toBe(newest);
  });
});

describe('findClaudeBinary on Windows', () => {
  const file = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); chmodSync(path, 0o755); return path; };

  it('finds claude.exe or npm\'s claude.cmd on PATH, not the shell script npm also puts there', () => {
    const home = workDir('win-home'); const bin = workDir('win-bin');
    file(join(bin, 'claude'));
    expect(findClaudeBinary({ PATH: bin }, home, 'win32')).toBeNull();
    const cmd = file(join(bin, 'claude.cmd'));
    expect(findClaudeBinary({ PATH: bin }, home, 'win32')).toBe(cmd);
    const exe = file(join(bin, 'claude.exe'));
    expect(findClaudeBinary({ PATH: `C:\\nonexistent;${bin}` }, home, 'win32')).toBe(exe);
  });

  it("falls back to the native installer's copy, then npm's global folder, then the desktop app's copy", () => {
    const home = workDir('win-fallback'); const appData = join(home, 'AppData', 'Roaming');
    const desktop = file(join(appData, 'Claude', 'claude-code', '2.1.10', 'claude.exe')); file(join(appData, 'Claude', 'claude-code', '2.1.9', 'claude.exe'));
    expect(findClaudeBinary({ PATH: '' }, home, 'win32')).toBe(desktop);
    const npm = file(join(appData, 'npm', 'claude.cmd'));
    expect(findClaudeBinary({ PATH: '', APPDATA: appData }, home, 'win32')).toBe(npm);
    const native = file(join(home, '.local', 'bin', 'claude.exe'));
    expect(findClaudeBinary({ PATH: '' }, home, 'win32')).toBe(native);
  });
});

describe('claudeCommand', () => {
  // What npm writes for a package's command on Windows (cmd-shim).
  const npmShim = (target: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

  it("runs the script npm's shim points to with this Node, without a shell", () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
    expect(claudeCommand(shim, () => npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'))).toEqual({
      command: process.execPath, args: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    });
  });

  it('runs a shim\'s .exe directly, and anything else as it is', () => {
    const shim = 'C:\\npm\\claude.cmd';
    expect(claudeCommand(shim, () => npmShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'))).toEqual({ command: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args: [] });
    expect(claudeCommand('C:\\Users\\me\\.local\\bin\\claude.exe')).toEqual({ command: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: [] });
    expect(claudeCommand('/usr/local/bin/claude')).toEqual({ command: '/usr/local/bin/claude', args: [] });
  });
});

describe('streamAnswer', () => {
  it('streams text, sends the prompt on stdin, and passes no secrets', async () => {
    const cwd = workDir('stream');
    const events = await run(fakeClaude('claude-ok', [JSON.stringify({ type: 'system', subtype: 'init' }), delta('A hash map'), delta(' stores pairs.'), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'A hash map stores pairs.' })]), cwd);
    expect(events).toEqual([{ text: 'A hash map' }, { text: ' stores pairs.' }, { done: true }]);
    expect(JSON.parse(readFileSync(join(cwd, 'prompt.txt'), 'utf8'))).toEqual({ type: 'user', message: { role: 'user', content: 'Question: What is a hash map?' } });
    expect(readFileSync(join(cwd, 'args.txt'), 'utf8')).not.toContain('hash map'); // Keep the question out of the process list.
    expect(readFileSync(join(cwd, 'env.txt'), 'utf8')).not.toMatch(/ANTHROPIC_|CLAUDE_CODE_OAUTH/);
  });

  it('reports sign-in errors', async () => {
    const events = await run(fakeClaude('claude-logged-out', [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })], { exitCode: 1 }), workDir('logged-out'));
    expect(events).toEqual([{ error: expect.stringMatching(/claude auth login/) }]);
  });

  it('reports a crash with its last error line', async () => {
    const binary = fakeClaude('claude-crash', [], { stderr: 'boom: something failed\n', exitCode: 3 });
    expect(await run(binary, workDir('crash'))).toEqual([{ error: 'boom: something failed' }]);
  });

  it('stops the process when the page aborts', async () => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const events = await run(fakeClaude('claude-slow', [delta('late')], { sleep: 5 }), workDir('abort'), { signal: controller.signal });
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up after the timeout', async () => {
    const events = await run(fakeClaude('claude-hangs', [delta('late')], { sleep: 5 }), workDir('timeout'), { timeoutMs: 150 });
    expect(events).toEqual([{ error: expect.stringMatching(/took too long/) }]);
  });
});

describe('WarmClaude', () => {
  const soon = { timeout: 3000 };
  const stopped = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

  it('hands the process it started ahead of time to the next answer, then starts the one after', async () => {
    const cwd = workDir('warm'); const binary = fakeClaude('claude-warm', [delta('Hi.'), success]); const claude = new WarmClaude(cwd);
    try {
      claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(1), soon);
      const child = claude.take(binary, 'claude-haiku-4-5', 'Be brief.');
      expect(child.pid).toBe(startedPids(cwd)[0]);
      const events: BridgeEvent[] = [];
      await streamAnswer({ child, prompt: 'Question: Hi?', onEvent: event => events.push(event) });
      expect(events).toEqual([{ text: 'Hi.' }, { done: true }]);
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(2), soon); // Already waiting for the next question.
    } finally { claude.close(); }
  });

  it('replaces the waiting process before it goes stale, so a quiet stretch does not cost a cold start', async () => {
    const cwd = workDir('warm-refresh'); const binary = fakeClaude('claude-warm-refresh', [success], { sleep: 5 }); const claude = new WarmClaude(cwd, 400);
    try {
      claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(1), soon);
      const [first] = startedPids(cwd);
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(2), soon); // Swapped before the 400 ms limit.
      await vi.waitFor(() => expect(stopped(first)).toBe(true), soon);
      expect(claude.take(binary, 'claude-haiku-4-5', 'Be brief.').pid).toBe(startedPids(cwd)[1]);
    } finally { claude.close(); }
  });

  it('starts a new process when the model or system prompt changed, and stops the one that was waiting', async () => {
    const cwd = workDir('warm-changed'); const binary = fakeClaude('claude-warm-changed', [success]); const claude = new WarmClaude(cwd);
    try {
      claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(1), soon);
      const [waiting] = startedPids(cwd);
      const child = claude.take(binary, 'claude-sonnet-5-5', 'Be brief.');
      expect(child.pid).not.toBe(waiting);
      await vi.waitFor(() => expect(stopped(waiting)).toBe(true), soon);
      child.kill();
    } finally { claude.close(); }
  });

  it('does not hand out a process that already exited', async () => {
    const cwd = workDir('warm-exited'); const binary = nodeCli('claude-exits', "require('node:fs').appendFileSync('started.txt', process.pid + '\\n'); process.exit(1);");
    const claude = new WarmClaude(cwd);
    try {
      claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
      await vi.waitFor(() => expect(startedPids(cwd).length === 1 && stopped(startedPids(cwd)[0])).toBe(true), soon);
      expect(claude.take(binary, 'claude-haiku-4-5', 'Be brief.').pid).not.toBe(startedPids(cwd)[0]);
    } finally { claude.close(); }
  });

  it('stops the waiting process when the dev server closes, and starts no more', async () => {
    const cwd = workDir('warm-close'); const binary = fakeClaude('claude-warm-close', [success]); const claude = new WarmClaude(cwd);
    claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
    await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(1), soon);
    claude.close();
    await vi.waitFor(() => expect(stopped(startedPids(cwd)[0])).toBe(true), soon);
    claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(startedPids(cwd)).toHaveLength(1);
  });
});
