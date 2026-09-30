// The review of a practice session: for each question the interviewer asked, what you said back, measured from the
// transcript (how much was your own words or read from a suggested answer, how long, filler words, and a few checks for
// that kind of question), plus coaching from the answer provider on top (coachPrompt and parseCoaching).
import { liveStep, type LiveTurn } from './live';
import { isClarifyingQuestion, lastAsk, nearestVoice, voiceSamples, type SpokenLine } from './speakers';
import { isFollowUp, likelyQuestion, questionKind, type QuestionKind } from './text';

export type ReviewLine = SpokenLine & { at: number };
export type ReviewCheck = { label: string; done: boolean };
export type QuestionReview = {
  n: number; question: string; kind: QuestionKind | ''; at: number;
  /** Your words in reply: your own, and read aloud from a suggested answer. */
  ownWords: number; readWords: number;
  fillers: { word: string; count: number }[]; fillerCount: number;
  checks: ReviewCheck[];
  /** What you said, in order. */
  said: string[];
};
export type SessionReview = { questions: QuestionReview[]; minutes: number; yourWords: number; theirWords: number; readWords: number; fillerCount: number };

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
// About 150 spoken words a minute.
export const speakingSeconds = (count: number) => Math.round(count / 2.5);

// Fillers in your own words, with what each is shown as. "Like" counts only set off by commas ("so, like, a…").
const fillerPatterns: [string, RegExp][] = [
  ['um / uh', /(?<![\p{L}\p{N}'])(?:um+|uh+|erm*|hmm+)(?![\p{L}\p{N}'])/giu],
  ['like', /(?:^|[,.;]\s*)like(?=\s*,)|,\s*like(?![\p{L}\p{N}'])(?!\s+(?:a|the|this|that|to|it|when|how|what)\b)/giu],
  ['you know', /(?<![\p{L}\p{N}'])you know(?![\p{L}\p{N}'])(?!\s+(?:what|how|why|the|that|if|when|where)\b)/giu],
  ['I mean', /(?<![\p{L}\p{N}'])i mean(?![\p{L}\p{N}'])/giu],
  ['kind of / sort of', /(?<![\p{L}\p{N}'])(?:kind|sort) of(?![\p{L}\p{N}'])/giu],
  ['basically', /(?<![\p{L}\p{N}'])basically(?![\p{L}\p{N}'])/giu],
  ['literally', /(?<![\p{L}\p{N}'])literally(?![\p{L}\p{N}'])/giu],
  ['actually', /(?<![\p{L}\p{N}'])actually(?![\p{L}\p{N}'])/giu],
  ['so yeah', /(?<![\p{L}\p{N}'])so yeah(?![\p{L}\p{N}'])/giu],
  ['repeated words', /(?<![\p{L}\p{N}'])([\p{L}']+)[\s,]+\1(?![\p{L}\p{N}'])/giu],
];
/** Filler words and repeats in what you said, most frequent first. */
export function countFillers(text: string) {
  const value = text.replace(/[‘’]/g, "'");
  return fillerPatterns.map(([word, pattern]) => ({ word, count: [...value.matchAll(pattern)].length })).filter(item => item.count).sort((a, b) => b.count - a.count);
}

const complexity = /(?<![\p{L}\p{N}'])(?:o\s*\(|o of |big o|linear|constant (?:time|space)|log(?:arithmic)? (?:time|n)|n log n|n squared|quadratic)/iu;
const example = /(?<![\p{L}\p{N}'])(?:for example|for instance|let's say|say we have|if the (?:input|array|list|string) is|walk(?:ing)? through|an example|e\.g\.)|\d+\s*(?:,|→|->|to)\s*\d+\s*(?:,|→|->|to)\s*\d+/iu;
const edgeCase = /(?<![\p{L}\p{N}'])(?:edge case|empty|null|none|single (?:node|element|item)|odd (?:number|length)|duplicates?|negative|overflow|zero)(?![\p{L}\p{N}'])/iu;
const yourAction = /(?<![\p{L}\p{N}'])i (?:decided|built|wrote|talked|set up|proposed|suggested|pushed|led|made|fixed|reached out|asked|sat down|walked|pulled|added|found|changed|convinced|explained)(?![\p{L}\p{N}'])/iu;
const outcome = /(?<![\p{L}\p{N}'])(?:in the end|ended up|result(?:ed)?|outcome|shipped|launched|it worked|we finished|learned|realized|taught me|it helps|it helped|since then|next time|takeaway|turned out)(?![\p{L}\p{N}'])/iu;
const specifics = /(?<![\p{L}\p{N}'])(?:when i was|at my|on my|during my|last (?:summer|year|semester|month)|this (?:summer|year|semester)|my (?:internship|team|manager|project|class))(?![\p{L}\p{N}'])/iu;

function checksFor(kind: QuestionKind | '', own: string, askedSomething: boolean): ReviewCheck[] {
  if (kind === 'CODING') return [
    { label: 'Asked a clarifying question', done: askedSomething },
    { label: 'Walked through an example', done: example.test(own) },
    { label: 'Covered an edge case', done: edgeCase.test(own) },
    { label: 'Stated the time and space complexity', done: complexity.test(own) },
  ];
  if (kind === 'BEHAVIORAL') return [
    { label: 'Set up a specific situation', done: specifics.test(own) },
    { label: 'Said what you did', done: yourAction.test(own) },
    { label: 'Shared the result or what you learned', done: outcome.test(own) },
  ];
  return [];
}

/** Each question in a conversation and what you said back, by the same reading of the lines as the live answer. */
export function reviewSession(lines: readonly ReviewLine[], language = 'en-US'): SessionReview {
  const questions: QuestionReview[] = []; let turn: LiveTurn | null = null; let current: QuestionReview | null = null;
  let yourWords = 0, theirWords = 0, readWords = 0;
  lines.forEach((line, index) => {
    const read = line.by === 'answer'; const count = words(line.text);
    // A line nobody labeled goes by who it sounds like lately, as it did in the live answer.
    const earlier = lines.slice(Math.max(0, index - 8), index); const speaker = read ? 'candidate' : line.speaker ?? nearestVoice(earlier, line.print, voiceSamples(earlier));
    const ask = read || speaker === 'candidate' ? undefined : lastAsk(line.text, language);
    const step = liveStep(turn, { text: line.text, speaker, read, clarifying: isClarifyingQuestion(line.text), question: likelyQuestion(line.text, language), ask });
    const before = turn?.said.length ?? 0; const asking = !!turn?.question; turn = step.turn;
    // Each question starts its own review: a new one, or one that what they were saying led up to (shown by the question
    // itself, not the small talk before it). More of the same question renames it.
    // A follow-up ("And how did it end up?") is the same kind of question as the one it follows.
    const kindOf = (question: string) => { const last = questions[questions.length - 1]; return last && isFollowUp(question, last.question) ? last.kind : questionKind(question); };
    const start = (question: string) => { current = { n: questions.length + 1, question, kind: kindOf(question), at: line.at, ownWords: 0, readWords: 0, fillers: [], fillerCount: 0, checks: [], said: [] }; questions.push(current); };
    if (step.action === 'new' && step.turn.question) start(step.turn.asked);
    else if (step.action === 'update' && step.turn.question && !asking) start(ask ?? step.turn.asked);
    else if (step.action === 'update' && current && step.turn.question) { current.question = step.turn.asked; current.kind = questionKind(step.turn.asked); }
    // Yours when it joins what you have said in reply (so "yeah" and "thank you" do not count, and neither do lines
    // before the first question), or when you check something with them, which the live answer leaves alone but a review
    // of a coding answer needs.
    const checking = !read && speaker !== 'interviewer' && isClarifyingQuestion(line.text);
    const item = current as QuestionReview | null;
    if ((turn?.said.length ?? 0) > before || (checking && item)) {
      yourWords += count; if (read) readWords += count;
      if (item) { item.said.push(line.text); if (read) item.readWords += count; else item.ownWords += count; }
    } else if (speaker !== 'candidate') theirWords += count;
  });
  for (const item of questions) {
    const own = item.said.join(' ');
    item.fillers = countFillers(own); item.fillerCount = item.fillers.reduce((sum, filler) => sum + filler.count, 0);
    item.checks = checksFor(item.kind, own, item.said.some(text => isClarifyingQuestion(text) || /[?？]\s*$/.test(text.trim())));
  }
  const minutes = lines.length > 1 ? Math.max(1, Math.round((lines[lines.length - 1].at - lines[0].at) / 60_000)) : 0;
  return { questions, minutes, yourWords, theirWords, readWords, fillerCount: questions.reduce((sum, item) => sum + item.fillerCount, 0) };
}

/** The coaching request: the latest 15 questions (numbered from 1, as the coach's reply numbers them), what you said to
 * each, and the checks above. `role` is what you are interviewing for. */
export function coachPrompt(review: SessionReview, role = '') {
  const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
  return [role.trim() && `The candidate is interviewing for: ${role.trim()}`, ...review.questions.slice(-15).map((item, index) => {
    const total = item.ownWords + item.readWords; const read = total ? Math.round((item.readWords / total) * 100) : 0;
    const checks = item.checks.map(check => `${check.done ? 'yes' : 'no'}: ${check.label.toLowerCase()}`).join('; ');
    return `Question ${index + 1}${item.kind ? ` (${item.kind.toLowerCase()})` : ''}: ${clip(item.question, 400)}\nWhat the candidate said (${total} words${read ? `, ${read}% read aloud from a suggested answer` : ''}): ${total ? `"${clip(item.said.join(' '), 1500)}"` : 'nothing'}${checks ? `\nChecks: ${checks}` : ''}${item.fillerCount ? `\nFiller words: ${item.fillers.map(filler => `${filler.word} ×${filler.count}`).join(', ')}` : ''}`;
  })].filter(Boolean).join('\n\n');
}

export type Coaching = { questions: Map<number, { good: string; improve: string }>; overall: string[] };
/** Reads the coach's JSON reply; anything missing or unusable is left out. */
export function parseCoaching(output: string): Coaching | null {
  const match = output.match(/\{[\s\S]*\}/); if (!match) return null;
  let data: any; try { data = JSON.parse(match[0]); } catch { return null; }
  const text = (value: unknown) => typeof value === 'string' ? value.replace(/\*\*/g, '').replace(/(?<![\w*])[*_](\S(?:[^*_]*\S)?)[*_](?![\w*])/g, '$1').trim() : ''; // No Markdown emphasis.
  const questions = new Map<number, { good: string; improve: string }>();
  for (const item of Array.isArray(data?.questions) ? data.questions : []) {
    const n = Number(item?.n); if (Number.isInteger(n) && n > 0 && (text(item?.good) || text(item?.improve))) questions.set(n, { good: text(item?.good), improve: text(item?.improve) });
  }
  const overall = (Array.isArray(data?.overall) ? data.overall : []).map(text).filter(Boolean).slice(0, 3);
  return questions.size || overall.length ? { questions, overall } : null;
}
