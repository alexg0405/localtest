// Roomside on your phone, served by server/phone-mirror.ts. The laptop listens and writes the answers; this page shows its
// session as it changes and sends taps and typed questions back. Only type imports here: the server sends this file as-is.
import type { MirrorBlock, MirrorCommand, MirrorState } from '../mirror';
import type { Mode } from '../providers';
import type { InlineSegment } from '../text';

const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const listeningLabels = { off: 'Mic off', starting: 'Starting…', on: 'Listening', voice: 'Voice detected' };
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  connection: byId('connection'), banner: byId('banner'), mic: byId('mic'), micLabel: byId('mic-label'), listen: byId<HTMLButtonElement>('listen'),
  heardLine: byId('heard-line'), micMessage: byId('mic-message'), questionCard: byId('question-card'), questionLabel: byId('question-label'), tag: byId('tag'),
  question: byId('question'), answerLabel: byId('answer-label'), answer: byId('answer'), status: byId('status'), modes: byId('modes'), actions: byId('actions'),
  transcript: byId('transcript'), provider: byId('provider'), ask: byId<HTMLFormElement>('ask'), askInput: byId<HTMLInputElement>('ask-input'), askSend: byId<HTMLButtonElement>('ask-send'),
};

let state: MirrorState | null = null;
let laptop = false; let connected = false; let ended: '' | 'stopped' | 'expired' = '';
let flash = ''; let flashTimer = 0; let pending = false;
let shownAnswer = ''; let shownTranscript = ''; let shownQuestion = '';

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
  for (const button of ui.actions.querySelectorAll('button')) button.disabled = !live || !state?.question;
  if (!state) { ui.listen.disabled = true; show(ui.status, ''); return; }

  ui.mic.className = `mic ${state.listening}`; ui.micLabel.textContent = listeningLabels[state.listening];
  ui.listen.textContent = state.listening === 'off' ? 'Start listening' : 'Stop listening';
  ui.listen.classList.toggle('stop', state.listening !== 'off'); ui.listen.disabled = !live || pending;
  const heard = state.interim || state.heard[state.heard.length - 1]?.text || '';
  show(ui.heardLine, state.listening !== 'off' ? heard : '');
  show(ui.micMessage, state.micError || state.notice);

  ui.questionLabel.textContent = state.possible ? 'Possible question' : 'Detected question'; show(ui.tag, state.tag);
  ui.question.textContent = state.question || 'Waiting for a question…';
  // A new question moves the answer back into view if you had scrolled down through the last one.
  if (state.question !== shownQuestion) { shownQuestion = state.question; if (state.question && ui.questionCard.getBoundingClientRect().top < 0) ui.questionCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  ui.answerLabel.textContent = `${state.kind === 'followup' ? 'Likely follow-up' : 'Response'} · ${state.answerMode}`;
  const answer = JSON.stringify([state.blocks, state.generating, state.answerError]);
  if (answer !== shownAnswer) { // Rebuilding only on change keeps a text selection alive between updates.
    shownAnswer = answer;
    ui.answer.replaceChildren(...state.blocks.map(block));
    if (!state.blocks.length && !state.answerError) ui.answer.append(make('p', 'muted', state.generating ? 'Preparing response…' : 'Your answer will appear here.'));
    if (state.answerError) ui.answer.append(make('div', 'error', state.answerError));
    ui.answer.classList.toggle('writing', state.generating && state.blocks.length > 0);
  }
  show(ui.status, state.status);

  const transcript = JSON.stringify([state.heard, state.interim]);
  if (transcript !== shownTranscript) {
    shownTranscript = transcript;
    const lines = state.heard.map(line => { const row = make('div', 'line'); row.append(make('time', '', line.time), make('span', '', line.text)); return row; });
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
for (const button of ui.actions.querySelectorAll('button')) button.addEventListener('click', () => void send({ type: button.dataset.command } as MirrorCommand));
ui.ask.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.askInput.value.trim(); if (!text) return;
  if (await send({ type: 'ask', text })) { ui.askInput.value = ''; ui.askInput.blur(); }
});

// EventSource reconnects on its own after brief drops, but gives up after a refused request or when a locked phone suspends
// it, so reconnect by hand and check first whether the link still exists.
let source: EventSource | null = null; let retryTimer = 0; let attempts = 0;
function connect() {
  window.clearTimeout(retryTimer); source?.close();
  const current = new EventSource('events'); source = current;
  current.addEventListener('open', () => { attempts = 0; connected = true; render(); });
  current.addEventListener('state', event => {
    const data = JSON.parse((event as MessageEvent).data);
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ended && !connected) connect(); });
connect(); render();
