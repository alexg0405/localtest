// Pure text heuristics for question detection and answer formatting (no React or browser APIs).

export type QuestionKind = 'SMALL TALK' | 'BEHAVIORAL' | 'CODING' | 'TECHNICAL' | 'DISCUSSION';

/** Lowercase text without punctuation, used to compare interim and final wording of the same utterance. */
export const compactText = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

// `\b` is ASCII-only in JavaScript, so accented starters like "qué" need a Unicode-aware word end.
const startsWith = (words: string) => new RegExp(`^(?:${words})(?![\\p{L}\\p{N}])`, 'iu');
const fillers = /^(?:(?:hey|hi|hello|thanks|thank you|so|okay|ok|alright|all right|right|well|and|now|next|also|then|great|cool|oh|wait|sorry|hold on|hang on|um+|uh+|hmm+|bueno|entonces|vale|pues|y|alors|bon|et|donc|und|gut|então|bom|e)(?![\p{L}\p{N}'])[\s,.:;!…-]*)+/iu;
const english = [
  startsWith('what|why|when|where|which|who|whom|whose|how|can|could|would|will|should|shall|may|do|does|did|is|are|was|were|have|has'),
  startsWith("tell me|tell us|share an example|share a time|give me an example|give an example|describe|explain|walk me through|walk us through|talk me through|talk us through|i'd like you to|i would like you to|i'd like to hear|i would like to hear|i want you to|i'm curious|i am curious|let's talk about|let's discuss|let me ask|(?:my |the |one |another |a )?(?:next |first |last |final |follow-up |followup )?question"),
];
// Task openers are also how candidates think aloud ("…then return the result"), so they only count at the very start.
const tasks = startsWith("given|implement|write|find|return|design|calculate|suppose|assume|imagine|compare|define|elaborate|talk about|you are given|you're given|let's say|say you|if you had to|if you were");
// "What I did was…" and "…, I would use a hash map" are the candidate talking, not a question.
const statement = /^(?:what|how|why|when|where|which|who)\s+(?:i|we)(?:'m|'ve|'d|'ll|'re)?(?![\p{L}\p{N}])/iu;
// A question that ends a longer utterance ("not much, how are you doing") unless a statement leads into it ("not sure what is best").
const trailingQuestion = /(?<![\p{L}\p{N}'])(?:(?:how|what|why|when|where|which|who)(?:'s|'re|\s+(?:is|are|was|were|do|does|did|can|could|would|should|will|have|has|about))|(?:are|do|did|can|could|would|will|have|is)\s+(?:you|we|they|it|there))(?:\s+[\p{L}\p{N}'-]+){0,6}\s*$/iu;
const statementLead = /(?<![\p{L}\p{N}'])(?:that|this|it|there|he|she|they|we|i|you|know|knew|wonder|understand|understood|see|sure|idea|explain|tell|told|ask|asked|remember|decide|decided|learn|learned|show|about|of|on)[\s,]*$/iu;
const endsWithQuestion = (value: string) => {
  if (/(?<![\p{L}\p{N}'])(?:and|how about|what about)\s+you\s*$/iu.test(value)) return true;
  const match = trailingQuestion.exec(value);
  return !!match && !statementLead.test(value.slice(0, match.index));
};
// Words someone cutting in opens with ("oh, so how was that").
const cutInLead = /(?:(?<![\p{L}\p{N}'])(?:oh|wait|sorry|okay|ok|so|and|but|hmm+|um+|uh+)(?![\p{L}\p{N}'])[\s,.!…-]*)+$/iu;
/** Where the question that ends a longer utterance starts, with the words someone cutting in opens with ("…I was at oh so
 * how was that" gives the index of "oh"), or -1 when the utterance does not end with one. */
export function trailingQuestionStart(text: string) {
  // Only trailing punctuation goes and apostrophes stay one character, so the index still points into `text`.
  const value = text.replace(/[‘’]/g, "'").replace(/[\s?？.!…"'”)\]]+$/u, '');
  const match = trailingQuestion.exec(value);
  if (!match?.index || statementLead.test(value.slice(0, match.index))) return -1;
  return cutInLead.exec(value.slice(0, match.index))?.index ?? match.index;
}
const firstPersonPlan = /(?<![\p{L}\p{N}'])(?:i|we)(?:'d|'ll|'m going to| would| will| am going to| are going to| think| guess)(?![\p{L}\p{N}])(?! like you| love you| want you)/iu;
// Chrome's recognizer adds no punctuation, so each supported language needs its own question cues.
const localized: Record<string, RegExp[]> = {
  es: [startsWith('qué|cómo|por qué|cuál|cuáles|cuándo|dónde|quién|quiénes|cuánto|cuántos|cuánta|cuántas|puedes|podrías|podría|puede|explica|explícame|explique|describe|descríbeme|describa|háblame|hábleme|cuéntame|cuénteme|dime|compara|define')],
  fr: [startsWith("qu'est-ce|quel|quelle|quels|quelles|comment|pourquoi|quand|où|qui|combien|est-ce que|pouvez-vous|peux-tu|pourriez-vous|pourrais-tu|expliquez|explique|décrivez|décris|parlez-moi|parle-moi|racontez-moi|raconte-moi|donnez-moi|comparez")],
  de: [startsWith('was|wie|warum|wieso|weshalb|wann|wo|woher|wohin|wer|wen|wem|welche|welcher|welches|welchen|können sie|kannst du|könnten sie|könntest du|haben sie|hast du|sind sie|bist du|gibt es|würden sie|würdest du|erklären sie|erkläre|erklär|beschreiben sie|beschreibe|erzählen sie|erzähl|vergleichen sie|nennen sie')],
  pt: [startsWith('o que|o quê|que|qual|quais|como|por que|por quê|quando|onde|quem|quanto|quantos|quanta|quantas|você pode|você poderia|pode|poderia|explique|explica|descreva|descreve|fale sobre|fale-me|me fale|me conte|conte-me|conte|compare|defina')],
  ja: [/(?<!と)か[?？。．!！\s]*$/u, /(教えて|説明して|話して|聞かせて|紹介して|述べて)(ください|下さい|くれますか|もらえますか|いただけますか)?[。．!！\s]*$/u],
  zh: [/[吗嗎呢][?？。．!！\s]*$/u, /(\p{Script=Han})[不没沒]\1/u, /(什么|什麼|怎么|怎麼|怎样|怎樣|为什么|為什麼|为何|為何|哪(个|個|些|里|裡|儿|兒|种|種)|谁|誰|多少|如何|是否|能否|能不能|可不可以|会不会|會不會|有没有|有沒有|是不是)/u, /(请|請)(你|您)?(介绍|介紹|解释|解釋|说明|說明|描述|讲|講|谈|談|说|說|比较|比較|举|舉)/u, /(说说|說說|讲讲|講講|谈谈|談談|介绍一下|介紹一下|解释一下|解釋一下|描述一下|举个例子|舉個例子)/u],
};
// Question words inside common statements ("没什么问题", "我不知道为什么").
const localizedStatements: Record<string, RegExp> = { zh: /(没什么|沒什麼|没有什么|沒有什麼|(?<!知)不知道|什么都|什麼都|什么也|什麼也|什么的|什麼的)/u };
const baseLanguage = (language: string) => language.slice(0, 2).toLowerCase();

export function likelyQuestion(text: string, language = 'en-US') {
  const value = text.trim().replace(/[‘’]/g, "'");
  if (value.length < 3) return false;
  if (/[?？]["'”)\]]*$/u.test(value) || value.startsWith('¿')) return true;
  const spoken = value.replace(fillers, '');
  if (statement.test(spoken) || firstPersonPlan.test(value)) return false;
  const local = localizedStatements[baseLanguage(language)]?.test(value) ? [] : localized[baseLanguage(language)] ?? [];
  return tasks.test(value) || [...english, ...local].some(pattern => pattern.test(spoken) || pattern.test(value)) || endsWithQuestion(spoken);
}

/** Whether an utterance stops mid-phrase ("Can you walk me through…"), so the next one probably finishes the question. */
export function endsMidPhrase(text: string) {
  const asked = /[?？]["'”)\]]*\s*$/u.test(text);
  const value = text.trim().replace(/[?？.,!…:;"'”)\]]+$/u, '');
  if (value.split(/\s+/).length < 3) return false;
  // With a question mark, only words that cannot end a finished question count ("what are you proud of?" is finished).
  // Without one, also verbs that need an object in interview questions ("how would you design…").
  return (asked ? /(?<![\p{L}\p{N}'])(through|between|the|a|an|your|my|our|their|and|or|but)$/iu : /(?<![\p{L}\p{N}'])(through|about|of|for|with|to|from|between|the|a|an|your|my|our|their|and|or|but|how|what|why|when|which|that|if|in|on|at|by|like|is|are|was|were|design|implement|explain|describe|compare|define|optimize|approach|handle|tell|walk|give|share|show|name)$/iu).test(value);
}

/** Whether an utterance opens like a reply ("sure…", "yeah…", "I think…") rather than finishing someone else's sentence. */
export const startsLikeReply = (text: string) => /^(?:sure|yes|yeah|yep|yup|no|nope|nah|okay|ok|right|well|um+|uh+|hmm+|great|thanks|thank you|absolutely|definitely|of course|good question|that's|it's|i|i'm|i've|i'd|i'll|my|we)(?![\p{L}\p{N}'])/iu.test(text.trim().replace(/[‘’]/g, "'"));

/** Whether an interim transcript is long enough to start a draft answer (CJK packs more meaning per character). */
export const draftReady = (text: string, language = 'en-US') => text.trim().length >= (/^(ja|zh)$/.test(baseLanguage(language)) ? 8 : 24);

export function questionKind(question: string): QuestionKind | '' {
  if (!question.trim()) return '';
  if (/\b(how are you|how're you|how you doing|how's (it going|your|everything|things|life)|how (was|is) your (day|weekend|morning|week)|how have you been|how are things|what'?s up|nice to meet you|good (morning|afternoon|evening))\b/i.test(question)) return 'SMALL TALK';
  if (/\b(tell (me|us) about|(a )?time (when )?you|disagree[ds]?|challenges?|conflicts?|failures?|leadership|strengths?|weakness(es)?|mistakes?)\b/i.test(question)) return 'BEHAVIORAL';
  if (/\b(code|coding|implement|algorithms?|functions?|arrays?|linked lists?|trees?|sort(ing|ed)?(?! of\b)|reverse|complexity|big o|recursion|write an?|binary search)\b/i.test(question)) return 'CODING';
  if (/\b(what|how|why|when|where|which|explain|describe|difference|compare)\b/i.test(question)) return 'TECHNICAL';
  return 'DISCUSSION';
}

export function isFollowUp(question: string, recent: string) {
  return !!recent.trim() && /^(and\s+(what|how|why|its|their|those|that)|what about|how about|what if|why is that|why not|how so|can you expand|could you expand|can you elaborate|could you elaborate|tell me more|what did you mean|same for|what happens if)\b/i.test(question.trim());
}

export type AnswerBlock = { type: 'heading' | 'bullet' | 'paragraph' | 'code'; text: string } | { type: 'label'; label: string; text: string };
export type InlineSegment = { text: string; bold?: boolean; code?: boolean };

// Section names from the answer prompt; "Situation: …" renders as a labelled line rather than a shouting heading.
const sectionLabel = /^(situation|task|action|result|direct answer|short answer|key concepts?|key points?|approach|complexity|pseudocode|implementation|code|edge cases?|examples?|common follow-up|likely follow-up|suggested answer|supporting detail|trade-?offs?|summary|the problem|my thinking|what i['’]?d use|what i would use)\s*[:：]\s*(.+)$/i;
const allCapsHeading = /^(?=(?:[^\p{Lu}]*\p{Lu}){2})[\p{Lu}\p{N}\s&/'’()+,·-]{3,48}[:：]?$/u;

/** Splits plain-text (or lightly Markdown-formatted) model output into renderable blocks. */
export function parseAnswer(answer: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []; let code: string[] | null = null;
  for (const raw of answer.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { if (code) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; } else code = []; continue; }
    if (code) { code.push(raw.replace(/\s+$/, '')); continue; }
    const line = raw.trim();
    if (!line || /^([-*_])(\s*\1){2,}$/.test(line)) continue;
    // A bold-only line is a heading when it reads like a title; a bold sentence stays a paragraph.
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/) || line.match(/^\*\*([^*.?!]{1,48}?)[:：]?\*\*[:：]?$/);
    if (heading) { blocks.push({ type: 'heading', text: heading[1].replace(/\*\*/g, '').replace(/[:：]$/, '').trim() }); continue; }
    const bullet = line.match(/^•\s*(.+)$/) || line.match(/^[-*–]\s+(.+)$/);
    if (bullet) { blocks.push({ type: 'bullet', text: bullet[1] }); continue; }
    if (allCapsHeading.test(line)) { blocks.push({ type: 'heading', text: line.replace(/[:：]$/, '') }); continue; }
    const label = line.match(/^\*\*([^*]{1,40}?)(?:[:：]\*\*|\*\*[:：])\s*(.+)$/) || line.match(sectionLabel);
    if (label) { blocks.push({ type: 'label', label: label[1].trim(), text: label[2].trim() }); continue; }
    blocks.push({ type: 'paragraph', text: line });
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') }); // Fence still open while the answer streams.
  return blocks;
}

/** Splits a line into plain, **bold**, and `code` segments. */
export const inlineSegments = (text: string): InlineSegment[] => text.split(/(\*\*[^*\n]+?\*\*|`[^`\n]+`)/).filter(Boolean).map(part =>
  part.length > 4 && part.startsWith('**') && part.endsWith('**') ? { text: part.slice(2, -2), bold: true }
    : part.length > 2 && part.startsWith('`') && part.endsWith('`') ? { text: part.slice(1, -1), code: true }
      : { text: part });
