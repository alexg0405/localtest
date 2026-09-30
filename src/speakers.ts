// Who said each transcript line: a quick guess from the words, then a check by a fast model that reads the lines around
// it, and (with Deepgram) the voice it came from. Lines that repeat a suggested answer are yours: you reading it aloud.
// Clicking a line's label in the transcript corrects it.
import { endsMidPhrase, likelyQuestion, trailingQuestionStart } from './text';
import type { VoicePrint, VoiceSegment } from './voice';

export type Speaker = 'interviewer' | 'candidate';
/** How a label was decided: `guess` from the words, `voice` from earlier labels for the same Deepgram voice, `ai` checked
 * by the model, `typed` for questions typed into Roomside, `you` when you corrected it, `answer` when the line repeats a
 * suggested answer. */
export type SpeakerSource = 'guess' | 'voice' | 'ai' | 'typed' | 'you' | 'answer';
/** `voice` is Deepgram's speaker number; `print` what the line sounded like and `heard` who it sounded like (browser recognition). */
export type SpokenLine = { id: number; text: string; speaker?: Speaker; by?: SpeakerSource; voice?: number; print?: VoicePrint; heard?: Speaker };

const leadIn = String.raw`^(?:(?:so|oh|wait|sorry|okay|ok|um+|uh+|and|yeah|yes|sure|well|right|actually|basically|alright|all right)[\s,.]+)*`;
const wordEnd = String.raw`(?![\p{L}\p{N}'])`;
// The candidate checking something with the interviewer ("can I assume…", "do you want me to…"), but not "can I ask you…".
const clarifying = String.raw`(?:(?:can|could|may) i(?! ask| get you| have you)|should i|shall i|do i need to|is it (?:ok|okay|fine) if i|would it be (?:ok|okay|fine) if i|do you want me to|would you like me to)`;
const clarifyingQuestion = new RegExp(`${leadIn}${clarifying}${wordEnd}`, 'iu');
const candidateQuestion = new RegExp(`${leadIn}(?:${clarifying}|do i|am i|does that make sense|does that answer|did that answer|is that what you|is that (?:right|correct|ok|okay))${wordEnd}`, 'iu');
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

/** The label each Deepgram voice has had so far, by majority; your corrections count three times, and lines that repeat a
 * suggested answer twice. */
export function voiceRoles(lines: readonly SpokenLine[]) {
  const scores = new Map<number, number>(); // Above zero: interviewer. Below: candidate.
  for (const line of lines) {
    if (line.voice === undefined || !line.speaker || (line.by !== 'ai' && line.by !== 'you' && line.by !== 'answer')) continue;
    const weight = line.by === 'you' ? 3 : line.by === 'answer' ? 2 : 1;
    scores.set(line.voice, (scores.get(line.voice) ?? 0) + (line.speaker === 'interviewer' ? weight : -weight));
  }
  const roles = new Map<number, Speaker>();
  for (const [voice, score] of scores) if (score) roles.set(voice, score > 0 ? 'interviewer' : 'candidate');
  return roles;
}

export type VoiceSample = { speaker: Speaker; print: VoicePrint };
/** Samples to learn voices from: lines whose label was checked or corrected, lines you read from a suggested answer, and
 * prints recorded by "Learn my voice". */
export const voiceSamples = (lines: readonly SpokenLine[], mine: readonly VoicePrint[] = []): VoiceSample[] => [
  ...lines.flatMap(line => line.print && line.speaker && (line.by === 'ai' || line.by === 'you' || line.by === 'answer') ? [{ speaker: line.speaker, print: line.print }] : []),
  ...mine.map(print => ({ speaker: 'candidate' as const, print })),
];

