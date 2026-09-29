// Your default context files (your résumé, say), added to "Your context" whenever Roomside opens so you do not upload them
// every session. CONTEXT_FILES in .env lists them; without it, résumé files in the project folder are used. Only the dev
// server reads them, only the Roomside page on this computer receives them, and `npm run build` never includes them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { isLocalRequest } from './http';

const types: Record<string, string> = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown' };
const readable = (path: string) => { try { const stats = statSync(path); return stats.isFile() && stats.size <= 15 * 1024 * 1024 && extname(path).toLowerCase() in types; } catch { return false; } };

/** CONTEXT_FILES (comma-separated, relative to the project or absolute), or else the résumé files in the project folder. Read fresh each time, so edits apply on the next page load. */
export function contextFilePaths(root: string, envDir: string, mode: string) {
  const listed = loadEnv(mode, envDir, 'CONTEXT_').CONTEXT_FILES?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
  const paths = listed.length ? listed.map(item => isAbsolute(item) ? item : resolve(root, item))
    : readdirSync(root).filter(name => /r[eé]sum[eé]/iu.test(name)).sort().map(name => join(root, name));
  return paths.filter(readable).slice(0, 10);
}

/** GET: `{ files: [{ name, size }] }`; GET ?name=…: that file, if it is one of them. Nothing else on disk can be read. */
export function contextFilesHandler(paths: () => string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!isLocalRequest(req.headers, req.socket.remoteAddress)) return reply(403, { error: 'Only the Roomside page on this computer can read your context files.' });
    if (req.method !== 'GET') return reply(405, { error: 'Use GET.' });
    const files = paths(); const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name');
    if (name === null) return reply(200, { files: files.map(path => ({ name: basename(path), size: statSync(path).size })) });
    const path = files.find(item => basename(item) === name);
    if (!path) return reply(404, { error: 'Not one of your context files.' });
    res.writeHead(200, { 'Content-Type': types[extname(path).toLowerCase()], 'Cache-Control': 'no-store' }); res.end(readFileSync(path));
  };
}

/** Serves GET /api/context-files during `npm run dev`. */
export function contextFilesFromDisk(): Plugin {
  let paths = (): string[] => [];
  return {
    name: 'roomside-context-files',
    apply: 'serve',
    configResolved(config) { paths = () => contextFilePaths(config.root, config.envDir, config.mode); },
    configureServer(server) { server.middlewares.use('/api/context-files', contextFilesHandler(() => paths())); },
  };
}
