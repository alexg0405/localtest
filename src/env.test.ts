import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepgramKeyFromEnv } from './env';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

describe('deepgramKeyFromEnv', () => {
  it('reads the key the dev server found in .env', async () => {
    const fetch = vi.fn(async () => json({ key: ' abc123 ' })); vi.stubGlobal('fetch', fetch);
    expect(await deepgramKeyFromEnv()).toBe('abc123');
    expect(fetch).toHaveBeenCalledWith('/api/deepgram-key', { cache: 'no-store' });
  });

  it('is empty without a dev server, a key, or a readable reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ key: '' })));
    expect(await deepgramKeyFromEnv()).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 }))); // npm run build, preview, or the desktop app
    expect(await deepgramKeyFromEnv()).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    expect(await deepgramKeyFromEnv()).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await deepgramKeyFromEnv()).toBe('');
  });
});
