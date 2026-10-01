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
  pinned: byId('pinned'), pinJump: byId<HTMLButtonElement>('pin-jump'),
};

let state: MirrorState | null = null;
let laptop = false; let connected = false; let ended: '' | 'stopped' | 'expired' = '';
let flash = ''; let flashTimer = 0; let pending = false;
let shownTranscript = '';
// The running list: each card is rebuilt only when its content changes, and the others stay in the page, so reading or
// selecting an earlier answer is not disturbed.
const cards = new Map<number, { key: string; card: HTMLElement; fixing: boolean }>(); let newestId = -1; let following = true;
// The answer a tap on Previous, Next, or New answer is scrolling to, until the scroll has had time to get there.
let stepping: { index: number; until: number } | null = null;
// The scroll position the page was last moved to for keeping your place, so that move is not taken for your scrolling.
let adjusted = -1;
// The pinned answer above the list, open when the list does not have its card; and what it last showed.
let pinnedId = -1; let pinnedOpen = false; let shownPinned = '';
// The live answer whose question is being fixed (its card is not rebuilt meanwhile), and whether the main questions are listed.
let editing: { id: number } | null = null; let topicsOpen = false;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const show = (node: HTMLElement, text: string) => { node.textContent = text; node.hidden = !text; };
const emptyFeed = make('p', 'empty-feed', 'Answers will appear here, newest at the bottom, as questions come in.');
const icon = (name: 'pin' | 'pencil') => byId<HTMLTemplateElement>('icons').content.querySelector(`[data-icon="${name}"]`)!.cloneNode(true) as SVGElement; // The laptop's, in phone.html.
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
  const tools = make('span', 'tools'); head.append(tools);
  // On the live answer, the pencil fixes a misheard question right there, as it does on the laptop.
  if (live) { const pencil = make('button', 'edit-toggle'); pencil.type = 'button'; pencil.append(icon('pencil')); pencil.dataset.ready = String(!!entry.question && editing?.id !== entry.id); pencil.setAttribute('aria-label', 'Fix the question'); tools.append(pencil); }
  // Pins or unpins it, as its pin on the laptop does: the live answer once it is written, and unpinning any time.
  const pin = make('button', entry.pinned ? 'pin-toggle on' : 'pin-toggle'); pin.type = 'button'; pin.append(icon('pin'));
  pin.dataset.pin = String(entry.id); pin.dataset.on = String(!entry.pinned); pin.dataset.ready = String(!!entry.pinned || !live || (!live.generating && entry.blocks.length > 0));
  pin.setAttribute('aria-pressed', String(!!entry.pinned)); pin.setAttribute('aria-label', entry.pinned ? 'Unpin answer' : 'Pin answer'); tools.append(pin);
  if (entry.pinned) card.dataset.pinned = '';
  const answer = make('div', 'answer'); answer.append(...entry.blocks.map(block));
  if (live && !entry.blocks.length && !live.answerError) answer.append(make('p', 'muted', live.generating ? 'Preparing response…' : 'Your answer will appear here.'));
  if (live?.answerError) answer.append(make('div', 'error', live.answerError));
  answer.classList.toggle('writing', !!live?.generating && entry.blocks.length > 0);
  if (editing?.id === entry.id) {
    // Enter (or the button) answers the corrected question instead, in place, and fixes its transcript line on the laptop.
    const box = make('textarea', 'question-edit'); box.value = entry.question; box.maxLength = 2000; box.rows = Math.min(5, Math.ceil(entry.question.length / 30) || 1);
    box.setAttribute('enterkeyhint', 'send'); box.setAttribute('aria-label', 'Question');
    const actions = make('div', 'edit-actions'); const cancel = make('button', 'edit-cancel', 'Cancel'); const save = make('button', 'edit-save', 'Answer this instead');
    cancel.type = save.type = 'button'; actions.append(cancel, save); card.append(head, box, actions);
  } else card.append(head, make('p', 'question', entry.question || 'Waiting for a question…'));
  const topics = live?.topics; const current = topics?.list.find(topic => topic.id === topics.current);
  if (topics && (current || (topics.busy && !topics.list.length && live!.listening !== 'off'))) {
    const block = make('div', 'topic'); const top = make('div', 'topic-head'); top.append(make('div', 'eyebrow', 'Main question'));
    // All of them so far are a tap away, as on the laptop, and ↻ checks for a new one now.
    if (topics.list.length > 1) { const count = make('button', 'topic-count', `${topics.list.indexOf(current!) + 1} of ${topics.list.length} ${topicsOpen ? '▴' : '▾'}`); count.type = 'button'; count.setAttribute('aria-expanded', String(topicsOpen)); top.append(count); }
    const refresh = make('button', 'topic-refresh', '↻'); refresh.type = 'button'; refresh.dataset.ready = String(!topics.busy); refresh.setAttribute('aria-label', 'Check the main question again'); top.append(refresh);
    block.append(top);
    if (current) { block.append(make('p', 'title', current.title)); if (current.question !== current.title) block.append(make('p', '', current.question)); }
    else block.append(make('p', '', 'Working out the main question…'));
    if (topicsOpen && topics.list.length > 1) {
      // Newest first, numbered from the first; a tap shows where it was asked when the phone still has that line.
      const list = make('ol', 'topic-list');
      [...topics.list].reverse().forEach((topic, index) => {
        const item = make('li', topic.id === topics.current ? 'current' : ''); item.value = topics.list.length - index;
        const label = make(topic.from ? 'button' : 'div', 'topic-item'); if (label instanceof HTMLButtonElement) { label.type = 'button'; label.dataset.from = String(topic.from); }
        label.append(make('b', '', topic.title)); if (topic.question !== topic.title) label.append(make('span', '', topic.question));
        item.append(label); list.append(item);
      });
      block.append(list);
    }
    card.prepend(block);
  }
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

