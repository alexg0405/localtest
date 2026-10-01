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
  top: document.querySelector<HTMLElement>('.top')!, spacer: byId('spacer'), dock: byId('dock'), steps: byId('steps'), previous: byId<HTMLButtonElement>('previous'), next: byId<HTMLButtonElement>('next'), position: byId('position'),
};

let state: MirrorState | null = null;
let laptop = false; let connected = false; let ended: '' | 'stopped' | 'expired' = '';
let flash = ''; let flashTimer = 0; let pending = false;
let shownTranscript = '';
// The running list: each card is rebuilt only when its content changes, and the others stay in the page, so reading or
// selecting an earlier answer is not disturbed.
const cards = new Map<number, { key: string; card: HTMLElement }>(); let newestId = -1; let following = true;
// The answer a tap on Previous, Next, or New answer is scrolling to, until the scroll has had time to get there.
let stepping: { index: number; until: number } | null = null;
// The scroll position the page was last moved to for keeping your place, so that move is not taken for your scrolling.
let adjusted = -1;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const show = (node: HTMLElement, text: string) => { node.textContent = text; node.hidden = !text; };
const emptyFeed = make('p', 'empty-feed', 'Answers will appear here, newest at the bottom, as questions come in.');
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
  if (live?.topic) { const topic = make('div', 'topic'); topic.append(make('div', 'eyebrow', 'Main question'), make('p', 'title', live.topic.title)); if (live.topic.question !== live.topic.title) topic.append(make('p', '', live.topic.question)); card.prepend(topic); }
  if (live?.coach) {
    const { key, points, tip, busy, after, missing } = live.coach;
    const coach = make('div', busy ? 'coach busy' : 'coach'); const head = make('div', 'coach-head');
    // Fresh tips for this question, like the refresh button beside the coach on the laptop.
    const refresh = make('button', 'coach-refresh', '↻'); refresh.type = 'button'; refresh.disabled = !!busy; refresh.setAttribute('aria-label', 'Get fresh coaching tips');
    head.append(make('div', 'eyebrow', 'Coach'), make('span', 'coach-status', busy ? key ? 'Updating…' : 'Reading the question…' : after ? `after “${after}”` : 'for this question'), refresh);
    coach.append(head);
    if (key) {
      coach.append(make('p', 'key', key));
      if (points.length) { const list = make('ul'); for (const point of points) list.append(make('li', '', point)); coach.append(list); }
      if (tip) coach.append(make('p', 'tip', tip));
    } else { const typing = make('div', 'typing'); typing.append(make('i'), make('i'), make('i')); coach.append(typing); }
    if (missing) coach.append(make('p', 'coach-missing', missing));
    card.append(coach);
  }
  card.append(make('div', 'eyebrow answer-label', `${entry.kind === 'followup' ? 'Likely follow-up' : 'Response'} · ${entry.mode}`), answer);
  if (live?.status) card.append(make('div', 'status', live.status));
  return card;
}
const newestCard = () => cards.get(newestId)?.card;
const shownCards = () => [...ui.feed.querySelectorAll<HTMLElement>('.entry')];
// The answer whose top has come up to just under the header is the one you are on; you read a little above the middle.
const headerLine = () => ui.top.getBoundingClientRect().bottom + 24;
const readingLine = () => window.innerHeight * 0.4;
const steppingTo = () => stepping && Date.now() < stepping.until ? stepping.index : null;
function onIndex(list: HTMLElement[]) {
  const line = headerLine(); let index = 0;
  list.forEach((card, at) => { if (card.getBoundingClientRect().top <= line) index = at; });
  return index;
}
// You follow the newest answer while it has come up into the top part of the screen and is still showing.
function onNewest(list: HTMLElement[]) {
  const target = steppingTo(); if (target !== null) return target === list.length - 1;
  const box = list[list.length - 1]?.getBoundingClientRect(); return !box || (box.top <= readingLine() && box.bottom > headerLine());
}
function jumpToNewest(smooth = true) {
  const card = newestCard(); if (!card) return;
  if (smooth) stepping = { index: shownCards().indexOf(card), until: Date.now() + 900 };
  card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); following = true; ui.jump.hidden = true;
}
// Up goes to the start of the answer you are in, or to the one before once you are at its start; down goes to the next.
function step(by: 1 | -1) {
  const list = shownCards(); const line = headerLine(); const target = steppingTo(); let index = -1;
  if (target !== null) index = target + by;
  else if (by > 0) index = list.findIndex(card => card.getBoundingClientRect().top > line);
  else list.forEach((card, at) => { if (card.getBoundingClientRect().top < line - 30) index = at; });
  if (index < 0 || index >= list.length) return;
  stepping = { index, until: Date.now() + 900 }; following = index === list.length - 1; if (following) ui.jump.hidden = true;
  list[index].scrollIntoView({ behavior: 'smooth', block: 'start' }); showSteps(list);
}
function showSteps(list = shownCards()) {
  ui.steps.hidden = list.length < 2; if (ui.steps.hidden) return;
  const line = headerLine(); const target = steppingTo(); const total = Math.max(state?.total ?? 0, list.length);
  ui.position.textContent = `Question ${total - list.length + (target ?? onIndex(list)) + 1} of ${total}`;
  ui.previous.disabled = target !== null ? target === 0 : !list.some(card => card.getBoundingClientRect().top < line - 30);
  ui.next.disabled = target !== null ? target === list.length - 1 : !list.some(card => card.getBoundingClientRect().top > line);
}

