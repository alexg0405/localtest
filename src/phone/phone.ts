// Roomside on your phone, served by server/phone-mirror.ts. The laptop listens and writes the answers; this page shows its
// session as it changes and sends taps and typed questions back. Only type imports here: the server sends this file as-is.
import type { MirrorBlock, MirrorCommand, MirrorEntry, MirrorState } from '../mirror';
import type { Mode } from '../providers';
import type { InlineSegment } from '../text';

const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const listeningLabels = { off: 'Mic off', starting: 'Starting…', on: 'Listening', voice: 'Voice detected' };
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  connection: byId('connection'), banner: byId('banner'), mic: byId('mic'), micLabel: byId('mic-label'), listen: byId<HTMLButtonElement>('listen'),
  heardLine: byId('heard-line'), micMessage: byId('mic-message'), feed: byId('feed'), jump: byId<HTMLButtonElement>('jump'), modes: byId('modes'), actions: byId('actions'),
  transcript: byId('transcript'), provider: byId('provider'), ask: byId<HTMLFormElement>('ask'), askInput: byId<HTMLInputElement>('ask-input'), askSend: byId<HTMLButtonElement>('ask-send'),
};

let state: MirrorState | null = null;
let laptop = false; let connected = false; let ended: '' | 'stopped' | 'expired' = '';
let flash = ''; let flashTimer = 0; let pending = false;
let shownTranscript = '';
// The running list: each card is rebuilt only when its content changes, so reading or selecting an earlier answer is not disturbed.
const cards = new Map<number, { key: string; card: HTMLElement }>(); let newestId = -1; let following = true;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const show = (node: HTMLElement, text: string) => { node.textContent = text; node.hidden = !text; };
function inline(parent: HTMLElement, segments: InlineSegment[]) {
  for (const segment of segments) parent.append(segment.bold || segment.code ? make(segment.bold ? 'b' : 'code', '', segment.text) : segment.text);
  return parent;
}
function block(item: MirrorBlock): HTMLElement {
  if (item.type === 'code') { const pre = make('pre'); pre.append(make('code', '', item.text)); return pre; }
  if (item.type === 'heading') return inline(make('h4'), item.segments);
  if (item.type === 'bullet') { const row = make('div', 'bullet'); row.append(inline(make('span'), item.segments)); return row; }
  if (item.type === 'label') { const line = make('p'); line.append(make('b', '', `${item.label}: `)); return inline(line, item.segments); }
  return inline(make('p'), item.segments);
}

function entryCard(entry: MirrorEntry, live: MirrorState | null) {
  const card = make('article', 'card entry'); card.dataset.entry = String(entry.id);
  const head = make('div', 'eyebrow'); head.append(make('span', '', entry.possible ? 'Possible question' : 'Question'));
  if (entry.time) head.append(make('time', '', entry.time));
  if (entry.tag) head.append(make('span', 'tag', entry.tag));
  const answer = make('div', 'answer'); answer.append(...entry.blocks.map(block));
  if (live && !entry.blocks.length && !live.answerError) answer.append(make('p', 'muted', live.generating ? 'Preparing response…' : 'Your answer will appear here.'));
  if (live?.answerError) answer.append(make('div', 'error', live.answerError));
  answer.classList.toggle('writing', !!live?.generating && entry.blocks.length > 0);
  card.append(head, make('p', 'question', entry.question || 'Waiting for a question…'));
  if (live?.points?.length) { const points = make('div', 'points'); points.append(make('div', 'eyebrow', 'Key points to hit'), ...live.points.map(block)); card.append(points); }
  card.append(make('div', 'eyebrow answer-label', `${entry.kind === 'followup' ? 'Likely follow-up' : 'Response'} · ${entry.mode}`), answer);
  if (live?.status) card.append(make('div', 'status', live.status));
  return card;
}
const newestCard = () => cards.get(newestId)?.card;
const inView = (card?: HTMLElement) => { if (!card) return true; const box = card.getBoundingClientRect(); return box.bottom > 60 && box.top < window.innerHeight - 80; };
function jumpToNewest(smooth = true) { newestCard()?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); following = true; ui.jump.hidden = true; }

