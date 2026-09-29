// Who said each transcript line: a quick guess from the words, then a check by a fast model that reads the lines around
// it, and (with Deepgram) the voice it came from. Clicking a line's label in the transcript corrects it.
import { likelyQuestion } from './text';

export type Speaker = 'interviewer' | 'candidate';
/** How a label was decided: `guess` from the words, `voice` from earlier labels for the same Deepgram voice, `ai` checked
 * by the model, `typed` for questions typed into Roomside, `you` when you corrected it. */
export type SpeakerSource = 'guess' | 'voice' | 'ai' | 'typed' | 'you';
export type SpokenLine = { id: number; text: string; speaker?: Speaker; by?: SpeakerSource; voice?: number };

const leadIn = String.raw`^(?:(?:so|okay|ok|um+|uh+|and|yeah|yes|sure|well|right|actually|basically|alright|all right)[\s,.]+)*`;
const wordEnd = String.raw`(?![\p{L}\p{N}'])`;
// The candidate checking something with the interviewer ("can I assume…", "do you want me to…").
const candidateQuestion = new RegExp(`${leadIn}(?:can i|could i|may i|should i|shall i|do i|am i|is it (?:ok|okay|fine) if i|would it be (?:ok|okay|fine) if i|do you want me to|would you like me to|does that make sense|is that (?:right|correct|ok|okay))${wordEnd}`, 'iu');
// The interviewer steering the conversation.
const interviewerStatement = new RegExp(`(?:^|[\\s,.])(?:thanks for (?:that|sharing|joining|coming)|thank you for (?:that|sharing|joining|coming)|great answer|good answer|let's move on|moving on|next question|for the next (?:part|question|one)|we're looking for|we'll leave time)${wordEnd}`, 'iu');
// First-person accounts and thinking aloud.
const candidateStatement = new RegExp(`${leadIn}(?:i|i'm|i've|i'd|i'll|my|we|we're|we've|we'd|that's a (?:great|good) question|at my|in my|when i|what i|let me think)${wordEnd}`, 'iu');

/** A first guess, shown until the model checks it: questions and prompts are the interviewer's, first-person accounts the candidate's. */
export function guessSpeaker(text: string, language = 'en-US'): Speaker | undefined {
  const value = text.trim().replace(/[‘’]/g, "'");
  if (!value) return undefined;
  if (candidateQuestion.test(value)) return 'candidate';
  if (likelyQuestion(value, language) || interviewerStatement.test(value)) return 'interviewer';
  if (candidateStatement.test(value)) return 'candidate';
  return undefined;
}

/** Lines whose label is still a guess, oldest first. */
export const awaitingCheck = <T extends SpokenLine>(lines: readonly T[]) => lines.filter(line => line.by === 'guess' || line.by === 'voice');

/** The label each Deepgram voice has had so far, by majority; your corrections count three times. */
export function voiceRoles(lines: readonly SpokenLine[]) {
  const scores = new Map<number, number>(); // Above zero: interviewer. Below: candidate.
  for (const line of lines) {
    if (line.voice === undefined || !line.speaker || (line.by !== 'ai' && line.by !== 'you')) continue;
    const weight = line.by === 'you' ? 3 : 1;
    scores.set(line.voice, (scores.get(line.voice) ?? 0) + (line.speaker === 'interviewer' ? weight : -weight));
  }
  const roles = new Map<number, Speaker>();
  for (const [voice, score] of scores) if (score) roles.set(voice, score > 0 ? 'interviewer' : 'candidate');
  return roles;
}

export const speakerInstructions = `You label who said each line of a live job interview transcript. It comes from speech recognition, so words can be misheard and punctuation is often missing. For each numbered line, decide whether the interviewer (I) or the candidate (C) said it. The interviewer usually introduces themselves, the team, or the role, asks the questions, gives coding problems, and reacts briefly ("great", "okay, next question"); the candidate answers, describes their own experience in the first person, thinks aloud while solving problems, and asks clarifying questions or questions about the role. A short reaction such as "okay" or "yeah" usually comes from whoever is listening to the other person. When lines show a voice number, lines with the same number came from the same person. Reply with only a JSON object that maps every line number to "I" or "C", for example {"1":"I","2":"C"}.`;

const label = (speaker?: Speaker) => speaker === 'interviewer' ? 'Interviewer' : speaker === 'candidate' ? 'Candidate' : 'Unlabeled';
const voiceNote = (line: SpokenLine) => line.voice === undefined ? '' : ` (voice ${line.voice + 1})`;

/** The model's prompt: the lines to label, numbered, after a few already labeled ones for context. */
export function speakerPrompt(earlier: readonly SpokenLine[], pending: readonly SpokenLine[], role = '') {
  return [
    role.trim() && `The candidate is interviewing for: ${role.trim()}`,
    earlier.length > 0 && `Earlier lines, already labeled:\n${earlier.map(line => `${label(line.speaker)}${voiceNote(line)}: ${line.text}`).join('\n')}`,
    `Lines to label:\n${pending.map((line, index) => `${index + 1}${voiceNote(line)}. ${line.text}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

/** Reads the model's JSON reply; lines it left out (or an unusable reply) come back undefined and keep their guesses. */
export function parseSpeakerLabels(output: string, count: number): (Speaker | undefined)[] {
  let labels: Record<string, unknown> = {};
  try { labels = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] ?? '{}') ?? {}; } catch { /* Keep the guesses. */ }
  return Array.from({ length: count }, (_, index) => {
    const value = String(labels[String(index + 1)] ?? '').trim().toUpperCase();
    return value === 'I' ? 'interviewer' : value === 'C' ? 'candidate' : undefined;
  });
}