type Place = { id: number; answer: boolean; top: number };
/** Where you are reading: the answer at the reading line, and where its card starts on screen. Once you have scrolled into
 * the answer (the card's top gone under the header), it is the answer's text instead, so the coach or main question above
 * it changing does not move what you read. */
function readingPlace(): Place | null {
  if (window.scrollY <= 0) return null;
  const line = readingLine(); let card: HTMLElement | undefined;
  for (const item of shownCards()) { if (item.getBoundingClientRect().top > line) break; card = item; }
  if (!card) return null;
  const top = card.getBoundingClientRect().top; const text = card.querySelector<HTMLElement>('.answer')?.getBoundingClientRect().top;
  return text !== undefined && text <= line && top < headerLine() - 30 ? { id: Number(card.dataset.entry), answer: true, top: text } : { id: Number(card.dataset.entry), answer: false, top };
}
/** Scrolls by however far that place moved, so what you were reading stays where it was. */
function keepPlace(place: Place | null) {
  const card = place && cards.get(place.id)?.card; if (!place || !card?.isConnected) return;
  const shift = ((place.answer && card.querySelector<HTMLElement>('.answer')) || card).getBoundingClientRect().top - place.top;
  if (Math.abs(shift) >= 1) { window.scrollBy(0, shift); adjusted = window.scrollY; }
}
// Room below the newest answer, so however short it is it can come up under the header, with the screen to fill.
function fitSpacer() {
  const newest = newestCard(); if (!newest?.isConnected) { ui.spacer.style.height = '0px'; return; }
  const below = ui.spacer.getBoundingClientRect().top - newest.getBoundingClientRect().top;
  const kept = (parseFloat(getComputedStyle(newest).scrollMarginTop) || 0) + (parseFloat(getComputedStyle(document.body).paddingBottom) || 0);
  ui.spacer.style.height = `${Math.max(0, Math.floor(window.innerHeight - kept - below))}px`;
}

