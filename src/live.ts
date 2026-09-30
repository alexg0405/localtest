// The live answer: one suggestion that keeps up with the conversation. Every question (or problem) the interviewer puts to
// the candidate gets a fresh answer, which grows with what they add before the candidate replies and then holds still:
// the rest of the conversation about it (asides, hints, the candidate explaining in their own words) goes to the live
// coach instead of rewriting the answer. Who said a line is only ever a guess, and lines often run one person's words
// into the other's, so the question in a line decides more than its label.
import type { Speaker } from './speakers';
import { endsMidPhrase } from './text';

/** What the live answer responds to: what the interviewer asked (or said, if it was not a question), whether it asks
 * something yet, everything the candidate has said since (read aloud or their own), and how many of those words were
 * their own, which the live coach follows. */
export type LiveTurn = { asked: string; said: string[]; question: boolean; ownWords: number };
/** A line, or words still coming. `read` is the candidate reading a suggested answer aloud, `clarifying` them checking
 * what was meant, `question` whether the line asks anything, and `ask` the interviewer's question in it, with what led up
 * to it (see lastAsk in speakers.ts), when it counts as theirs. */
export type LiveHeard = { text: string; speaker?: Speaker; read: boolean; clarifying: boolean; question: boolean; ask?: string };
/** `hold` leaves the live answer as it is (though the turn may note what was said), `new` answers a new turn (the last
 * answer moves to Earlier), and `update` rewrites the live answer in place. */
export type LiveStep = { action: 'hold'; turn: LiveTurn | null } | { action: 'new' | 'update'; turn: LiveTurn };

