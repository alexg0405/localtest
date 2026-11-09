// Live call translation: the Mandarin you hear, in English, and what you want to say, in simple Mandarin with pinyin.
// The page (TranslateApp.tsx) streams both through the Claude Code bridge, on your Claude subscription.
import type { ClaudeModel } from './claude';

/** Haiku 4.5 starts fastest, which matters more here than a slightly better translation. */
export const TRANSLATE_MODEL: ClaudeModel = 'claude-haiku-4-5';

export const hearInstructions = `You translate a live phone call for a listener who doesn't speak Mandarin. The other person speaks Mandarin Chinese; speech recognition turns it into text, sometimes with misheard words or missing punctuation.
Translate the newest line into natural, plain English.
- Reply with only the English translation of the newest line: no notes, quotes, pinyin, or labels.
- Use the earlier lines only as context: names, what "it" or "that" refers to, and words the recognizer got wrong.
- If a word was clearly misheard, translate what was meant. If part of it can't be made out, translate the rest and write [unclear] there.
- Keep names, company and product names, and numbers exactly. 小红书 is RedNote (Xiaohongshu).
- A line that is only a filler or a short reply (嗯, 对, 好的, 那个, 是的) gets a short translation ("Mm-hm.", "Right.", "Okay.", "Um...", "Yes.").`;

export const replyInstructions = `You help someone who doesn't speak Mandarin reply on a live phone call with a Mandarin speaker. Turn what they want to say (in English) into short, natural, polite spoken Mandarin that a beginner can read aloud.
Reply in exactly two lines:
1. The Mandarin, in simplified Chinese characters.
2. Its pinyin, with tone marks, a space between words.
Nothing else: no labels, numbering, or notes. Keep it simple and spoken, not formal or written. Keep names, company names, and numbers.`;

export type Said = { zh: string; en: string };
export type Reply = { english: string; zh: string; pinyin: string };

/** Recognizers often put spaces between Chinese words; Chinese is written without them. */
export const tidyChinese = (text: string) => text.replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1').trim();

/** The newest line, with the last few translated lines as context. */
export function hearPrompt(earlier: Said[], newest: string) {
  const context = earlier.filter(line => line.en.trim()).slice(-6).map(line => `Mandarin: ${line.zh}\nEnglish: ${line.en}`).join('\n\n');
  return `${context ? `Earlier in the call (context only, don't translate again):\n${context}\n\n` : ''}Newest line to translate:\n${newest}`;
}

/** What you want to say, with the last few things they said, so the reply fits the conversation. */
export function replyPrompt(english: string, earlier: Said[]) {
  const context = earlier.filter(line => line.en.trim()).slice(-4).map(line => `They said: ${line.en}`).join('\n');
  return `${context ? `The call so far (context):\n${context}\n\n` : ''}What I want to say:\n${english.trim()}`;
}

/** Claude's two lines (Mandarin, then pinyin), tolerating labels or numbering it shouldn't have added. */
export function parseReply(english: string, text: string): Reply {
  const han = /\p{Script=Han}/u;
  const lines = text.split('\n')
    .map(line => line.replace(/^\s*(\d+[.)、]|[-*•])\s*/u, '').replace(/^(mandarin|chinese|pinyin|中文|拼音)\s*[:：]\s*/iu, '').trim())
    .filter(Boolean);
  const zh = lines.find(line => han.test(line)) ?? lines[0] ?? '';
  const pinyin = lines.find(line => line !== zh && !han.test(line)) ?? '';
  return { english: english.trim(), zh, pinyin };
}

/** Phrases worth having ready before the call, with their pinyin. */
export const quickPhrases: Reply[] = [
  { english: "Sorry, my Chinese isn't very good.", zh: '不好意思，我的中文不太好。', pinyin: 'bù hǎo yìsi, wǒ de zhōngwén bú tài hǎo.' },
  { english: 'Could you speak a little slower, please?', zh: '请您说慢一点，谢谢。', pinyin: 'qǐng nín shuō màn yìdiǎn, xièxie.' },
  { english: 'Could you say that again?', zh: '可以再说一遍吗？', pinyin: 'kěyǐ zài shuō yí biàn ma?' },
  { english: 'Could we speak in English?', zh: '我们可以用英文吗？', pinyin: 'wǒmen kěyǐ yòng yīngwén ma?' },
  { english: 'One moment, please.', zh: '请稍等一下。', pinyin: 'qǐng shāo děng yíxià.' },
  { english: 'Okay, I understand.', zh: '好的，我明白了。', pinyin: 'hǎo de, wǒ míngbai le.' },
  { english: 'Thank you!', zh: '谢谢您！', pinyin: 'xièxie nín!' },
];

/** The most natural Mandarin voice the browser has (Edge's natural voices first). */
export function mandarinVoice(voices: SpeechSynthesisVoice[]) {
  const mandarin = voices.filter(voice => /^zh[-_](CN|Hans)/i.test(voice.lang) || voice.lang.toLowerCase() === 'zh');
  const rank = (voice: SpeechSynthesisVoice) => (/natural|online/i.test(voice.name) ? 2 : 0) + (/xiaoxiao|xiaoyi|yunxi|google/i.test(voice.name) ? 1 : 0);
  return mandarin.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
