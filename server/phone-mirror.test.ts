import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneMirror, lanAddresses, parseCommand } from './phone-mirror';

type Event = { event: string; data: any };
/** Reads a server-sent event stream and hands out its events in order. */
async function stream(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const queue: Event[] = []; const waiting: ((event: Event) => void)[] = [];
  void (async () => {
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(chunk)?.[1]; if (!name) continue; // Retry hints and keep-alive comments.
          const item = { event: name, data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null') };
          const next = waiting.shift(); if (next) next(item); else queue.push(item);
        }
      }
    } catch { /* Closed by the test. */ }
  })();
  const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Event>(resolve => waiting.push(resolve));
  /** Skips events until one matches, since updates that arrive in quick succession may be combined or repeated. */
  const until = async (match: (event: Event) => boolean) => { for (;;) { const item = await next(); if (match(item)) return item; } };
  return { status: response.status, next, until, close: () => controller.abort() };
}

let mirror: PhoneMirror; let laptopServer: Server; let api = '';
const post = (path: string, body: object) => fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const start = async (tab = 'tab-a') => (await (await post('/start', { tab })).json()).links[0].url as string;
const command = (url: string, body: object) => fetch(`${url}command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  // The laptop endpoints as the dev server mounts them under /api/mirror, and a phone server on a free port.
  mirror = new PhoneMirror({ root: process.cwd(), port: 0, addresses: () => ['127.0.0.1'] });
  laptopServer = createServer((req, res) => { void mirror.handleLaptop(req, res); });
  await new Promise<void>(resolve => laptopServer.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(laptopServer.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await mirror.stop();
  laptopServer.closeAllConnections(); await new Promise(resolve => laptopServer.close(resolve));
});

describe('PhoneMirror', () => {
  it('stays off until started, then serves the phone page only under its secret link', async () => {
    expect(await (await fetch(`${api}/status?tab=tab-a`)).json()).toEqual({ running: false, owner: 'none', phones: 0, links: [] });
    expect((await fetch(`${api}/events?tab=tab-a`)).status).toBe(409);
    const status = await (await post('/start', { tab: 'tab-a' })).json();
    expect(status).toMatchObject({ running: true, owner: 'none', phones: 0 });
    const { url, qr } = status.links[0];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{24}\/$/);
    expect(qr).toMatch(/^<svg shape-rendering="crispEdges" /);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('<script type="module" src="phone.js">');
    const script = await fetch(`${url}phone.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const code = await script.text();
    expect(code).toContain('new EventSource("events")');
    expect(code).not.toMatch(/^import|MirrorState/m); // Types stripped; nothing left to load.
    expect((await fetch(`${url}phone.css`)).headers.get('content-type')).toContain('text/css');
    expect((await fetch(url.slice(0, -1), { redirect: 'manual' })).status).toBe(308);

    const { origin, pathname } = new URL(url);
    const secret = pathname.slice(1, -1);
    for (const path of ['/', '/phone.js', `/${secret.slice(0, -1)}A/`, `/${secret}/phone.js/extra`, '/api/mirror/status']) expect((await fetch(origin + path)).status).toBe(404);
  });

  it('relays phone commands to the laptop and the laptop state to the phone', async () => {
    const url = await start();
    const laptop = await stream(`${api}/events?tab=tab-a`);
    const hello = await laptop.next();
    expect(hello).toMatchObject({ event: 'hello', data: { status: { running: true, owner: 'this' } } });
    const phone = await stream(`${url}events`);
    expect(await phone.next()).toEqual({ event: 'state', data: { laptop: true, state: null } });
    expect(await laptop.until(item => item.event === 'status')).toMatchObject({ data: { phones: 1 } });

    expect((await post('/state', { connection: hello.data.connection, state: { question: 'What is a hash map?' } })).status).toBe(204);
    expect(await phone.until(item => item.data.state)).toEqual({ event: 'state', data: { laptop: true, state: { question: 'What is a hash map?' } } });

    expect((await command(url, { type: 'ask', text: '  How does Kafka keep ordering?  ' })).status).toBe(202);
    expect(await laptop.next()).toEqual({ event: 'command', data: { type: 'ask', text: 'How does Kafka keep ordering?' } });
    expect((await command(url, { type: 'listen' })).status).toBe(202);
    expect(await laptop.next()).toEqual({ event: 'command', data: { type: 'listen' } });
    expect((await command(url, { type: 'mode', mode: 'LOUD' })).status).toBe(400);
    expect((await fetch(`${url}command`, { method: 'POST', body: '{"type":"listen"}' })).status).toBe(415); // Not sent as JSON.
    laptop.close(); phone.close();
  });

  it('limits how fast a phone can send commands', async () => {
    const url = await start();
    const laptop = await stream(`${api}/events?tab=tab-a`); await laptop.next();
    const statuses = [];
    for (let index = 0; index < 21; index++) statuses.push((await command(url, { type: 'regenerate' })).status);
    expect(statuses.slice(0, 20).every(status => status === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
    laptop.close();
  });

  it('mirrors one tab at a time and lets another tab take over', async () => {
    await start();
    const first = await stream(`${api}/events?tab=tab-a`); const a = (await first.next()).data;
    const second = await stream(`${api}/events?tab=tab-b`); const b = (await second.next()).data;
    expect(a.status.owner).toBe('this');
    expect(b.status.owner).toBe('other');
    expect((await post('/state', { connection: b.connection, state: {} })).status).toBe(409);
    expect((await (await post('/claim', { tab: 'tab-b', connection: b.connection })).json()).owner).toBe('this');
    expect(await first.until(item => item.event === 'status')).toMatchObject({ data: { owner: 'other' } });
    expect((await post('/state', { connection: b.connection, state: {} })).status).toBe(204);
    expect((await post('/state', { connection: a.connection, state: {} })).status).toBe(409);
    first.close(); second.close();
  });

  it('tells the phone when the laptop page closes, and resumes when that tab reloads', async () => {
    const url = await start();
    const before = await stream(`${api}/events?tab=tab-a`); const { connection } = (await before.next()).data;
    await post('/state', { connection, state: { question: 'Why Postgres?' } });
    const phone = await stream(`${url}events`); await phone.next();
    before.close();
    expect(await phone.until(item => !item.data.laptop)).toEqual({ event: 'state', data: { laptop: false, state: { question: 'Why Postgres?' } } }); // The last answer stays readable.
    expect((await command(url, { type: 'listen' })).status).toBe(409);
    const after = await stream(`${api}/events?tab=tab-a`);
    expect((await after.next()).data.status.owner).toBe('this');
    expect(await phone.until(item => item.data.laptop)).toMatchObject({ event: 'state', data: { laptop: true, state: { question: 'Why Postgres?' } } });
    phone.close(); after.close();
  });

  it('pings phones with an event they can see, so they notice a dead connection', async () => {
    await mirror.stop(); mirror = new PhoneMirror({ root: process.cwd(), port: 0, addresses: () => ['127.0.0.1'], heartbeatMs: 50 });
    const url = await start();
    const phone = await stream(`${url}events`); await phone.next();
    expect(await phone.until(item => item.event === 'ping')).toEqual({ event: 'ping', data: {} });
    phone.close();
  });

  it('ends phone streams when stopped, and uses a new secret link next time', async () => {
    const url = await start();
    const laptop = await stream(`${api}/events?tab=tab-a`); await laptop.next();
    const phone = await stream(`${url}events`); await phone.next();
    expect((await (await post('/stop', { tab: 'tab-a' })).json()).running).toBe(false);
    expect(await phone.next()).toEqual({ event: 'stopped', data: {} });
    expect(await laptop.until(item => item.event !== 'status')).toEqual({ event: 'stopped', data: {} });
    await expect(fetch(url)).rejects.toThrow();
    const again = await start();
    expect(new URL(again).pathname).not.toBe(new URL(url).pathname);
  });

  it('refuses laptop requests from other websites', async () => {
    const response = await fetch(`${api}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    expect(response.status).toBe(403);
    expect(mirror.running).toBe(false);
  });
});

describe('parseCommand', () => {
  it('accepts only known commands', () => {
    expect(parseCommand({ type: 'stop' })).toEqual({ type: 'stop' });
    expect(parseCommand({ type: 'mode', mode: 'BULLETS' })).toEqual({ type: 'mode', mode: 'BULLETS' });
    expect(parseCommand({ type: 'ask', text: ' ' })).toBeNull();
    expect(parseCommand({ type: 'ask', text: 'x'.repeat(2001) })).toBeNull();
    expect(parseCommand({ type: 'clear' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
});

describe('lanAddresses', () => {
  it('lists IPv4 addresses a phone can reach, Wi-Fi first', () => {
    const address = (value: string, family = 'IPv4', internal = false) => ({ address: value, family, internal }) as any;
    expect(lanAddresses({
      lo0: [address('127.0.0.1', 'IPv4', true)],
      utun3: [address('100.64.0.5')],
      bridge100: [address('192.168.2.1')],
      en0: [address('fe80::1c2a', 'IPv6'), address('192.168.1.23')],
      en7: [address('169.254.10.2')],
    })).toEqual(['192.168.1.23', '192.168.2.1', '100.64.0.5']);
    expect(lanAddresses({ lo0: [address('127.0.0.1', 'IPv4', true)] })).toEqual([]);
  });
});
