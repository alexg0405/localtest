import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { labRunning, practiceHandler } from './practice-lab';

const request = (method: string, url: string, headers: Record<string, string> = { host: '127.0.0.1:5173' }, remoteAddress = '127.0.0.1') =>
  ({ method, url, headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

function response() {
  const result = { status: 0, body: {} as any };
  const res = { writeHead: (status: number) => { result.status = status; }, end: (text: string) => { result.body = JSON.parse(text); } } as unknown as ServerResponse;
  return { res, result };
}

const url = 'http://127.0.0.1:8765/';
const noWait = () => Promise.resolve();

describe('practice lab endpoint', () => {
  it('reports whether Interview Lab is running', async () => {
    const { res, result } = response();
    await practiceHandler({ url, running: async () => false, start: vi.fn() })(request('GET', '/status'), res);
    expect(result).toEqual({ status: 200, body: { running: false, url } });
  });

  it('starts the lab once and waits until it answers', async () => {
    let up = false; const start = vi.fn(() => { setTimeout(() => { up = true; }, 0); });
    const { res, result } = response();
    await practiceHandler({ url, running: async () => up, start, wait: ms => new Promise(resolve => setTimeout(resolve, ms / 100)) })(request('POST', '/start'), res);
    expect(start).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 200, body: { running: true, url } });
  });

  it('does not start a second copy when it is already running', async () => {
    const start = vi.fn(); const { res, result } = response();
    await practiceHandler({ url, running: async () => true, start })(request('POST', '/start'), res);
    expect(start).not.toHaveBeenCalled();
    expect(result.body.running).toBe(true);
  });

  it('explains when the lab never comes up', async () => {
    const { res, result } = response();
    await practiceHandler({ url, running: async () => false, start: vi.fn(), wait: noWait, attempts: 3 })(request('POST', '/start'), res);
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/python3 practice\/lab.py serve/);
  });

  it('refuses other websites and other devices', async () => {
    const start = vi.fn();
    for (const req of [request('POST', '/start', { host: '127.0.0.1:5173', origin: 'https://evil.example' }), request('POST', '/start', { host: '127.0.0.1:5173' }, '10.0.0.8')]) {
      const { res, result } = response();
      await practiceHandler({ url, running: async () => false, start })(req, res);
      expect(result.status).toBe(403);
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('treats a refused connection as not running', async () => {
    expect(await labRunning(url, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch)).toBe(false);
    expect(await labRunning(url, (async () => new Response('[]')) as typeof fetch)).toBe(true);
  });
});
