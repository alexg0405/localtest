import { describe, expect, it } from 'vitest';
import { hearPrompt, mandarinVoice, parseReply, quickPhrases, replyPrompt, tidyChinese } from './translate';

describe('call translation', () => {
  it('writes Chinese without the spaces recognizers put between words', () => {
    expect(tidyChinese('你好 我 是 小红书 的 招聘')).toBe('你好我是小红书的招聘');
    expect(tidyChinese('我们 用 React 和 Go')).toBe('我们用 React 和 Go');
  });

  it('translates the newest line with the last few as context', () => {
    const earlier = Array.from({ length: 8 }, (_, i) => ({ zh: `第${i}句`, en: `Line ${i}` }));
    const prompt = hearPrompt(earlier, '你什么时候可以开始？');
    expect(prompt).toContain('Newest line to translate:\n你什么时候可以开始？');
    expect(prompt).toContain('English: Line 7') ;
    expect(prompt).not.toContain('Line 1\n');   // only the last six
    expect(hearPrompt([], '你好')).toBe('Newest line to translate:\n你好');
  });

  it('gives the reply what they just said', () => {
    const prompt = replyPrompt('  I can start in June. ', [{ zh: '你什么时候可以开始？', en: 'When can you start?' }]);
    expect(prompt).toContain('They said: When can you start?') ;
    expect(prompt.endsWith('What I want to say:\nI can start in June.')).toBe(true);
  });

  it('reads the Mandarin and pinyin lines, even with labels', () => {
    expect(parseReply('Thanks', '谢谢您！\nxièxie nín!')).toEqual({ english: 'Thanks', zh: '谢谢您！', pinyin: 'xièxie nín!' });
    expect(parseReply('Thanks', '1. Mandarin: 谢谢您！\n2. Pinyin: xièxie nín!')).toEqual({ english: 'Thanks', zh: '谢谢您！', pinyin: 'xièxie nín!' });
    expect(parseReply('Hi', '你好')).toEqual({ english: 'Hi', zh: '你好', pinyin: '' });
  });

  it('has quick phrases ready, each with pinyin', () => {
    expect(quickPhrases.length).toBeGreaterThan(4);
    expect(quickPhrases.every(phrase => /\p{Script=Han}/u.test(phrase.zh) && phrase.pinyin && phrase.english)).toBe(true);
  });

  it('picks a natural Mandarin voice', () => {
    const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;
    const voices = [voice('Microsoft Huihui - Chinese (Simplified)', 'zh-CN'), voice('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', 'zh-CN'), voice('Microsoft Aria', 'en-US')];
    expect(mandarinVoice(voices)?.name).toContain('Xiaoxiao');
    expect(mandarinVoice([voice('Microsoft Aria', 'en-US')])).toBeNull();
  });
});