/** A suggested answer you might read aloud, with the question it answers. */
export type ReadableAnswer = { question: string; answer: string };
type Word = { text: string; start: number; end: number };
// Words for comparing speech with a written answer: lowercase, straight apostrophes, no punctuation or Markdown.
const wordsOf = (text: string): Word[] => [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
  .map(match => ({ text: match[0].toLowerCase().replace(/’/g, "'"), start: match.index, end: match.index + match[0].length }));
const phrasesOf = (words: readonly Word[]) => new Set(words.slice(2).map((word, index) => `${words[index].text} ${words[index + 1].text} ${word.text}`));

/** Which words of an utterance repeat a suggested answer: those in a three-word run the answer has too (`echoed`). Runs the
 * answer shares with its question (a coding answer restating the problem) also count as `read` only when other words
 * come from the answer's own wording, since on their own they may just be the interviewer asking again. */
function readWords(said: readonly Word[], answers: readonly ReadableAnswer[]) {
  const own = new Set<string>(); const shared = new Set<string>();
  for (const { question, answer } of answers) {
    const asked = phrasesOf(wordsOf(question));
    for (const phrase of phrasesOf(wordsOf(answer))) (asked.has(phrase) ? shared : own).add(phrase);
  }
  const mark = (phrases: Set<string>) => {
    const marked = said.map(() => false);
    for (let index = 0; index + 2 < said.length; index++) if (phrases.has(`${said[index].text} ${said[index + 1].text} ${said[index + 2].text}`)) marked[index] = marked[index + 1] = marked[index + 2] = true;
    return marked;
  };
  const answerOnly = mark(own); const echoed = mark(new Set([...own, ...shared]));
  return { answerOnly, read: answerOnly.filter(Boolean).length >= 4 ? echoed : answerOnly };
}

/** Whether an utterance is you reading a suggested answer aloud: most of its words repeat one. A short question that opens
 * with words of its own and then uses the answer's ("why would you use a hash map to store counts?") has to match almost
 * word for word; a reading that ends with your own check-in ("…Does that answer your question?") does not. */
export function readsAnswer(text: string, answers: readonly ReadableAnswer[], language = 'en-US') {
  const said = wordsOf(text); const { read } = readWords(said, answers); const count = read.filter(Boolean).length;
  const asked = said.length <= 20 && !read[0] && guessSpeaker(text, language) === 'interviewer';
  return count >= 4 && count >= said.length * (asked ? 0.9 : 0.6);
}

// Asking yourself something while thinking aloud ("…and how do we handle collisions"), not the interviewer asking you.
const selfTalk = /(?<![\p{L}\p{N}'])(?:(?:how|what|where|when|why|which|should|shall|do|does|did|can|could|would|will|if)\s+(?:i|we)|we|we're|we'd|we've|we'll|us|our|ours)(?![\p{L}\p{N}'])/iu;
const firstPerson = /(?<![\p{L}\p{N}'])(?:i|i'm|i've|i'd|i'll|me|my|we|we're|we've|we'd|our)(?![\p{L}\p{N}'])/iu;
// Interviewers often react before they ask ("Nice, I like that. So what was the hardest part?"); all of that is theirs.
const reaction = new RegExp(`^(?:nice|great|cool|awesome|okay|ok|interesting|gotcha|got it|perfect|thanks|thank you|makes sense|i see|that's (?:great|cool|awesome|interesting|fair|good))${wordEnd}`, 'iu');
// Someone cutting in tends to open with these; "so", "and", and "but" also start the candidate's own next thought.
const cutIn = /(?<![\p{L}\p{N}'])(?:oh|wait|sorry|hold on|hang on|quick question|real quick)(?![\p{L}\p{N}'])/giu;
const opensWithCutIn = new RegExp(`^${cutIn.source}`, 'iu');
/** Whether words open like someone cutting in ("oh, wait…"). */
export const cutsIn = (text: string) => opensWithCutIn.test(text.trim());
const cues = /^(?:(?:oh|wait|sorry|hold on|hang on|quick question|real quick|so|and|but|okay|ok|um+|uh+|hmm+)(?![\p{L}\p{N}'])[\s,.!…-]*)+/iu;
// You answering right away ("…how was that yeah it was great"), when the recognizer ran it all together.
const replyOpener = new RegExp(`^(?:yeah|yes|yep|yup|sure|no|nope|honestly|definitely|absolutely|it was|it's|it is|i|i'm|i've|i'd|i was|well|um+|uh+|mhm)${wordEnd}`, 'iu');

/** Where a cut-in cue opens a question ("…at Globex, oh wait, how long were you there"), or -1. */
function cutInStart(text: string, language: string) {
  for (const match of text.matchAll(cutIn)) if (likelyQuestion(text.slice(match.index).replace(cues, ''), language)) return match.index;
  return -1;
}

/** Where your reply starts after the interviewer's question, or -1. */
function replyStart(rest: string, language: string) {
  for (const word of wordsOf(rest).slice(2)) {
    const reply = rest.slice(word.start);
    if (replyOpener.test(reply.replace(/[‘’]/g, "'")) && wordsOf(reply).length >= 3 && guessSpeaker(reply, language) !== 'interviewer' && likelyQuestion(rest.slice(0, word.start), language)) return word.start;
  }
  return -1;
}

export type Interruption = { yours: string; theirs: string; reply?: string; read: boolean };
/** The interviewer cutting in on you: "…and before that I was at oh so how was that". `yours` is the part before (`read`
 * when you were reading a suggested answer aloud), `theirs` their question or remark, and `reply` you answering it right
 * away, when the recognizer ran all of it together. Without a reading, it takes you clearly mid-thought and them cutting
 * in with a question; `readingOnly` (the voice is already known to be the interviewer's) requires a reading. */
export function splitInterruption(text: string, answers: readonly ReadableAnswer[], language = 'en-US', readingOnly = false): Interruption | undefined {
  const said = wordsOf(text); if (said.length < 6) return undefined;
  const { read, answerOnly } = readWords(said, answers); const lastRead = read.lastIndexOf(true);
  const starts = [trailingQuestionStart(text), cutInStart(text, language), lastRead >= 0 && lastRead + 1 < said.length ? said[lastRead + 1].start : -1];
  // The earliest place that works, so a longer question is not cut short.
  for (const start of starts.filter(start => start > 0).sort((a, b) => a - b)) {
    const first = said.findIndex(word => word.start >= start);
    const yours = text.slice(0, start).replace(/[\s,;:–—-]+$/u, ''); const rest = text.slice(start).trim();
    const replyAt = replyStart(rest, language);
    const theirs = replyAt < 0 ? rest : rest.slice(0, replyAt).replace(/[\s,;:–—-]+$/u, ''); const count = wordsOf(theirs).length;
    if (first < 1 || count < 2 || count > 16 || guessSpeaker(theirs, language) !== 'interviewer' || selfTalk.test(theirs.replace(/[‘’]/g, "'"))) continue;
    // A question that is in the answer too ("…what was at stake, how did you communicate") is you still reading; one that
    // only repeats the original question is the interviewer asking again.
    if (answerOnly.slice(first, first + count).filter(Boolean).length >= count * 0.6) continue;
    const readBefore = read.slice(0, first).filter(Boolean).length;
    const reading = readBefore >= 4 && readBefore >= first * 0.6;
    const value = yours.replace(/[‘’]/g, "'");
    if (!reading && (readingOnly || first < 6 || !firstPerson.test(value) || reaction.test(value) || likelyQuestion(value, language) || !(opensWithCutIn.test(theirs) || endsMidPhrase(value)))) continue;
    return { yours, theirs, ...(replyAt < 0 ? {} : { reply: rest.slice(replyAt) }), read: reading };
  }
  return undefined;
}

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

/** Several stretches of speech as one print, weighted by how long each lasted; pitch comes only from those that had one. */
export function joinPrints(prints: readonly (VoicePrint | undefined)[]): VoicePrint | undefined {
  const heard = prints.filter((print): print is VoicePrint => !!print && print.seconds > 0); if (!heard.length) return undefined;
  const pitched = heard.filter(print => print.pitch !== undefined);
  const weighted = (list: VoicePrint[], value: (print: VoicePrint) => number) => list.reduce((sum, print) => sum + value(print) * print.seconds, 0) / list.reduce((sum, print) => sum + print.seconds, 0);
  return { ...(pitched.length ? { pitch: weighted(pitched, print => print.pitch!) } : {}), tilt: weighted(heard, print => print.tilt), level: weighted(heard, print => print.level), seconds: heard.reduce((sum, print) => sum + print.seconds, 0) };
}

// How far apart two stretches have to sound to count as the same person or different people: pitch in semitones (one
// person's stretches differ by 1–1.5, and by up to 5 with emphasis or laughter; a man and a woman by about 11), loudness in
// dB above the room, and brightness on a log scale. Loudness and brightness only back up pitch, since auto-gain, turning
// your head, and the sounds being said move them too. Strict asks for more, for when Deepgram's voice numbers disagree.
const sameVoice = { pitch: 1.5, level: 4, tilt: 0.4 };
const otherVoice = { pitch: 7, pitchWithCue: 4, level: 8, tilt: 0.6 };
const otherVoiceStrict = { pitch: 9, pitchWithCue: 5, level: 10, tilt: 0.8 };

/** Whether two stretches of speech sound like the same person or different people, or undefined if it is not clear. With
 * both people's voices learned, it asks voiceGuess about each; otherwise it compares the two stretches directly. */
export function voiceMatch(a: VoicePrint | undefined, b: VoicePrint | undefined, samples: readonly VoiceSample[] = [], strict = false): 'same' | 'different' | undefined {
  if (a?.pitch === undefined || b?.pitch === undefined || a.seconds < 0.6 || b.seconds < 0.6) return undefined;
  const first = voiceGuess(samples, a), second = voiceGuess(samples, b), sure = strict ? 5 : 3; // Strength 3 needs both voices learned.
  if (first && second && first.strength >= sure && second.strength >= sure) return first.speaker === second.speaker ? 'same' : 'different';
  const [pitchA, tiltA, levelA] = features(a) as number[], [pitchB, tiltB, levelB] = features(b) as number[];
  const pitch = Math.abs(pitchA - pitchB), tilt = Math.abs(tiltA - tiltB), level = Math.abs(levelA - levelB), other = strict ? otherVoiceStrict : otherVoice;
  if (pitch >= other.pitch || (pitch >= other.pitchWithCue && (level >= other.level || tilt >= other.tilt))) return 'different';
  return pitch <= sameVoice.pitch && level <= sameVoice.level && tilt <= sameVoice.tilt ? 'same' : undefined;
}

/** Whether the interviewer's voice and yours, as learned so far, are far enough apart to tell by sound (about 4 spreads). */
export function voicesDistinct(samples: readonly VoiceSample[]) {
  const interviewer = profile(samples, 'interviewer'), candidate = profile(samples, 'candidate'); if (!interviewer || !candidate) return false;
  let apart = 0;
  for (let dim = 0; dim < floors.length; dim++) { const a = interviewer[dim], b = candidate[dim]; if (a && b) apart += ((a.mean - b.mean) / Math.max(a.spread, b.spread)) ** 2; }
  return apart >= 16;
}

type Stretch = { id: number; early?: VoicePrint; print?: VoicePrint; ended: boolean; mine?: boolean };
/** Which stretches of speech since the last committed line belong to the line still open. They join it as its words arrive,
 * since recognizers lag behind the voice, and a stretch that sounds like someone else is kept for the next line. */
export class LineVoice {
  private stretches: Stretch[] = [];
  /** Whether any speech was heard this session (without the voice worklet, none ever is). */
  seen = false;
  add(segment: VoiceSegment) {
    if (segment.phase === 'start') { this.stretches.push({ id: segment.id, ended: false }); this.seen = true; return; }
    const stretch = this.stretches.find(item => item.id === segment.id); if (!stretch) return;
    if (segment.phase === 'early') stretch.early = segment.print; else { stretch.print = segment.print; stretch.ended = true; }
  }
  /** The open line's words grew: the stretches that ended since are theirs, or else the one still going. A stretch going on
   * after others ended is left alone, since it is probably the next person. */
  attach() {
    const ended = this.stretches.filter(item => item.mine === undefined && item.ended);
    for (const stretch of ended.length ? ended : this.going() && this.going()!.mine === undefined ? [this.going()!] : []) stretch.mine = true;
  }
  /** The stretch being heard now is someone else's; it goes to the next line. */
  release() { const stretch = this.going(); if (stretch) stretch.mine = false; }
  /** What the open line sounds like so far. */
  line() { return joinPrints(this.stretches.filter(item => item.mine).map(item => item.print ?? item.early)); }
  /** What the speech not yet in the line sounds like. */
  words() { return joinPrints(this.stretches.filter(item => item.mine === undefined).map(item => item.print ?? item.early)); }
  /** The stretch being heard now, once it is long enough to tell who it sounds like. */
  current() { const stretch = this.going(); return stretch?.early ? { id: stretch.id, print: stretch.early } : undefined; }
  /** The open line's print as it is committed; the rest waits for the next line. With `all`, everything heard counts. */
  take(all = false) {
    const print = all ? joinPrints(this.stretches.map(item => item.print ?? item.early)) : this.line();
    this.stretches = all ? [] : this.stretches.filter(item => !item.ended || !item.mine).map(item => ({ ...item, mine: undefined }));
    return print;
  }
  reset() { this.stretches = []; this.seen = false; }
  private going() { const last = this.stretches[this.stretches.length - 1]; return last && !last.ended ? last : undefined; }
}

export const speakerInstructions = `You label who said each line of a live job interview transcript. It comes from speech recognition, so words can be misheard and punctuation is often missing. For each numbered line, decide whether the interviewer (I) or the candidate (C) said it. The interviewer usually introduces themselves, the team, or the role, asks the questions, gives coding problems, and reacts briefly ("great", "okay, next question"); the candidate answers, describes their own experience in the first person, thinks aloud while solving problems, and asks clarifying questions or questions about the role. A short reaction such as "okay" or "yeah" usually comes from whoever is listening to the other person. When lines show a voice number, lines with the same number came from the same person. Some lines say who the voice sounds like, from a quick comparison of pitch and tone; that is usually right but can be wrong, especially for short lines. Reply with only a JSON object that maps every line number to "I" or "C", for example {"1":"I","2":"C"}.`;

const label = (speaker?: Speaker) => speaker === 'interviewer' ? 'Interviewer' : speaker === 'candidate' ? 'Candidate' : 'Unlabeled';
const voiceNote = (line: SpokenLine) => {
  const notes = [line.voice !== undefined && `voice ${line.voice + 1}`, line.heard && `sounds like the ${line.heard}`].filter(Boolean);
  return notes.length ? ` (${notes.join(', ')})` : '';
};

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
