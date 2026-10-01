// Phone mirror: shows the live session on a phone on the same network, and relays the phone's taps and typed questions to the
// laptop page. The laptop page talks to it through the dev server (this computer only). Phones use a second server that runs
// only while mirroring is on and answers only under a random secret path, which changes every time mirroring starts.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { renderSVG } from 'uqr';
import { transformWithEsbuild, type Plugin } from 'vite';
import type { MirrorCommand, MirrorLink, MirrorStatus } from '../src/mirror';
import { isLocalRequest, readBody } from './http';

type Laptop = { id: string; tab: string; res: ServerResponse };

const simpleCommands = ['listen', 'stop', 'shorter', 'detailed', 'followup', 'regenerate', 'coach', 'topics', 'now', 'probe'];
const modes = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const question = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 2000 ? value.trim() : '';

/** Accepts only the commands the laptop page knows how to carry out. */
export function parseCommand(value: any): MirrorCommand | null {
  if (!value || typeof value !== 'object') return null;
  if (simpleCommands.includes(value.type)) return { type: value.type };
  if (value.type === 'ask' && question(value.text)) return { type: 'ask', text: question(value.text) };
  if (value.type === 'fix' && Number.isSafeInteger(value.entry) && value.entry >= 0 && question(value.text)) return { type: 'fix', entry: value.entry, text: question(value.text) };
  if (value.type === 'answer' && Number.isSafeInteger(value.line) && value.line > 0) return { type: 'answer', line: value.line };
  if (value.type === 'label' && Number.isSafeInteger(value.line) && value.line > 0 && (value.speaker === 'interviewer' || value.speaker === 'candidate')) return { type: 'label', line: value.line, speaker: value.speaker };
  // Answers are numbered from 0, the sample answer shown before anything is asked.
  if (value.type === 'pin' && Number.isSafeInteger(value.entry) && value.entry >= 0 && typeof value.on === 'boolean') return { type: 'pin', entry: value.entry, on: value.on };
  if (value.type === 'mode' && modes.includes(value.mode)) return { type: 'mode', mode: value.mode };
  return null;
}

/** IPv4 addresses a phone on the same network can reach, most likely first (Wi-Fi and Ethernet before VPNs and virtual adapters). */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()) {
  const rank = (name: string, address: string) => (/^(en|eth|wlan|wl)\d/.test(name) ? 0 : /^(utun|tun|tap|ppp|ipsec|bridge|vboxnet|vmnet|docker|br-|veth|awdl|llw)/.test(name) ? 4 : 2) + (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 0 : 1);
  const found: { address: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(interfaces)) for (const item of list ?? []) {
    if ((item.family === 'IPv4' || (item.family as unknown) === 4) && !item.internal && !item.address.startsWith('169.254.')) found.push({ address: item.address, rank: rank(name, item.address) });
  }
  return [...new Set(found.sort((a, b) => a.rank - b.rank).map(entry => entry.address))];
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const write = (res: ServerResponse, text: string) => { if (!res.writableEnded) res.write(text); };
function openStream(res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
}
/** Listens on every network interface, on the preferred port if it is free. */
function listen(server: Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    let fallback = port !== 0;
    server.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EADDRINUSE' && fallback) { fallback = false; server.listen(0, '0.0.0.0'); } else reject(error); });
    server.once('listening', () => resolve((server.address() as AddressInfo).port));
    server.listen(port, '0.0.0.0');
  });
}
const phoneHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const pageSecurity = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type MirrorOptions = { root: string; port?: number; addresses?: () => string[]; heartbeatMs?: number };

export class PhoneMirror {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private token = '';
  private links: MirrorLink[] = [];
  private laptops = new Set<Laptop>();
  private owner: Laptop | null = null;
  private phones = new Set<ServerResponse>();
  private state: unknown = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private lastBroadcast = '';
  private heartbeat: NodeJS.Timeout | null = null;
  private commandTimes: number[] = [];
  constructor(private options: MirrorOptions) {}

  get running() { return !!this.server; }
  private statusFor(laptop: Laptop | null, tab = ''): MirrorStatus {
    const owner = !this.owner ? 'none' : (laptop ? this.owner === laptop : this.owner.tab === tab) ? 'this' : 'other';
    return { running: this.running, owner, phones: this.phones.size, links: this.links };
  }