function render() {
  const live = !!state && laptop && connected && !ended;
  ui.connection.textContent = ended === 'expired' ? 'Link expired' : ended ? 'Mirror off' : !connected ? 'Reconnecting…' : laptop ? 'Connected' : 'Laptop closed';
  ui.connection.className = `connection ${live ? 'live' : ended || !connected || !laptop ? 'problem' : ''}`;
  show(ui.banner, ended === 'expired' ? "This link has expired. Open the Phone panel in Roomside on your laptop and scan the new code."
    : ended ? 'Phone mirroring was turned off on your laptop. Turn it on again there and scan the new code.'
      : !connected ? 'Cannot reach your laptop. Keep both on the same Wi-Fi; this page keeps trying.'
        : !laptop ? 'Roomside is not open on your laptop. This page reconnects when you open it there.' : flash);
  ui.askSend.disabled = !live;
  for (const button of ui.modes.querySelectorAll('button')) { button.disabled = !live; button.classList.toggle('active', button.dataset.mode === state?.mode); button.setAttribute('aria-pressed', String(button.dataset.mode === state?.mode)); }
  const current = state?.live ? state.entries[state.entries.length - 1] : undefined;
  for (const button of ui.actions.querySelectorAll('button')) button.disabled = !live || !current?.question;
  if (!state) { ui.listen.disabled = true; return; }

  ui.mic.className = `mic ${state.listening}`; ui.micLabel.textContent = listeningLabels[state.listening];
  ui.listen.textContent = state.listening === 'off' ? 'Start listening' : 'Stop listening';
  ui.listen.classList.toggle('stop', state.listening !== 'off'); ui.listen.disabled = !live || pending;
  const heard = state.interim || state.heard[state.heard.length - 1]?.text || '';
  show(ui.heardLine, state.listening !== 'off' ? heard : '');
  show(ui.micMessage, state.micError || state.notice);

  const nodes: HTMLElement[] = []; const kept = new Set<number>();
  state.entries.forEach((entry, index) => {
    const live = state!.live && index === state!.entries.length - 1 ? state : null;
    const key = JSON.stringify([entry, live && [live.generating, live.answerError, live.status, live.points]]);
    let item = cards.get(entry.id); if (!item || item.key !== key) { item = { key, card: entryCard(entry, live) }; cards.set(entry.id, item); }
    kept.add(entry.id); nodes.push(item.card);
  });
  for (const id of cards.keys()) if (!kept.has(id)) cards.delete(id);
  ui.feed.replaceChildren(...(nodes.length ? nodes : [make('p', 'empty-feed', 'Answers will appear here, newest at the bottom, as questions come in.')]));
  // Follow a new answer if you were reading the newest one; otherwise leave your place and offer a jump.
  const newest = state.entries[state.entries.length - 1];
  if (newest && newest.id !== newestId) { newestId = newest.id; if (following) jumpToNewest(false); else ui.jump.hidden = false; } // Snaps: a locked phone may not run the smooth animation.

  const transcript = JSON.stringify([state.heard, state.interim]);
  if (transcript !== shownTranscript) {
    shownTranscript = transcript;
    const lines = state.heard.map(line => {
      const row = make('div', `line ${line.speaker ?? ''}`); const words = make('span');
      if (line.speaker) words.append(make('b', 'who', line.speaker === 'interviewer' ? 'Interviewer' : 'You'));
      words.append(line.text); row.append(make('time', '', line.time), words); return row;
    });
    if (state.interim) { const row = make('div', 'line interim'); row.append(make('time', '', 'live'), make('span', '', state.interim)); lines.push(row); }
    ui.transcript.replaceChildren(...(lines.length ? lines : [make('p', 'empty', 'Nothing heard yet.')]));
  }
  ui.provider.textContent = state.provider;
}

function notify(message: string) { flash = message; window.clearTimeout(flashTimer); flashTimer = window.setTimeout(() => { flash = ''; render(); }, 5000); render(); }
async function send(command: MirrorCommand) {
  try {
    const response = await fetch('command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) notify((await response.json().catch(() => null))?.error || 'Your laptop did not accept that. Try again.');
    return response.ok;
  } catch { notify('Could not reach your laptop. Check that your phone is on the same Wi-Fi.'); return false; }
}

ui.listen.addEventListener('click', async () => {
  if (!state) return;
  // Wait for the laptop to report the change rather than guessing; the button stays disabled until then.
  pending = true; render(); const listening = state.listening;
  if (!await send({ type: listening === 'off' ? 'listen' : 'stop' }) || state.listening !== listening) { pending = false; render(); }
  else window.setTimeout(() => { pending = false; render(); }, 4000);
});
for (const mode of modes) {
  const button = make('button', '', mode); button.type = 'button'; button.dataset.mode = mode;
  button.addEventListener('click', () => void send({ type: 'mode', mode })); ui.modes.append(button);
}
ui.jump.addEventListener('click', () => jumpToNewest());
window.addEventListener('scroll', () => { following = inView(newestCard()); if (following) ui.jump.hidden = true; }, { passive: true });
for (const button of ui.actions.querySelectorAll('button')) button.addEventListener('click', () => void send({ type: button.dataset.command } as MirrorCommand));
ui.ask.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.askInput.value.trim(); if (!text) return;
  if (await send({ type: 'ask', text })) { ui.askInput.value = ''; ui.askInput.blur(); }
});

// EventSource reconnects on its own after brief drops, but gives up after a refused request or when a locked phone suspends
// it, so reconnect by hand and check first whether the link still exists.
let source: EventSource | null = null; let retryTimer = 0; let attempts = 0; let lastHeard = Date.now();
function connect() {
  window.clearTimeout(retryTimer); source?.close(); lastHeard = Date.now();
  const current = new EventSource('events'); source = current;
  current.addEventListener('open', () => { attempts = 0; connected = true; lastHeard = Date.now(); render(); });
  current.addEventListener('ping', () => { lastHeard = Date.now(); });
  current.addEventListener('state', event => {
    const data = JSON.parse((event as MessageEvent).data); lastHeard = Date.now();
    const listening = state?.listening; laptop = data.laptop; if (data.state) state = data.state;
    if (state?.listening !== listening) pending = false;
    render();
  });
  current.addEventListener('stopped', () => { ended = 'stopped'; current.close(); render(); });
  current.addEventListener('error', () => {
    if (ended || source !== current) return;
    current.close(); connected = false; render();
    retryTimer = window.setTimeout(async () => {
      const status = await fetch('ping', { cache: 'no-store' }).then(response => response.status, () => 0);
      if (status === 404) { ended = 'expired'; render(); } else connect();
    }, Math.min(8000, 1000 * 2 ** attempts++));
  });
}
// The laptop pings every 20 s. Silence for 45 s means the connection died without an error (a locked screen, a Wi-Fi change).
const stale = () => Date.now() - lastHeard > 45_000;
window.setInterval(() => { if (!ended && connected && stale()) { connected = false; render(); connect(); } }, 10_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ended && (!connected || stale())) connect(); });
connect(); render();
