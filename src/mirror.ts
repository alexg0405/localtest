// Phone mirror, laptop side: shares this session with a phone through the dev server (server/phone-mirror.ts) and carries
// out the phone's commands. The phone only ever receives text; listening still happens on this computer's microphone.
import type { Mode } from './providers';
import { inlineSegments, type AnswerBlock, type InlineSegment } from './text';

export type MirrorBlock = { type: 'heading' | 'bullet' | 'paragraph'; segments: InlineSegment[] } | { type: 'label'; label: string; segments: InlineSegment[] } | { type: 'code'; text: string };
/** What the phone shows. The laptop sends it whenever it changes. */
export type MirrorState = {
  listening: 'off' | 'starting' | 'on' | 'voice'; micError: string; notice: string;
  question: string; tag: string; possible: boolean; kind: 'answer' | 'followup'; answerMode: Mode; mode: Mode;
  blocks: MirrorBlock[]; generating: boolean; status: string; answerError: string;
  heard: { time: string; text: string; speaker?: 'interviewer' | 'candidate' }[]; interim: string; provider: string;
};
export type MirrorCommand = { type: 'listen' | 'stop' | 'shorter' | 'detailed' | 'followup' | 'regenerate' } | { type: 'ask'; text: string } | { type: 'mode'; mode: Mode };
export type MirrorLink = { url: string; qr: string };
/** `owner` says which tab the phone mirrors: this one, another Roomside tab, or none yet. */
export type MirrorStatus = { running: boolean; owner: 'this' | 'other' | 'none'; phones: number; links: MirrorLink[] };

/** Answer blocks with their bold and code spans already split out, so the phone page does not need the parser. */
export const mirrorBlocks = (blocks: AnswerBlock[]): MirrorBlock[] => blocks.map(block =>
  block.type === 'code' ? { type: 'code', text: block.text } : block.type === 'label' ? { type: 'label', label: block.label, segments: inlineSegments(block.text) } : { type: block.type, segments: inlineSegments(block.text) });

const newId = () => typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Survives reloads of this tab, so a reload keeps mirroring to the phone instead of handing it to another tab. */
const tabId = (() => { try { const saved = sessionStorage.getItem('roomside.tab'); if (saved) return saved; const id = newId(); sessionStorage.setItem('roomside.tab', id); return id; } catch { return newId(); } })();

/** Null when the phone mirror is unavailable (it needs the dev server). */
export async function mirrorStatus(): Promise<MirrorStatus | null> {
  try { const response = await fetch(`/api/mirror/status?tab=${encodeURIComponent(tabId)}`); return response.ok ? await response.json() : null; } catch { return null; }
}
async function post(path: string, body: object = {}): Promise<MirrorStatus> {
  let response: Response;
  try { response = await fetch(`/api/mirror/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab: tabId, ...body }) }); }
  catch { throw new Error('Could not reach the Roomside dev server. Start it with npm start.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export const startMirror = () => post('start');
export const stopMirror = () => post('stop');

type Handlers = { status(status: MirrorStatus): void; command(command: MirrorCommand): void; stopped(): void };

/** The live link to the mirror while it runs: receives status and phone commands, and sends this tab's state when it is the one mirrored. */
export class MirrorConnection {
  private source: EventSource;
  private connection = '';
  private owner = false;
  private sent = '';
  private pending: string | null = null;
  private sending = false;
  constructor(private handlers: Handlers) {
    this.source = new EventSource(`/api/mirror/events?tab=${encodeURIComponent(tabId)}`);
    this.source.addEventListener('hello', event => { const data = JSON.parse((event as MessageEvent).data); this.connection = data.connection; this.sent = ''; this.update(data.status); });
    this.source.addEventListener('status', event => this.update(JSON.parse((event as MessageEvent).data)));
    this.source.addEventListener('command', event => { if (this.owner) handlers.command(JSON.parse((event as MessageEvent).data)); });
    this.source.addEventListener('stopped', () => { this.close(); handlers.stopped(); });
    // The server refuses the stream once mirroring is off (for example after it restarted); EventSource then gives up.
    this.source.onerror = () => { if (this.source.readyState === EventSource.CLOSED) { this.owner = false; handlers.stopped(); } };
  }
  private update(status: MirrorStatus) {
    const owner = status.owner === 'this'; if (owner && !this.owner) this.sent = ''; // Send everything again to a new owner.
    this.owner = owner; this.handlers.status(status);
  }
  /** Mirrors this tab instead of the one currently mirrored. */
  async claim() { this.update(await post('claim', { connection: this.connection })); }
  /** Sends the state if it changed; while a send is in flight only the newest state waits, so the phone never falls behind. */
  publish(state: MirrorState) {
    if (!this.owner || !this.connection) return;
    const json = JSON.stringify(state); if (json === (this.pending ?? this.sent)) return;
    this.pending = json; void this.flush();
  }
  private async flush() {
    if (this.sending) return;
    this.sending = true;
    while (this.pending !== null && this.owner) {
      const json = this.pending; this.pending = null;
      try {
        const response = await fetch('/api/mirror/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"connection":${JSON.stringify(this.connection)},"state":${json}}` });
        if (response.ok) this.sent = json; else if (response.status === 409) this.owner = false; // Another tab took over; a status event follows.
      } catch { /* The dev server is restarting; its next hello sends everything again. */ }
    }
    this.sending = false;
  }
  close() { this.owner = false; this.pending = null; this.source.close(); }
}
