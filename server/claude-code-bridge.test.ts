import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { childEnv, claudeArgs, findClaudeBinary, isLocalRequest, startClaude, streamAnswer, translateLine, WarmClaude, type BridgeEvent } from './claude-code-bridge';

const root = mkdtempSync(join(tmpdir(), 'roomside-bridge-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for the Claude Code CLI: records its process ID, arguments, prompt, and environment in its working directory, then prints lines. */
function fakeClaude(name: string, lines: string[], { exitCode = 0, sleep = 0 } = {}) {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\necho $$ >> started.txt\nprintf '%s\\n' "$@" > args.txt\ncat > prompt.txt\nenv > env.txt\n${sleep ? `sleep ${sleep}\n` : ''}${lines.map(line => `printf '%s\\n' '${line}'`).join('\n')}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
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
    expect(claudeArgs('claude-sonnet-5', 'x')).toEqual(expect.arrayContaining(['--effort', 'low']));
  });

  it('never passes API keys or other Claude session variables to the CLI', () => {
    const env = childEnv({ HOME: '/Users/me', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_OAUTH_TOKEN: 'secret' });
    expect(env).toEqual({ HOME: '/Users/me', PATH: '/usr/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });
});

describe('isLocalRequest', () => {
  it('accepts only same-origin requests on this computer', () => {
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isLocalRequest({ host: 'localhost:5173' })).toBe(true);
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isLocalRequest({ host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isLocalRequest({ host: 'evil.example:5173', origin: 'http://evil.example:5173' })).toBe(false); // DNS rebinding
  });
});

describe('findClaudeBinary', () => {
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
    const binary = join(root, 'claude-crash'); writeFileSync(binary, '#!/bin/sh\ncat > /dev/null\necho "boom: something failed" >&2\nexit 3\n'); chmodSync(binary, 0o755);
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

  it('starts a new process when the model or system prompt changed, and stops the one that was waiting', async () => {
    const cwd = workDir('warm-changed'); const binary = fakeClaude('claude-warm-changed', [success]); const claude = new WarmClaude(cwd);
    try {
      claude.prepare(binary, 'claude-haiku-4-5', 'Be brief.');
      await vi.waitFor(() => expect(startedPids(cwd)).toHaveLength(1), soon);
      const [waiting] = startedPids(cwd);
      const child = claude.take(binary, 'claude-sonnet-5', 'Be brief.');
      expect(child.pid).not.toBe(waiting);
      await vi.waitFor(() => expect(stopped(waiting)).toBe(true), soon);
      child.kill();
    } finally { claude.close(); }
  });

  it('does not hand out a process that already exited', async () => {
    const cwd = workDir('warm-exited'); const binary = join(root, 'claude-exits'); writeFileSync(binary, '#!/bin/sh\necho $$ >> started.txt\nexit 1\n'); chmodSync(binary, 0o755);
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
