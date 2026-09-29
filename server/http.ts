// Request helpers shared by the dev-server endpoints.
import type { IncomingMessage } from 'node:http';

const loopback = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/;

/** Accepts only same-origin requests from this computer, so other websites and devices cannot use these endpoints. */
export function isLocalRequest(headers: IncomingMessage['headers'], remoteAddress: string | undefined) {
  // Another device can send any Host header if the dev server is ever started on the network (`vite --host`).
  if (!loopback.test(remoteAddress ?? '')) return false;
  const host = headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  if (headers.origin && headers.origin !== `http://${host}`) return false;
  const site = headers['sec-fetch-site'];
  return !site || site === 'same-origin';
}

export const readBody = (req: IncomingMessage, limit: number) => new Promise<string>((resolve, reject) => {
  let data = ''; req.setEncoding('utf8');
  req.on('data', (chunk: string) => { data += chunk; if (data.length > limit) { reject(new Error('Request too large.')); req.destroy(); } });
  req.on('end', () => resolve(data)); req.on('error', reject);
});
