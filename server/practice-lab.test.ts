import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labRunning, labStarter, practiceProxy } from './practice-lab';

const noWait = () => Promise.resolve();
const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler); servers.push(server);
  return new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** A fake lab that echoes what it received, and Roomside's /practice mount in front of it. */
async function setup(ensure: () => Promise<boolean> = async () => true) {
  const seen: { url?: string; host?: string; origin?: string; body: string }[] = [];
  const labPort = await listen((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  const proxy = practiceProxy({ port: labPort, ensure });
  const roomsidePort = await listen((req, res) => {
    const original = req.url ?? '/';
    if (!original.startsWith('/practice')) { res.writeHead(404); res.end(); return; }
    Object.assign(req, { originalUrl: original, url: original.slice('/practice'.length) || '/' }); // what connect's mount does
    void proxy(req as IncomingMessage & { originalUrl: string }, res);
  });
  return { seen, roomsidePort };
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

describe('Interview Lab under /practice/', () => {
  it('redirects /practice to /practice/ so the page loads its files', async () => {
    const { roomsidePort } = await setup();
    const reply = await send(roomsidePort, '/practice?x=1');
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe('/practice/?x=1');
  });

  it('forwards page loads and API calls to the lab as if they came from its own origin', async () => {
    const { seen, roomsidePort } = await setup();
    expect((await send(roomsidePort, '/practice/static/app.js')).status).toBe(200);
    const origin = `http://127.0.0.1:${roomsidePort}`;
    const reply = await send(roomsidePort, '/practice/api/start', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"interview":"commerce-orders"}' });
    expect(reply.body).toBe('{"ok":true}');
    expect(seen[0].url).toBe('/static/app.js');
    expect(seen[1]).toMatchObject({ url: '/api/start', body: '{"interview":"commerce-orders"}' });
    expect(seen[1].host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(seen[1].origin).toBe(`http://${seen[1].host}`);
  });

  it('refuses changes from other websites', async () => {
    const { seen, roomsidePort } = await setup();
    const reply = await send(roomsidePort, '/practice/api/start', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(reply.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses requests addressed to another host name', async () => {
    const { seen, roomsidePort } = await setup();
    expect((await send(roomsidePort, '/practice/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('explains when the lab cannot start', async () => {
    const { roomsidePort } = await setup(async () => false);
    const reply = await send(roomsidePort, '/practice/');
    expect(reply.status).toBe(503);
    expect(reply.body).toMatch(/python3 practice\/lab.py serve/);
  });
});

describe('labStarter', () => {
  it('starts the lab once for requests that arrive together', async () => {
    let up = false; const start = vi.fn(() => { up = true; });
    const ensure = labStarter({ running: async () => up, start, wait: noWait });
    expect(await Promise.all([ensure(), ensure(), ensure()])).toEqual([true, true, true]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not start a second copy when one is running', async () => {
    const start = vi.fn();
    expect(await labStarter({ running: async () => true, start })()).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('gives up after a few seconds and tries again on the next request', async () => {
    const start = vi.fn(); const ensure = labStarter({ running: async () => false, start, wait: noWait, attempts: 3 });
    expect(await ensure()).toBe(false);
    expect(await ensure()).toBe(false);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('treats a refused connection as not running', async () => {
    expect(await labRunning('http://127.0.0.1:1/', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch)).toBe(false);
    expect(await labRunning('http://127.0.0.1:1/', (async () => new Response('[]')) as typeof fetch)).toBe(true);
  });
});
