// Hands the Roomside page the Deepgram API key from your .env file (DEEPGRAM_API_KEY), so you do not paste it into Settings
// every session. Only the dev server reads it: it is never part of `npm run build`, and only the page on this computer gets it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { isLocalRequest } from './http';

/** DEEPGRAM_API_KEY from the environment or the .env files in `envDir`, read fresh so edits apply on the next page load. */
export const readDeepgramKey = (envDir: string, mode: string) => loadEnv(mode, envDir, 'DEEPGRAM_').DEEPGRAM_API_KEY?.trim() ?? '';

/** GET: `{ key }` for the Roomside page on this computer, with an empty key when none is set. */
export function deepgramKeyHandler(readKey: () => string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!isLocalRequest(req.headers, req.socket.remoteAddress)) return reply(403, { error: 'Only the Roomside page on this computer can read the Deepgram key.' });
    if (req.method !== 'GET') return reply(405, { error: 'Use GET.' });
    reply(200, { key: readKey() });
  };
}

/** Serves GET /api/deepgram-key during `npm run dev`. */
export function deepgramKeyFromEnv(): Plugin {
  let readKey = () => '';
  return {
    name: 'roomside-deepgram-key',
    apply: 'serve',
    configResolved(config) { readKey = () => readDeepgramKey(config.envDir, config.mode); },
    configureServer(server) { server.middlewares.use('/api/deepgram-key', deepgramKeyHandler(() => readKey())); },
  };
}
