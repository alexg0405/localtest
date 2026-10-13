// Serves Interview Lab (practice/lab.py) from Roomside's dev server at /practice/, so `npm start` runs both and they
// share one address. The lab itself is a small local Python server on 127.0.0.1:8765; this starts it with the dev
// server (and again if it stops) and forwards /practice/* to it.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { isLocalRequest } from './http';

export const practiceUrl = (port = 8765) => `http://127.0.0.1:${port}/`;

/** True when Interview Lab answers on the port. */
export async function labRunning(url: string, fetcher: typeof fetch = fetch) {
  try { const response = await fetcher(`${url}api/interviews`, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; }
}

/** Starts `python3 practice/lab.py serve` in the background, detached so it outlives dev server restarts. */
export function startLab(root: string, port: number) {
  const logs = join(homedir(), 'interview-practice', '.lab'); mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, 'dashboard.log'), 'a');
  const child = spawn('python3', [join(root, 'practice', 'lab.py'), 'serve', '--no-open', '--port', String(port)], { cwd: root, detached: true, stdio: ['ignore', log, log] });
  child.on('error', () => undefined);
  child.unref();
}

type StarterOptions = { running: () => Promise<boolean>; start: () => void; wait?: (ms: number) => Promise<void>; attempts?: number };

/** Returns a function that makes sure the lab is up, starting it at most once even when requests arrive together. */
export function labStarter({ running, start, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 40 }: StarterOptions) {
  let pending: Promise<boolean> | null = null;
  return () => pending ??= (async () => {
    try {
      if (await running()) return true;
      start();
      for (let i = 0; i < attempts; i++) { await wait(250); if (await running()) return true; }
      return false;
    } finally { pending = null; }
  })();
}

const loopback = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/;
const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Forwards /practice/* to the lab, for the browser on this computer only. Mounted at /practice, so req.url has no prefix. */
export function practiceProxy({ port, ensure }: { port: number; ensure: () => Promise<boolean> }) {
  return async (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse) => {
    const fail = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(message); };
    // Opening the page by typing its address sends no Origin, so page loads only need this computer; changes need the page itself.
    if (!loopback.test(req.socket.remoteAddress ?? '') || !localHost.test(req.headers.host ?? '')) return fail(403, 'Interview Lab only works from this computer.');
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET') && !isLocalRequest(req.headers, req.socket.remoteAddress)) return fail(403, 'Only the Interview Lab page can make changes.');
    const original = req.originalUrl ?? req.url ?? '/';
    if (/^\/practice(\?|$)/.test(original)) { res.writeHead(302, { Location: original.replace('/practice', '/practice/') }); res.end(); return; }
    if (!await ensure()) return fail(503, 'Interview Lab did not start. Run `python3 practice/lab.py serve` in a terminal to see why (it needs Python 3.9 or newer).');

    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`; // checked above; the lab only accepts its own origin
    const upstream = request({ host: '127.0.0.1', port, path: req.url || '/', method: req.method, headers }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) fail(502, 'Interview Lab stopped responding. Reload the page to start it again.'); else res.end(); });
    req.pipe(upstream);
  };
}

/** Serves Interview Lab at /practice/ during `npm run dev`, and starts it when the dev server starts. */
export function practiceLab(port = 8765): Plugin {
  return {
    name: 'roomside-practice-lab',
    apply: 'serve',
    configureServer(server) {
      const ensure = labStarter({ running: () => labRunning(practiceUrl(port)), start: () => startLab(server.config.root, port) });
      server.middlewares.use('/practice', practiceProxy({ port, ensure }));
      server.httpServer?.once('listening', () => {
        void ensure().then(ok => server.config.logger.info(ok ? `  ➜  Practice: http://127.0.0.1:${server.config.server.port ?? 5173}/practice/` : '  Interview Lab did not start; see ~/interview-practice/.lab/dashboard.log'));
      });
    },
  };
}
