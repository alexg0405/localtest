// Dev-server bridge that answers through the Claude Code CLI signed in with your Claude subscription, so no API key is
// needed. Claude Code runs with every tool disabled, in an empty directory, and only for requests from this page.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Plugin } from 'vite';
import { isClaudeModel, type ClaudeModel } from '../src/claude';

export type BridgeEvent = { text: string } | { error: string } | { done: true };

const isExecutable = (path: string) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
const newestFirst = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const difference = (y[i] ?? 0) - (x[i] ?? 0); if (difference) return difference; } return 0; };

/** Finds Claude Code: $CLAUDE_BIN, then `claude` on PATH, then the newest copy bundled with the Claude desktop app. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  if (env.CLAUDE_BIN) return isExecutable(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null;
  for (const directory of (env.PATH ?? '').split(delimiter)) if (directory && isExecutable(join(directory, 'claude'))) return join(directory, 'claude');
  const bundled = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const versions = existsSync(bundled) ? readdirSync(bundled).filter(name => /^\d+(\.\d+)*$/.test(name)).sort(newestFirst) : [];
  for (const version of versions) { const candidate = join(bundled, version, 'claude.app', 'Contents', 'MacOS', 'claude'); if (isExecutable(candidate)) return candidate; }
  return null;
}

/** Only what the CLI needs. No API keys, so it answers with the subscription login, and no variables from other Claude sessions. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']) if (env[key]) result[key] = env[key];
  return result;
}

/** One answer: print mode with token streaming, no tools, no MCP servers, nothing saved. The prompt arrives on stdin. */
export const claudeArgs = (model: ClaudeModel, system: string) => [
  '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--system-prompt', system,
  '--tools', '', '--strict-mcp-config', '--no-session-persistence', ...(model === 'claude-sonnet-5' ? ['--effort', 'low'] : []),
];

const friendlyError = (message: string) => /not logged in|\/login/i.test(message) ? 'Claude Code is not signed in to your Claude subscription. Run `claude auth login` once, then try again.' : message;

/** Maps one line of Claude Code's stream-json output to bridge events. */
export function translateLine(line: string, state: { streamed: boolean }): BridgeEvent[] {
  let message: any; try { message = JSON.parse(line); } catch { return []; }
  const event = message?.type === 'stream_event' ? message.event : null;
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) { state.streamed = true; return [{ text: event.delta.text }]; }
  if (message?.type !== 'result') return [];
  if (message.is_error) return [{ error: friendlyError(String(message.result || message.subtype || 'Claude Code reported an error.')) }];
  // If token streaming was unavailable, the whole answer arrives with the result.
  return !state.streamed && typeof message.result === 'string' && message.result ? [{ text: message.result }, { done: true }] : [{ done: true }];
}

/** Runs one answer, reporting events until Claude Code finishes. Aborting stops the process. */
export function streamAnswer(options: { binary: string; model: ClaudeModel; system: string; prompt: string; cwd: string; signal?: AbortSignal; timeoutMs?: number; onEvent: (event: BridgeEvent) => void }) {
  return new Promise<void>(resolve => {
    if (options.signal?.aborted) { resolve(); return; }
    const child = spawn(options.binary, claudeArgs(options.model, options.system), { cwd: options.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { streamed: false }; let buffer = ''; let stderr = ''; let finished = false;
    const finish = (event?: BridgeEvent) => {
      if (finished) return; finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (event) options.onEvent(event);
      if (child.exitCode === null) child.kill('SIGTERM');
      resolve();
    };
    const emit = (events: BridgeEvent[]) => { for (const event of events) { if ('text' in event) { if (!finished) options.onEvent(event); } else finish(event); } };
    const abort = () => finish();
    const timer = setTimeout(() => finish({ error: 'Claude Code took too long to answer. Try again.' }), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) emit(translateLine(line, state)); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => finish({ error: `Could not start Claude Code: ${error.message}` }));
    child.on('close', code => { if (buffer.trim()) emit(translateLine(buffer, state)); finish(code === 0 ? { done: true } : { error: friendlyError(stderr.trim().split('\n').pop() || `Claude Code stopped unexpectedly (exit code ${code}).`) }); });
    child.stdin.on('error', () => undefined); child.stdin.end(options.prompt);
  });
}

/** Accepts only same-origin requests from this computer, so other websites cannot spend your Claude usage. */
export function isLocalRequest(headers: IncomingMessage['headers']) {
  const host = headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  if (headers.origin && headers.origin !== `http://${host}`) return false;
  const site = headers['sec-fetch-site'];
  return !site || site === 'same-origin';
}

function authStatus(binary: string, cwd: string) {
  return new Promise<{ loggedIn: boolean; authMethod?: string }>(resolve => {
    execFile(binary, ['auth', 'status', '--json'], { cwd, env: childEnv(), timeout: 15_000 }, (_error, stdout) => {
      try { const status = JSON.parse(stdout); resolve({ loggedIn: status.loggedIn === true, authMethod: status.authMethod }); } catch { resolve({ loggedIn: false }); }
    });
  });
}

const readBody = (req: IncomingMessage, limit: number) => new Promise<string>((resolve, reject) => {
  let data = ''; req.setEncoding('utf8');
  req.on('data', (chunk: string) => { data += chunk; if (data.length > limit) { reject(new Error('Request too large.')); req.destroy(); } });
  req.on('end', () => resolve(data)); req.on('error', reject);
});

async function handle(req: IncomingMessage, res: ServerResponse, cwd: string) {
  const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!isLocalRequest(req.headers)) return reply(403, { error: 'Only the Roomside page on this computer can use the Claude Code bridge.' });
  const binary = findClaudeBinary(); const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/status') return reply(200, binary ? { available: true, ...(await authStatus(binary, cwd)) } : { available: false, loggedIn: false });
  if (req.method !== 'POST' || path !== '/') return reply(404, { error: 'Not found.' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'Send JSON.' });
  if (!binary) return reply(503, { error: 'Claude Code was not found. Install the Claude desktop app or Claude Code, or set CLAUDE_BIN to its path.' });
  let body: any; try { body = JSON.parse(await readBody(req, 64_000)); } catch { return reply(400, { error: 'Invalid request.' }); }
  const { model, system, prompt } = body ?? {};
  if (!isClaudeModel(model) || typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim() || system.length > 8000 || prompt.length > 40_000) return reply(400, { error: 'Invalid request.' });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const controller = new AbortController(); res.on('close', () => controller.abort()); // The page moved on to another question.
  await streamAnswer({ binary, model, system, prompt, cwd, signal: controller.signal, onEvent: event => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`); } });
  if (!res.writableEnded) res.end();
}

/** Serves POST /api/claude-code (streams NDJSON answer events) and GET /api/claude-code/status during `npm run dev`. */
export function claudeCodeBridge(): Plugin {
  return {
    name: 'roomside-claude-code-bridge',
    apply: 'serve',
    configureServer(server) {
      const cwd = join(tmpdir(), 'roomside-claude-code'); mkdirSync(cwd, { recursive: true });
      server.middlewares.use('/api/claude-code', (req, res) => { handle(req, res, cwd).catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } else res.end(); }); });
    },
  };
}