/** The pinned answer above the list, as on the laptop: its question, Show, and unpin. When the list does not have its card
 * (it is older, or was rewritten since), Show opens the answer right here. */
function renderPinned(live: boolean) {
  const pinned = state?.pinned; if ((pinned?.id ?? -1) !== pinnedId) { pinnedId = pinned?.id ?? -1; pinnedOpen = false; }
  const key = JSON.stringify([pinned, pinnedOpen, live]); if (key === shownPinned) return; shownPinned = key;
  ui.pinned.hidden = !pinned; ui.pinJump.hidden = !pinned; if (!pinned) { ui.pinned.replaceChildren(); return; }
  const head = make('div', 'pinned-head'); const toggle = make('button', 'pinned-show', pinned.entry && pinnedOpen ? 'Hide' : 'Show'); toggle.type = 'button';
  const unpin = make('button', 'pinned-unpin', '✕'); unpin.type = 'button'; unpin.disabled = !live; unpin.setAttribute('aria-label', 'Unpin answer');
  head.append(icon('pin'), make('p', '', pinned.question), toggle, unpin); ui.pinned.replaceChildren(head);
  if (pinned.entry && pinnedOpen) { const answer = make('div', 'answer'); answer.append(...pinned.entry.blocks.map(block)); ui.pinned.append(answer); }
}
/** To the pinned answer's card, or, without one, open (or with `toggle`, close) it above the list. */
function showPinned(toggle = false) {
  const list = shownCards(); const index = list.findIndex(card => card.dataset.pinned !== undefined);
  if (index >= 0) {
    stepping = { index, until: Date.now() + 900 }; following = index === list.length - 1; if (following) ui.jump.hidden = true;
    list[index].scrollIntoView({ behavior: 'smooth', block: 'start' }); showSteps(list); return;
  }
  pinnedOpen = toggle ? !pinnedOpen : true; render();
  if (pinnedOpen) { following = false; ui.pinned.scrollIntoView({ behavior: 'smooth', block: 'start' }); } // A new answer does not pull you away from it.
}

