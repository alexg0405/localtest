// The live answer: one suggestion that keeps up with the conversation. Each interviewer turn gets an answer that grows
// with the turn and picks up from the candidate's own words when they answer their own way, while reading it aloud (or
// checking something with the interviewer) leaves it alone.
import type { Speaker } from './speakers';

/** What the live answer responds to: the interviewer's turn so far, and everything the candidate has said since (read
 * aloud or their own), which a continuation picks up from. */
export type LiveTurn = { asked: string; said: string[] };
/** A line, or words still coming. `read` is the candidate reading a suggested answer aloud, `clarifying` them checking
 * what was meant, and `question` whether it asks something. */
export type LiveHeard = { text: string; speaker?: Speaker; read: boolean; clarifying: boolean; question: boolean };
/** `hold` leaves the live answer as it is (though the turn may note what was said), `new` answers a new turn (the last
 * answer moves to Earlier), and `update` rewrites the live answer in place. */
export type LiveStep = { action: 'hold'; turn: LiveTurn | null } | { action: 'new' | 'update'; turn: LiveTurn };

// Listening noises, short reactions, and fillers with nothing else in them ("Mm-hmm." "Right, okay." "Okay, so…").
const acknowledgment = /^(?:(?:mm+[- ]?hm+|m+hm+|uh[- ]?huh|hm+|um+|uh+|er+|oh|ah|okay|ok|right|yeah|yes|yep|yup|sure|cool|nice|great|awesome|wow|interesting|gotcha|got it|i see|alright|all right|perfect|makes sense|that makes sense|sounds good|totally|exactly|for sure|definitely|of course|fair enough|true|good|very good|thanks|thank you|so|and|well|anyway)(?![\p{L}\p{N}'])[\s,.!?…-]*)+$/iu;
export const acknowledges = (text: string) => acknowledgment.test(text.trim().replace(/[‘’]/g, "'"));

/** What a new line (or words still coming) means for the live answer. */
export function liveStep(turn: LiveTurn | null, heard: LiveHeard): LiveStep {
  const text = heard.text.trim();
  // "Mm-hmm" while someone talks, or you checking what they meant: their reply to that joins the same turn.
  if (!text || heard.clarifying || acknowledges(text)) return { action: 'hold', turn };
  const said = turn && { ...turn, said: [...turn.said, text] };
  // Someone unlabeled while you have the floor is most likely you going on; taking it for a new turn would drop your answer.
  const speaker = heard.speaker ?? (turn?.said.length ? 'candidate' : undefined);
  // Reading the answer aloud, or asking them something ("Does that make sense?"), leaves it alone, but it is a reply:
  // whatever the interviewer says next is a new turn.
  if (heard.read || (speaker === 'candidate' && heard.question)) return { action: 'hold', turn: said };
  if (speaker === 'candidate') return said ? { action: 'update', turn: said } : { action: 'new', turn: { asked: text, said: [] } };
  // The interviewer, or someone unlabeled: more of the same turn, or a new one once you have replied.
  if (turn && !turn.said.length) return { action: 'update', turn: { asked: `${turn.asked} ${text}`, said: [] } };
  return { action: 'new', turn: { asked: text, said: [] } };
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

/** The live answer's prompt: what the interviewer said, question or not, and what the candidate has said so far, to continue. */
export const livePrompt = ({ asked, said }: LiveTurn) => said.length
  ? `${asked}\n\nThe candidate has started answering: "${said.join(' ')}". Continue their answer from there in the same voice, without repeating what they already said.`
  : asked;
