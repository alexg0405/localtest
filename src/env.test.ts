import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextFilesFromEnv, deepgramKeyFromEnv } from './env';

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

describe('contextFilesFromEnv', () => {
  it('fetches each of your default context files as a File', async () => {
    const fetch = vi.fn(async (url: string) => url === '/api/context-files' ? json({ files: [{ name: 'AlexGuoResume (1).pdf', size: 8 }] })
      : new Response('%PDF-1.4', { headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetch);
    const [file, ...rest] = await contextFilesFromEnv();
    expect(rest).toEqual([]);
    expect([file.name, file.type, await file.text()]).toEqual(['AlexGuoResume (1).pdf', 'application/pdf', '%PDF-1.4']);
    expect(fetch).toHaveBeenCalledWith('/api/context-files?name=AlexGuoResume%20(1).pdf', { cache: 'no-store' });
  });

  it('is empty without a dev server or a readable list, and skips files that fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
    expect(await contextFilesFromEnv()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ files: 'nope' })));
    expect(await contextFilesFromEnv()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/context-files' ? json({ files: [{ name: 'gone.pdf' }] }) : new Response('', { status: 404 })));
    expect(await contextFilesFromEnv()).toEqual([]);
  });
});
