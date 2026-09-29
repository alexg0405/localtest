// Who said each transcript line: a quick guess from the words, then a check by a fast model that reads the lines around
// it, and (with Deepgram) the voice it came from. Clicking a line's label in the transcript corrects it.
import { likelyQuestion } from './text';
import type { VoicePrint } from './voice';

export type Speaker = 'interviewer' | 'candidate';
/** How a label was decided: `guess` from the words, `voice` from earlier labels for the same Deepgram voice, `ai` checked
 * by the model, `typed` for questions typed into Roomside, `you` when you corrected it. */
export type SpeakerSource = 'guess' | 'voice' | 'ai' | 'typed' | 'you';
/** `voice` is Deepgram's speaker number; `print` what the line sounded like and `heard` who it sounded like (browser recognition). */
export type SpokenLine = { id: number; text: string; speaker?: Speaker; by?: SpeakerSource; voice?: number; print?: VoicePrint; heard?: Speaker };

const leadIn = String.raw`^(?:(?:so|okay|ok|um+|uh+|and|yeah|yes|sure|well|right|actually|basically|alright|all right)[\s,.]+)*`;
const wordEnd = String.raw`(?![\p{L}\p{N}'])`;
// The candidate checking something with the interviewer ("can I assume…", "do you want me to…"), but not "can I ask you…".
const clarifying = String.raw`(?:(?:can|could|may) i(?! ask)|should i|shall i|do i need to|is it (?:ok|okay|fine) if i|would it be (?:ok|okay|fine) if i|do you want me to|would you like me to)`;
const clarifyingQuestion = new RegExp(`${leadIn}${clarifying}${wordEnd}`, 'iu');
const candidateQuestion = new RegExp(`${leadIn}(?:${clarifying}|do i|am i|does that make sense|is that (?:right|correct|ok|okay))${wordEnd}`, 'iu');
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

/** The candidate asking the interviewer to clarify something: no suggested answer is needed. */
export const isClarifyingQuestion = (text: string) => clarifyingQuestion.test(text.trim().replace(/[‘’]/g, "'"));

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

export type VoiceSample = { speaker: Speaker; print: VoicePrint };
/** Samples to learn voices from: lines whose label was checked or corrected, and prints recorded by "Learn my voice". */
export const voiceSamples = (lines: readonly SpokenLine[], mine: readonly VoicePrint[] = []): VoiceSample[] => [
  ...lines.flatMap(line => line.print && line.speaker && (line.by === 'ai' || line.by === 'you') ? [{ speaker: line.speaker, print: line.print }] : []),
  ...mine.map(print => ({ speaker: 'candidate' as const, print })),
];

// Pitch in semitones, brightness on a log scale, and loudness above the room in dB; spreads below these are not telling.
const features = (print: VoicePrint) => [print.pitch, Math.log(Math.max(print.tilt, 1e-4)), print.level];
const floors = [1.5, 0.2, 3];
type Profile = ({ mean: number; spread: number } | null)[];
function profile(samples: readonly VoiceSample[], speaker: Speaker): Profile | null {
  const own = samples.filter(sample => sample.speaker === speaker && sample.print.seconds >= 0.6);
  if (own.length < 3) return null;
  return floors.map((floor, dim) => {
    const values = own.map(sample => features(sample.print)[dim]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (values.length < 3) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { mean, spread: Math.max(floor, Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))) };
  });
}

/** Who an utterance sounds like, compared with how each person has sounded so far, when the difference is clear.
 * `strength` is the log-likelihood ratio (3 is about 20:1). With only one person's voice known, a close match or a clear
 * mismatch still counts, more weakly. Short utterances are left to the words. */
export function voiceGuess(samples: readonly VoiceSample[], print?: VoicePrint): { speaker: Speaker; strength: number } | undefined {
  if (!print || print.seconds < 0.6) return undefined;
  const x = features(print); const interviewer = profile(samples, 'interviewer'); const candidate = profile(samples, 'candidate');
  const logLikelihood = (stats: Profile, dim: number) => { const stat = stats[dim], value = x[dim]; return stat && typeof value === 'number' ? -0.5 * ((value - stat.mean) / stat.spread) ** 2 - Math.log(stat.spread) : undefined; };
  if (interviewer && candidate) {
    let ratio = 0;
    for (let dim = 0; dim < floors.length; dim++) { const a = logLikelihood(interviewer, dim), b = logLikelihood(candidate, dim); if (a !== undefined && b !== undefined) ratio += a - b; }
    return Math.abs(ratio) >= 3 ? { speaker: ratio > 0 ? 'interviewer' : 'candidate', strength: Math.abs(ratio) } : undefined;
  }
  const known = interviewer ?? candidate; if (!known) return undefined;
  // A match needs every measure close; a mismatch needs one clearly off (averaging would hide a different pitch).
  const distances = floors.flatMap((_, dim) => { const stat = known[dim], value = x[dim]; return stat && typeof value === 'number' ? [Math.abs(value - stat.mean) / stat.spread] : []; });
  if (!distances.length) return undefined;
  const worst = Math.max(...distances); const same: Speaker = interviewer ? 'interviewer' : 'candidate';
  return worst < 1.2 ? { speaker: same, strength: 2 } : worst > 3 ? { speaker: same === 'interviewer' ? 'candidate' : 'interviewer', strength: 2 } : undefined;
}

export const speakerInstructions = `You label who said each line of a live job interview transcript. It comes from speech recognition, so words can be misheard and punctuation is often missing. For each numbered line, decide whether the interviewer (I) or the candidate (C) said it. The interviewer usually introduces themselves, the team, or the role, asks the questions, gives coding problems, and reacts briefly ("great", "okay, next question"); the candidate answers, describes their own experience in the first person, thinks aloud while solving problems, and asks clarifying questions or questions about the role. A short reaction such as "okay" or "yeah" usually comes from whoever is listening to the other person. When lines show a voice number, lines with the same number came from the same person. Some lines say who the voice sounds like, from a quick comparison of pitch and tone; that is usually right but can be wrong, especially for short lines. Reply with only a JSON object that maps every line number to "I" or "C", for example {"1":"I","2":"C"}.`;

const label = (speaker?: Speaker) => speaker === 'interviewer' ? 'Interviewer' : speaker === 'candidate' ? 'Candidate' : 'Unlabeled';
const voiceNote = (line: SpokenLine) => line.voice !== undefined ? ` (voice ${line.voice + 1})` : line.heard ? ` (sounds like the ${line.heard})` : '';

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
