import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { contextFilePaths, contextFilesHandler } from './context-files';

const root = mkdtempSync(join(tmpdir(), 'roomside-context-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); });
/** A fresh project folder holding these files. */
const project = (files: Record<string, string>) => {
  const path = mkdtempSync(join(root, 'project-'));
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), text); }
  return path;
};

describe('contextFilePaths', () => {
  it('uses résumé files in the project folder when CONTEXT_FILES is not set', () => {
    const dir = project({ 'AlexGuoResume (1).pdf': '%PDF', 'notes.txt': 'x', 'README.md': 'x', 'old-resume.exe': 'x' });
    expect(contextFilePaths(dir, dir, 'development')).toEqual([join(dir, 'AlexGuoResume (1).pdf')]);
  });

  it('uses CONTEXT_FILES instead, relative to the project or absolute, skipping files that are missing or unreadable', () => {
    const elsewhere = project({ 'job.md': 'The role' });
    const dir = project({ 'AlexGuoResume.pdf': '%PDF', 'context/notes.txt': 'x', '.env': `CONTEXT_FILES=context/notes.txt, ${join(elsewhere, 'job.md')}, missing.pdf, AlexGuoResume.pdf\n` });
    expect(contextFilePaths(dir, dir, 'development')).toEqual([join(dir, 'context/notes.txt'), join(elsewhere, 'job.md'), join(dir, 'AlexGuoResume.pdf')]);
    vi.stubEnv('CONTEXT_FILES', 'AlexGuoResume.pdf');
    expect(contextFilePaths(dir, dir, 'development')).toEqual([join(dir, 'AlexGuoResume.pdf')]); // The shell wins over .env.
  });
});

describe('contextFilesHandler', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const server of servers) server.close(); });
  async function serve(paths: string[]) {
    const server = createServer(contextFilesHandler(() => paths)); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('lists the files and serves only those', async () => {
    const dir = project({ 'AlexGuoResume.pdf': '%PDF-1.4 résumé', 'secret.txt': 'do not serve' });
    const url = await serve([join(dir, 'AlexGuoResume.pdf')]);
    expect(await (await fetch(url)).json()).toEqual({ files: [{ name: 'AlexGuoResume.pdf', size: Buffer.byteLength('%PDF-1.4 résumé') }] });
    const file = await fetch(`${url}?name=${encodeURIComponent('AlexGuoResume.pdf')}`);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(await file.text()).toBe('%PDF-1.4 résumé');
    expect((await fetch(`${url}?name=secret.txt`)).status).toBe(404);
    expect((await fetch(`${url}?name=${encodeURIComponent('../secret.txt')}`)).status).toBe(404);
  });

  it('refuses other websites', async () => {
    const url = await serve([]);
    expect((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });
});
