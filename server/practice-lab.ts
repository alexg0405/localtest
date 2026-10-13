// Lets the Roomside page start Interview Lab (practice/lab.py), so switching between the two is one click. The lab
// runs as its own local Python server on 127.0.0.1:8765 and keeps running when the dev server restarts.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { isLocalRequest } from './http';

export const practiceUrl = (port = 8765) => `http://127.0.0.1:${port}/`;

/** True when Interview Lab answers on the port. */
export async function labRunning(url: string, fetcher: typeof fetch = fetch) {
  try { const response = await fetcher(`${url}api/interviews`, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; }
}

/** Starts `python3 practice/lab.py serve` in the background, detached so it outlives the dev server. */
export function startLab(root: string, port: number) {
  const logs = join(homedir(), 'interview-practice', '.lab'); mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, 'dashboard.log'), 'a');
  const child = spawn('python3', [join(root, 'practice', 'lab.py'), 'serve', '--no-open', '--port', String(port)], { cwd: root, detached: true, stdio: ['ignore', log, log] });
  child.on('error', () => undefined);
  child.unref();
}

type Options = { url: string; running: () => Promise<boolean>; start: () => void; wait?: (ms: number) => Promise<void>; attempts?: number };

/** GET /status → { running, url }. POST /start starts the lab if needed and waits until it answers. */
export function practiceHandler({ url, running, start, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 40 }: Options) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!isLocalRequest(req.headers, req.socket.remoteAddress)) return reply(403, { error: 'Only the Roomside page on this computer can start Interview Lab.' });
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/status') return reply(200, { running: await running(), url });
    if (req.method !== 'POST' || path !== '/start') return reply(404, { error: 'Not found.' });
    if (await running()) return reply(200, { running: true, url });
    start();
    for (let i = 0; i < attempts; i++) { await wait(250); if (await running()) return reply(200, { running: true, url }); }
    reply(503, { running: false, url, error: 'Interview Lab did not start. Run `python3 practice/lab.py serve` in a terminal to see why (it needs Python 3.9+).' });
  };
}

/** Serves /api/practice/status and /api/practice/start during `npm run dev`. */
export function practiceLab(port = 8765): Plugin {
  return {
    name: 'roomside-practice-lab',
    apply: 'serve',
    configureServer(server) {
      const url = practiceUrl(port);
      server.middlewares.use('/api/practice', practiceHandler({ url, running: () => labRunning(url), start: () => startLab(server.config.root, port) }));
    },
  };
}