  async start() {
    if (this.server) return;
    this.starting ??= this.open().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async open() {
    const addresses = (this.options.addresses ?? lanAddresses)();
    if (!addresses.length) throw new Error('This computer is not connected to a network, so your phone cannot reach it. Connect to Wi-Fi and try again.');
    const server = createServer((req, res) => { this.handlePhone(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, phoneHeaders); res.end(); }); });
    const port = await listen(server, this.options.port ?? 5174);
    this.server = server; this.token = randomBytes(18).toString('base64url');
    this.links = addresses.map(address => { const url = `http://${address}:${port}/${this.token}/`; return { url, qr: renderSVG(url, { ecc: 'M', border: 2 }).replace('<svg ', '<svg shape-rendering="crispEdges" ') }; });
    // Keeps idle streams open through routers. Phones get an event they can see, so a silently dead connection (after the
    // screen locks or Wi-Fi changes) shows up as missing pings and they reconnect.
    this.heartbeat = setInterval(() => {
      for (const res of this.phones) write(res, event('ping', {}));
      for (const { res } of this.laptops) write(res, ': ping\n\n');
    }, this.options.heartbeatMs ?? 20_000); this.heartbeat.unref();
  }

  async stop() {
    await this.starting?.catch(() => undefined);
    const server = this.server; if (!server) return;
    this.server = null; this.token = ''; this.links = []; this.state = null; this.owner = null; this.dirty = false; this.lastBroadcast = '';
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.broadcastTimer) clearTimeout(this.broadcastTimer); this.heartbeat = this.broadcastTimer = null;
    for (const res of this.phones) { write(res, event('stopped', {})); res.end(); } this.phones.clear();
    for (const { res } of this.laptops) { write(res, event('stopped', {})); res.end(); } this.laptops.clear();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private broadcastStatus(except?: Laptop) { for (const laptop of this.laptops) if (laptop !== except) write(laptop.res, event('status', this.statusFor(laptop))); }
  /** Sends the latest state to phones at most every 80 ms (with a final update), however fast the answer streams. */
  private broadcastState() {
    if (this.broadcastTimer) { this.dirty = true; return; }
    const update = event('state', { laptop: !!this.owner, state: this.state });
    if (update === this.lastBroadcast) return;
    this.lastBroadcast = update; for (const res of this.phones) write(res, update);
    this.broadcastTimer = setTimeout(() => { this.broadcastTimer = null; if (this.dirty) { this.dirty = false; this.broadcastState(); } }, 80);
  }
  private setOwner(laptop: Laptop | null) { if (this.owner !== laptop) { this.owner = laptop; this.broadcastStatus(); this.broadcastState(); } }

  private connectLaptop(res: ServerResponse, tab: string) {
    const laptop: Laptop = { id: randomBytes(12).toString('base64url'), tab, res };
    openStream(res); this.laptops.add(laptop);
    // The first tab to connect is mirrored; so is a reloaded tab whose earlier page was.
    const claimed = !this.owner; if (claimed) this.owner = laptop;
    write(res, event('hello', { connection: laptop.id, status: this.statusFor(laptop) }));
    if (claimed) { this.broadcastStatus(laptop); this.broadcastState(); }
    res.on('close', () => {
      if (!this.laptops.delete(laptop) || this.owner !== laptop) return;
      this.setOwner([...this.laptops].find(other => other.tab === laptop.tab) ?? null);
    });
  }

  /** The laptop page's endpoints, under /api/mirror on the dev server. */
  async handleLaptop(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!isLocalRequest(req.headers, req.socket.remoteAddress)) return reply(403, { error: 'Only the Roomside page on this computer can control the phone mirror.' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/status') return reply(200, this.statusFor(null, url.searchParams.get('tab') ?? ''));
    if (req.method === 'GET' && url.pathname === '/events') return this.running ? this.connectLaptop(res, url.searchParams.get('tab') ?? '') : reply(409, { error: 'The phone mirror is off.' });
    if (req.method !== 'POST') return reply(404, { error: 'Not found.' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'Send JSON.' });
    let body: any; try { body = JSON.parse(await readBody(req, 500_000)) ?? {}; } catch { return reply(400, { error: 'Invalid request.' }); }
    const tab = typeof body.tab === 'string' ? body.tab : '';
    if (url.pathname === '/start') {
      try { await this.start(); } catch (error: any) { return reply(500, { error: error?.code === 'EACCES' || error?.code === 'EADDRNOTAVAIL' ? 'This computer did not allow the phone mirror to open a network port.' : error?.message || 'Could not start the phone mirror.' }); }
      return reply(200, this.statusFor(null, tab));
    }
    if (url.pathname === '/stop') { await this.stop(); return reply(200, this.statusFor(null, tab)); }
    if (url.pathname === '/claim') {
      const laptop = [...this.laptops].find(item => item.id === body.connection);
      if (!laptop) return reply(409, { error: 'The phone mirror is off, or this tab lost its connection. Reload the page.' });
      this.setOwner(laptop); return reply(200, this.statusFor(laptop));
    }
    if (url.pathname === '/state') {
      if (!this.owner || this.owner.id !== body.connection) return reply(409, { error: 'Another Roomside tab is mirrored to your phone.' });
      this.state = body.state && typeof body.state === 'object' ? body.state : null; this.broadcastState();
      res.writeHead(204); res.end(); return;
    }
    return reply(404, { error: 'Not found.' });
  }

  private phoneFile(name: string) { return readFile(join(this.options.root, 'src', 'phone', name), 'utf8'); }

  /** The phone's endpoints, on the network server, all under /<secret>/. Anything else gets the same plain 404. */
  async handlePhone(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => { res.writeHead(status, { ...phoneHeaders, 'Content-Type': type, ...extra }); res.end(body); };
    const json = (status: number, body: object) => send(status, 'application/json', JSON.stringify(body));
    const [, token = '', file = null, ...rest] = new URL(req.url ?? '/', 'http://phone').pathname.split('/');
    if (!this.token || !sameSecret(token, this.token) || rest.length) return send(404, 'text/plain; charset=utf-8', 'Not found');
    if (file === null) { res.writeHead(308, { ...phoneHeaders, Location: `/${token}/` }); res.end(); return; }
    if (req.method === 'GET' && file === '') return send(200, 'text/html; charset=utf-8', await this.phoneFile('phone.html'), { 'Content-Security-Policy': pageSecurity });
    if (req.method === 'GET' && file === 'phone.css') return send(200, 'text/css; charset=utf-8', await this.phoneFile('phone.css'));
    if (req.method === 'GET' && file === 'phone.js') {
      const path = join(this.options.root, 'src', 'phone', 'phone.ts');
      const { code } = await transformWithEsbuild(await readFile(path, 'utf8'), path, { loader: 'ts', format: 'esm', target: 'es2020' });
      return send(200, 'text/javascript; charset=utf-8', code);
    }
    if (req.method === 'GET' && file === 'ping') { res.writeHead(204, phoneHeaders); res.end(); return; }
    if (req.method === 'GET' && file === 'events') {
      if (this.phones.size >= 6) return json(429, { error: 'Too many phones are connected.' });
      openStream(res); this.phones.add(res);
      write(res, event('state', { laptop: !!this.owner, state: this.state }));
      this.broadcastStatus();
      res.on('close', () => { if (this.phones.delete(res)) this.broadcastStatus(); });
      return;
    }
    if (req.method === 'POST' && file === 'command') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Send JSON.' });
      let command: MirrorCommand | null = null; try { command = parseCommand(JSON.parse(await readBody(req, 8_000))); } catch { /* Invalid below. */ }
      if (!command) return json(400, { error: 'That command is not supported.' });
      if (!this.owner) return json(409, { error: 'Roomside is not open on your laptop. Open it there to continue.' });
      // Every question costs Claude usage, so a stuck button or a flood of requests cannot run it up.
      const now = Date.now(); this.commandTimes = this.commandTimes.filter(at => now - at < 10_000);
      if (this.commandTimes.length >= 20) return json(429, { error: 'Too many requests at once. Wait a few seconds and try again.' });
      this.commandTimes.push(now);
      write(this.owner.res, event('command', command));
      return json(202, {});
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found');
  }
}

/** Serves /api/mirror/* to the laptop page during `npm run dev`; the phone server itself starts only when you turn mirroring on. */
export function phoneMirror(): Plugin {
  return {
    name: 'roomside-phone-mirror',
    apply: 'serve',
    configureServer(server) {
      const mirror = new PhoneMirror({ root: server.config.root });
      server.middlewares.use('/api/mirror', (req, res) => { mirror.handleLaptop(req, res).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); }); });
      server.httpServer?.once('close', () => { void mirror.stop(); });
    },
  };
}