function render() {
  // What you are reading stays where it is on screen while things above it change size (the line just heard, a notice,
  // the coach over the answer) and new answers arrive.
  const place = readingPlace();
  const live = !!state && laptop && connected && !ended;
  // A fix in progress ends once its answer is no longer the live one (a new question came in), as on the laptop.
  if (editing && !(state?.live && state.entries[state.entries.length - 1]?.id === editing.id)) {
    editing = null; flash = 'A new question came in, so the one you were fixing has moved on.'; window.clearTimeout(flashTimer); flashTimer = window.setTimeout(() => { flash = ''; render(); }, 5000);
  }
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
    const fixing = editing?.id === entry.id;
    const key = JSON.stringify([entry, live && [live.generating, live.answerError, live.status, live.coach, live.topics, live.listening, topicsOpen], fixing]);
    // The card being fixed is built once for it and then left alone, so what you type survives the answer streaming on.
    let item = cards.get(entry.id); if (!item || (item.key !== key && !(fixing && item.fixing))) { item = { key, card: entryCard(entry, live), fixing }; cards.set(entry.id, item); }
    kept.add(entry.id); nodes.push(item.card);
  });
  for (const id of cards.keys()) if (!kept.has(id)) cards.delete(id);
  // Only the cards that changed are swapped in; the rest stay in the page, and so does a selection in them.
  const shown = nodes.length ? nodes : [emptyFeed];
  for (const child of [...ui.feed.children]) if (!shown.includes(child as HTMLElement)) child.remove();
  shown.forEach((node, index) => { if (ui.feed.children[index] !== node) ui.feed.insertBefore(node, ui.feed.children[index] ?? null); });
  document.body.classList.toggle('stepping', nodes.length > 1);
  for (const button of ui.feed.querySelectorAll<HTMLButtonElement>('.coach-refresh')) button.disabled = !live || !!state.coach?.busy;
  for (const button of ui.feed.querySelectorAll<HTMLButtonElement>('.pin-toggle, .edit-toggle, .topic-refresh')) button.disabled = !live || button.dataset.ready !== 'true';
  renderPinned(live);

  const transcript = JSON.stringify([state.heard, state.labels, state.interim]);
  if (transcript !== shownTranscript) {
    shownTranscript = transcript;
    const lines = state.heard.map(line => {
      const row = make('div', `line ${line.speaker ?? ''}`); const words = make('span');
      if (line.speaker || (state!.labels && line.id)) {
        // A tap on the label switches it, as a click on it does on the laptop (unlabeled lines become the interviewer's).
        const label = line.speaker === 'interviewer' ? 'Interviewer' : line.speaker === 'candidate' ? 'You' : 'Who?'; const other = line.speaker === 'interviewer' ? 'candidate' : 'interviewer';
        const who = make(line.id ? 'button' : 'b', 'who', label);
        if (who instanceof HTMLButtonElement) { who.type = 'button'; who.dataset.line = String(line.id); who.dataset.speaker = other; who.setAttribute('aria-label', `${label}: switch to ${other === 'candidate' ? 'You' : 'Interviewer'}`); }
        words.append(who);
      }
      words.append(line.text); row.append(make('time', '', line.time), words);
      // A tap anywhere else on the line answers it, like ↵ beside it on the laptop.
      if (line.id) { row.dataset.line = String(line.id); const answer = make('button', 'answer-line', '↵'); answer.type = 'button'; answer.setAttribute('aria-label', 'Answer this line'); row.append(answer); }
      return row;
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
function startFix(id: number) {
  editing = { id }; render();
  const box = ui.feed.querySelector<HTMLTextAreaElement>('.question-edit'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}
const stopFix = () => { editing = null; render(); };
/** Sends the corrected question; the laptop answers it in place, and the editor closes once it has taken it. */
async function saveFix() {
  const id = editing?.id; const text = ui.feed.querySelector<HTMLTextAreaElement>('.question-edit')?.value.trim();
  if (id !== undefined && text && await send({ type: 'fix', entry: id, text }) && editing?.id === id) stopFix();
}
/** Opens the transcript at a line, as the laptop shows where a main question was asked, when the phone still has it. */
function showLine(id: number) {
  const row = ui.transcript.querySelector<HTMLElement>(`.line[data-line="${id}"]`);
  if (!row) { notify('That was asked before the 30 lines the phone shows. The transcript on your laptop has it.'); return; }
  const details = ui.transcript.closest('details'); if (details) details.open = true;
  following = false; row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('flash'); window.setTimeout(() => row.classList.remove('flash'), 1600);
}
// The controls on the cards are rebuilt with them, so they are handled here. The next state shows the coach or the main
// questions at work; if none comes (nothing changed), their refresh comes back after a few seconds.
ui.feed.addEventListener('click', event => {
  const target = event.target as Element;
  const refresh = target.closest<HTMLButtonElement>('.coach-refresh, .topic-refresh');
  if (refresh && !refresh.disabled) { refresh.disabled = true; void send({ type: refresh.matches('.coach-refresh') ? 'coach' : 'topics' }); window.setTimeout(render, 4000); return; }
  const pin = target.closest<HTMLButtonElement>('.pin-toggle');
  if (pin && !pin.disabled) { void send({ type: 'pin', entry: Number(pin.dataset.pin), on: pin.dataset.on === 'true' }); return; }
  const pencil = target.closest<HTMLButtonElement>('.edit-toggle');
  if (pencil && !pencil.disabled) { startFix(Number(pencil.closest<HTMLElement>('.entry')!.dataset.entry)); return; }
  if (target.closest('.edit-cancel')) stopFix();
  else if (target.closest('.edit-save')) void saveFix();
  else if (target.closest('.topic-count')) { topicsOpen = !topicsOpen; render(); }
  else { const asked = target.closest<HTMLElement>('.topic-item[data-from]'); if (asked) showLine(Number(asked.dataset.from)); }
});
// Enter answers the corrected question, as on the laptop (a question is one line), and Escape cancels.
ui.feed.addEventListener('keydown', event => {
  if (!(event.target as Element).matches('.question-edit') || event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveFix(); }
  else if (event.key === 'Escape') { event.preventDefault(); stopFix(); }
});
ui.pinned.addEventListener('click', event => {
  const target = event.target as Element;
  if (target.closest('.pinned-show')) showPinned(true);
  else if (target.closest('.pinned-unpin') && state?.pinned) void send({ type: 'pin', entry: state.pinned.id, on: false });
});
ui.pinJump.append(icon('pin')); ui.pinJump.addEventListener('click', () => showPinned());
ui.transcript.addEventListener('click', async event => {
  const target = event.target as Element;
  const label = target.closest<HTMLButtonElement>('button.who');
  if (label) { void send({ type: 'label', line: Number(label.dataset.line), speaker: label.dataset.speaker === 'candidate' ? 'candidate' : 'interviewer' }); return; }
  const row = target.closest<HTMLElement>('.line[data-line]'); if (!row) return;
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