function render() {
  // What you are reading stays where it is on screen while things above it change size (the line just heard, a notice,
  // the coach over the answer) and new answers arrive.
  const place = readingPlace();
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
    const key = JSON.stringify([entry, live && [live.generating, live.answerError, live.status, live.coach, live.topic]]);
    let item = cards.get(entry.id); if (!item || item.key !== key) { item = { key, card: entryCard(entry, live) }; cards.set(entry.id, item); }
    kept.add(entry.id); nodes.push(item.card);
  });
  for (const id of cards.keys()) if (!kept.has(id)) cards.delete(id);
  // Only the cards that changed are swapped in; the rest stay in the page, and so does a selection in them.
  const shown = nodes.length ? nodes : [emptyFeed];
  for (const child of [...ui.feed.children]) if (!shown.includes(child as HTMLElement)) child.remove();
  shown.forEach((node, index) => { if (ui.feed.children[index] !== node) ui.feed.insertBefore(node, ui.feed.children[index] ?? null); });
  document.body.classList.toggle('stepping', nodes.length > 1);
  for (const button of ui.feed.querySelectorAll<HTMLButtonElement>('.coach-refresh')) button.disabled = !live || !!state.coach?.busy;

  const transcript = JSON.stringify([state.heard, state.interim]);
  if (transcript !== shownTranscript) {
    shownTranscript = transcript;
    const lines = state.heard.map(line => {
      // A tap on a line answers it, like ↵ beside it on the laptop.
      const row = make(line.id ? 'button' : 'div', `line ${line.speaker ?? ''}`); const words = make('span');
      if (row instanceof HTMLButtonElement) { row.type = 'button'; row.dataset.line = String(line.id); row.title = 'Answer this line'; }
      if (line.speaker) words.append(make('b', 'who', line.speaker === 'interviewer' ? 'Interviewer' : 'You'));
      words.append(line.text); row.append(make('time', '', line.time), words); return row;
    });
    if (state.interim) { const row = make('div', 'line interim'); row.append(make('time', '', 'live'), make('span', '', state.interim)); lines.push(row); }
    ui.transcript.replaceChildren(...(lines.length ? lines : [make('p', 'empty', 'Nothing heard yet.')]));
  }
  ui.provider.textContent = state.provider;

  // Follow a new answer if you were on the newest one; otherwise keep your place and offer a jump.
  const newest = state.entries[state.entries.length - 1]; const arrived = !!newest && newest.id !== newestId; if (newest) newestId = newest.id;
  fitSpacer();
  if (arrived && following) jumpToNewest(false); // Snaps: a locked phone may not run the smooth animation.
  else { if (arrived) ui.jump.hidden = false; if (steppingTo() === null) keepPlace(place); }
  showSteps();
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
ui.previous.addEventListener('click', () => step(-1));
ui.next.addEventListener('click', () => step(1));
window.addEventListener('scroll', () => {
  const own = Math.abs(window.scrollY - adjusted) < 1; adjusted = -1;
  if (!own) { following = onNewest(shownCards()); if (following) ui.jump.hidden = true; }
  showSteps();
}, { passive: true });
// Scrolling yourself takes over from a tap that is still on its way.
window.addEventListener('touchstart', event => { if (!ui.dock.contains(event.target as Node)) stepping = null; }, { passive: true });
window.addEventListener('resize', () => { fitSpacer(); showSteps(); });
ui.transcript.closest('details')?.addEventListener('toggle', fitSpacer);
for (const button of ui.actions.querySelectorAll('button')) button.addEventListener('click', () => void send({ type: button.dataset.command } as MirrorCommand));
// The coach's refresh is rebuilt with its card, so it is handled here; the next state shows the coach at work.
ui.feed.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.coach-refresh'); if (!button || button.disabled) return;
  button.disabled = true; void send({ type: 'coach' });
});
ui.transcript.addEventListener('click', async event => {
  const row = (event.target as Element).closest<HTMLButtonElement>('button[data-line]'); if (!row) return;
  row.classList.add('sent'); window.setTimeout(() => row.classList.remove('sent'), 1500);
  // Up to the live answer, which then follows the line being answered.
  if (await send({ type: 'answer', line: Number(row.dataset.line) })) jumpToNewest();
});
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