// Listening noises, short reactions, and fillers with nothing else in them ("Mm-hmm." "Perfect, that works, thanks.").
const acknowledgment = /^(?:(?:mm+[- ]?hm+|m+hm+|uh[- ]?huh|hm+|um+|uh+|er+|oh|ah|okay|ok|right|yeah|yes|yep|yup|sure|cool|nice|great|awesome|wow|interesting|gotcha|got it|i see|i mean|like|you know|alright|all right|perfect|makes sense|that makes sense|sounds good|sounds great|that works|works for me|that's fine|fine|no worries|no problem|all good|totally|exactly|for sure|definitely|of course|fair enough|true|good|very good|love it|(?:great|good|interesting|fair) question|thanks|thank you|take your time|no rush|go ahead|so|and|well|anyway)(?![\p{L}\p{N}'])[\s,.!?…-]*)+$/iu;
export const acknowledges = (text: string) => acknowledgment.test(text.trim().replace(/[‘’]/g, "'"));
// Thanks and goodbyes that end a line ("…thanks so much for your time today!" "Thank you, this was great."), which need no
// answer and no more coaching.
const closing = /(?<![\p{L}\p{N}'])(?:(?:thanks|thank you)(?: so much| again| a lot)? for (?:your time|the time|chatting|talking|today)|(?:this|that) was (?:great|fun|nice|really nice|awesome|a pleasure)|nice (?:talking|chatting|meeting) (?:to |with )?you|have a (?:great|good|nice) (?:day|one|weekend|evening)|take care|talk (?:to you )?soon|(?:good)?bye)(?:\s+(?:today|again|too))?[\s.!]*$/iu;
export const closes = (text: string) => closing.test(text.replace(/[‘’]/g, "'"));

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** Keeps what the answer responds to short: the last sentences that fit, since the conversation goes with every answer anyway. */
export function bounded(text: string, limit = 400) {
  const value = text.trim(); if (value.length <= limit) return value;
  const sentences = value.match(/[^.?!…]+(?:[.?!…]+["'”’)\]]*|$)/gu) ?? [value]; let kept = '';
  for (let index = sentences.length - 1; index >= 0; index--) { const next = `${sentences[index]}${kept}`; if (kept && next.trim().length > limit) break; kept = next; }
  return kept.trim().length > limit ? `…${kept.trim().slice(-limit)}` : kept.trim();
}
const fresh = (asked: string, question: boolean): LiveTurn => ({ asked: bounded(asked), said: [], question, ownWords: 0 });
// Still being asked: nothing asked yet (they are setting it up), or it trailed off ("Can you walk me through…").
const open = (turn: LiveTurn) => !turn.question || endsMidPhrase(turn.asked);
// A short question that goes on from their last one ("And why?").
const followsOn = (ask: string) => /^(?:and|or|but|also|plus)(?![\p{L}\p{N}'])/iu.test(ask) && wordCount(ask) <= 8;

/** What a new line (or words still coming) means for the live answer. */
export function liveStep(turn: LiveTurn | null, heard: LiveHeard): LiveStep {
  const text = heard.text.trim();
  // "Mm-hmm" while someone talks, or you checking what they meant: their reply to that joins the same turn.
  if (!text || heard.clarifying || acknowledges(text)) return { action: 'hold', turn };
  const said = turn && { ...turn, said: [...turn.said, text] };
  // Reading the answer aloud leaves it alone, but it is a reply: whatever the interviewer says next is a new turn.
  if (heard.read) return { action: 'hold', turn: said };
  // Their question: a new turn, unless it finishes what they were setting up (or trailed off from) or goes on from their
  // last question, before you replied.
  if (heard.ask) {
    const ask = heard.ask.trim();
    if (turn && !turn.said.length && (open(turn) || followsOn(ask))) return { action: 'update', turn: fresh(`${turn.asked} ${ask}`, true) };
    return { action: 'new', turn: fresh(ask, true) };
  }
  if (closes(text)) return { action: 'hold', turn };
  // You, in your own words or asking them something: the answer holds still, and what you say moves the live coach.
  // Someone unlabeled is you too once they have asked their question.
  if (heard.speaker === 'candidate' || (!heard.speaker && turn && (turn.said.length > 0 || !open(turn)))) {
    if (!said) return heard.question ? { action: 'hold', turn } : { action: 'new', turn: fresh(text, false) };
    return { action: 'hold', turn: { ...said, ownWords: said.ownWords + wordCount(text) } };
  }
  // Them, saying something other than a question: the start of the conversation gets an answer, and while they set up
  // what they will ask it joins that; once they have asked it, it is conversation about it (an aside, a hint, or you
  // heard as them), which leaves the answer alone.
  if (!turn) return { action: 'new', turn: fresh(text, false) };
  if (open(turn) && !turn.said.length) return { action: 'update', turn: { ...turn, asked: bounded(`${turn.asked} ${text}`) } };
  return { action: 'hold', turn };
}

/** Several lines heard at once (your words, the interviewer cutting in, and your reply), as one step. */
export function liveSteps(turn: LiveTurn | null, heard: readonly LiveHeard[]): LiveStep {
  let action: LiveStep['action'] = 'hold';
  for (const item of heard) {
    const step = liveStep(turn, item); turn = step.turn;
    if (step.action === 'new' || (step.action === 'update' && action === 'hold')) action = step.action;
  }
  return action === 'hold' || !turn ? { action: 'hold', turn } : { action, turn };
}

/** What the live coach works from: the role (or that it is not given, so nothing about the company gets made up), the
 * question, the latest of what the candidate has said, and, once they have been at it a while, how long and how many
 * filler words (counted by the caller). */
export function liveCoachPrompt({ asked, said }: LiveTurn, seconds: number, fillers = 0, role = '') {
  const words = said.join(' '); const recent = words.length > 1200 ? `…${words.slice(-1200).replace(/^\S*\s/, '')}` : words;
  return [role.trim() ? `They are interviewing for: ${role.trim()}` : 'The role and company they are interviewing for are not given.', `Question: ${asked}`, `What the candidate has said so far, in their own words or reading from a suggested answer: ${recent ? `"${recent}"` : 'nothing yet'}`,
    seconds >= 20 && `They have been answering for about ${Math.round(seconds)} seconds${fillers >= 3 ? `, with ${fillers} filler words` : ''}.`,
    // Last, where it is followed best: specifics, not advice to go find them.
    `Coach this answer now. Name the specific project, job, or detail from their background above that fits${role.trim() ? `, and connect it to ${role.trim()}` : ''}; never tell them to research or pick one. The points are things to say, not questions for them to think about.`].filter(Boolean).join('\n\n');
}

export type LiveCoach = { key: string; points: string[]; tip: string };
/** Reads the coach's reply: its KEY line, up to three points, and an optional TIP. Without a KEY line, the first point leads. */
export function parseLiveCoach(output: string): LiveCoach | null {
  let key = '', tip = ''; const points: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim().replace(/\*\*/g, ''); if (!line) continue;
    const labeled = line.match(/^(key|tip)\s*[:：-]\s*(.+)$/i);
    if (labeled) { if (labeled[1].toLowerCase() === 'key') key = labeled[2].trim(); else tip = labeled[2].trim(); continue; }
    const point = line.match(/^(?:[•\-*·]|\d+[.)])\s*(.+)$/); if (point) points.push(point[1].trim());
  }
  if (!key && points.length) key = points.shift()!;
  // "TIP: none yet" and the like are the coach having nothing to fix.
  if (/^(?:none|n\/a|nothing|no tip|not yet|-+|—)(?![\p{L}])/iu.test(tip)) tip = '';
  return key ? { key, points: points.slice(0, 3), tip } : null;
}
