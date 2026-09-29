import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deepgramKeyHandler, readDeepgramKey } from './deepgram-key';

const root = mkdtempSync(join(tmpdir(), 'roomside-env-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); });

/** A fresh folder holding these .env files. */
const envDir = (files: Record<string, string>) => { const path = mkdtempSync(join(root, 'env-')); for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text); return path; };

describe('readDeepgramKey', () => {
  it('reads DEEPGRAM_API_KEY from .env, trimmed', () => {
    expect(readDeepgramKey(envDir({ '.env': 'OTHER=1\nDEEPGRAM_API_KEY=  abc123  \n' }), 'development')).toBe('abc123');
  });

  it('lets .env.local and the environment override .env', () => {
    const dir = envDir({ '.env': 'DEEPGRAM_API_KEY=from-env-file\n', '.env.local': 'DEEPGRAM_API_KEY=from-local\n' });
    expect(readDeepgramKey(dir, 'development')).toBe('from-local');
    vi.stubEnv('DEEPGRAM_API_KEY', 'from-shell');
    expect(readDeepgramKey(dir, 'development')).toBe('from-shell');
  });

  it('is empty when no key is set', () => {
    expect(readDeepgramKey(envDir({ '.env': 'DEEPGRAM_API_KEY=\n' }), 'development')).toBe('');
    expect(readDeepgramKey(envDir({}), 'development')).toBe('');
  });
});

describe('deepgramKeyHandler', () => {
  let server: Server; let port = 0;
  afterEach(() => new Promise<void>(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); }));
  const serve = async (key: string) => { server = createServer(deepgramKeyHandler(() => key)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as AddressInfo).port; };
  /** A request with exactly these headers (fetch would add or drop some of them). */
  const send = (headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; body: any; cache?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method, headers }, res => { let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), cache: res.headers['cache-control'] })); });
    req.on('error', reject); req.end();
  });

  it('gives the key to the Roomside page on this computer, uncached', async () => {
    await serve('abc123');
    expect(await send({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).toEqual({ status: 200, body: { key: 'abc123' }, cache: 'no-store' });
  });

  it('refuses other websites and anything but GET', async () => {
    await serve('abc123');
    expect(await send({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).toMatchObject({ status: 403, body: { error: expect.any(String) } });
    expect(await send({ host: 'evil.example' })).toMatchObject({ status: 403 }); // DNS rebinding
    expect(await send({}, 'POST')).toMatchObject({ status: 405 });
  });

  it('answers with an empty key when none is set', async () => {
    await serve('');
    expect((await send()).body).toEqual({ key: '' });
  });
});
