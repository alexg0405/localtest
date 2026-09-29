import { describe, expect, it } from 'vitest';
import { compactText, draftReady, endsMidPhrase, inlineSegments, isFollowUp, likelyQuestion, parseAnswer, questionKind } from './text';

const expectEach = (values: string[], check: (value: string) => boolean, expected: boolean) => { for (const value of values) expect(check(value), value).toBe(expected); };

describe('likelyQuestion', () => {
  it('detects English questions and interviewer prompts', () => {
    expectEach(['What is the difference between a process and a thread', 'how does garbage collection work', 'Tell me about a time you failed', 'Walk me through your resume', 'Given an array of integers return the max', 'Is it thread safe', 'Is this a question?', 'Describe TLS', 'Implement an LRU cache', 'Tell me about yourself.', "Given an array, I'd like you to find the max", 'Can I use Python?', 'What would I need to change?'], likelyQuestion, true);
    expectEach(['ok', 'I worked at Google for three years', 'That makes sense', 'Thanks for having me', ''], likelyQuestion, false);
  });

  it('looks past spoken lead-ins', () => {
    expectEach(['So what is a hash map', 'Okay, so how would you scale this', 'Alright tell me about yourself', 'So, tell me about yourself', 'Um, can you explain closures', 'Next question: how do you handle conflict', "I'd like you to design a URL shortener", "Let's talk about your experience with Kubernetes", 'And why is that', 'I’m curious how you’d approach caching'], likelyQuestion, true);
    expectEach(['Some people prefer tabs', 'Android development is fun', 'Nowadays I mostly write Go', 'Questions are welcome at the end', 'Okay', 'So yeah'], likelyQuestion, false);
  });

  it('ignores the candidate thinking aloud', () => {
    expectEach(['Then return the result.', 'Next, find the maximum', 'So what I did was add a cache.', 'Okay, so given the constraints, I would use a hash map.', 'What I did was add a cache', 'How we handled it was with retries', "What I'd do is shard by user"], likelyQuestion, false);
  });

  it('accepts question punctuation in any language', () => {
    expectEach(['这是一个问题？', '¿Puedes explicarlo', 'You used React?"'], likelyQuestion, true);
  });

  it('uses question cues for the selected language', () => {
    const questions: [string, string][] = [
      ['es', 'qué es un proceso'], ['es', 'Bueno, cuéntame sobre tu experiencia'], ['fr', 'pourquoi voulez-vous ce poste'], ['fr', "qu'est-ce qu'un thread"],
      ['de', 'was ist ein Prozess'], ['de', 'Können Sie das erklären'], ['pt-BR', 'o que é um processo'], ['pt-BR', 'me conte sobre um desafio'],
      ['ja', 'プロセスとスレッドの違いは何ですか'], ['ja', 'あなたの経験について教えてください'], ['zh-CN', '进程和线程有什么区别'], ['zh-CN', '请介绍一下你自己'], ['zh-CN', '你用过React吗'], ['zh-CN', '你知不知道进程和线程的区别'],
    ];
    for (const [language, text] of questions) expect(likelyQuestion(text, language), `${language}: ${text}`).toBe(true);
    const statements: [string, string][] = [['es', 'trabajé en un banco'], ['fr', "j'ai travaillé à Paris"], ['de', 'ich arbeite bei SAP'], ['ja', 'PythonとかJavaとか'], ['ja', '私はエンジニアです'], ['zh-CN', '我在北京工作'], ['zh-CN', '哪怕很难'], ['zh-CN', '没什么问题'], ['zh-CN', '我不知道为什么']];
    for (const [language, text] of statements) expect(likelyQuestion(text, language), `${language}: ${text}`).toBe(false);
    expect(likelyQuestion('cómo manejas los conflictos', 'en-US')).toBe(false);
  });
});

describe('question helpers', () => {
  it('draftReady waits for fewer characters in CJK languages', () => {
    expect(draftReady('what is a hash map', 'en-US')).toBe(false);
    expect(draftReady('what is the difference between', 'en-US')).toBe(true);
    expect(draftReady('进程和线程有什么区别', 'zh-CN')).toBe(true);
  });

  it('questionKind tags the question type', () => {
    expect(questionKind('')).toBe('');
    expect(questionKind('Tell me about a time you disagreed')).toBe('BEHAVIORAL');
    expect(questionKind('Describe a time when you had to lead')).toBe('BEHAVIORAL');
    expect(questionKind('Reverse a linked list')).toBe('CODING');
    expect(questionKind('How would you sort a million integers')).toBe('CODING');
    expect(questionKind('What sort of projects have you worked on?')).toBe('TECHNICAL');
    expect(questionKind('What street do you live on?')).toBe('TECHNICAL');
    expect(questionKind('Our team values ownership')).toBe('DISCUSSION');
  });

  it('isFollowUp needs earlier conversation', () => {
    expect(isFollowUp('What if the input is empty?', 'Reverse a list')).toBe(true);
    expect(isFollowUp('What if the input is empty?', '')).toBe(false);
  });

  it('compactText ignores case and punctuation', () => {
    expect(compactText('What is a Hash-Map?')).toBe(compactText('what is a hashmap'));
    expect(compactText('¿Qué es?')).toBe('qué es');
  });

  it('endsMidPhrase spots questions cut off by a pause', () => {
    expectEach(['Can you walk me through', 'Tell me about your', "What's the difference between", 'Can you walk me through?'], endsMidPhrase, true);
    expectEach(['What is a hash map', 'Why?', 'What is', 'Can you walk me through your latest project?'], endsMidPhrase, false);
  });
});

describe('parseAnswer', () => {
  it('reads the demo formats', () => {
    expect(parseAnswer('A process is isolated.\n\nKEY CONCEPTS\n• Processes are isolated\n•No space bullet\n\nSUPPORTING DETAIL\nMore text.')).toEqual([
      { type: 'paragraph', text: 'A process is isolated.' },
      { type: 'heading', text: 'KEY CONCEPTS' },
      { type: 'bullet', text: 'Processes are isolated' },
      { type: 'bullet', text: 'No space bullet' },
      { type: 'heading', text: 'SUPPORTING DETAIL' },
      { type: 'paragraph', text: 'More text.' },
    ]);
    expect(parseAnswer('Situation: [Recall a specific moment]\nResult: [Share the outcome]')).toEqual([
      { type: 'label', label: 'Situation', text: '[Recall a specific moment]' },
      { type: 'label', label: 'Result', text: '[Share the outcome]' },
    ]);
  });

  it('keeps sentences that merely start with a section word as paragraphs', () => {
    for (const line of ['Resulting lookups are constant time.', 'Examples include Python dicts.', 'Tasks are scheduled by the OS.', 'Actionable feedback matters.', 'Approaching it iteratively helps.']) expect(parseAnswer(line), line).toEqual([{ type: 'paragraph', text: line }]);
  });

  it('understands light Markdown from models', () => {
    expect(parseAnswer('**Direct answer:** Use a map.\n## Key concepts\n- Buckets\n* Resizing\n**Trade-offs**\n---\nDIRECT ANSWER:\n1. First step\nO(1)')).toEqual([
      { type: 'label', label: 'Direct answer', text: 'Use a map.' },
      { type: 'heading', text: 'Key concepts' },
      { type: 'bullet', text: 'Buckets' },
      { type: 'bullet', text: 'Resizing' },
      { type: 'heading', text: 'Trade-offs' },
      { type: 'heading', text: 'DIRECT ANSWER' },
      { type: 'paragraph', text: '1. First step' },
      { type: 'paragraph', text: 'O(1)' },
    ]);
    expect(parseAnswer('**Note** this matters')).toEqual([{ type: 'paragraph', text: '**Note** this matters' }]);
    expect(parseAnswer('- KEY POINT')).toEqual([{ type: 'bullet', text: 'KEY POINT' }]);
  });

  it('keeps code indentation, including while a fence is still streaming', () => {
    expect(parseAnswer('IMPLEMENTATION\n```python\ndef f(x):\n    return x\n```\nDone.')).toEqual([
      { type: 'heading', text: 'IMPLEMENTATION' },
      { type: 'code', text: 'def f(x):\n    return x' },
      { type: 'paragraph', text: 'Done.' },
    ]);
    expect(parseAnswer('```js\nif (a) {\n  b()')).toEqual([{ type: 'code', text: 'if (a) {\n  b()' }]);
    expect(parseAnswer('Line one.\r\nLine two.')).toEqual([{ type: 'paragraph', text: 'Line one.' }, { type: 'paragraph', text: 'Line two.' }]);
  });

  it('splits inline bold and code', () => {
    expect(inlineSegments('Use **two pointers** and `left < right`.')).toEqual([
      { text: 'Use ' }, { text: 'two pointers', bold: true }, { text: ' and ' }, { text: 'left < right', code: true }, { text: '.' },
    ]);
    expect(inlineSegments('a ** b')).toEqual([{ text: 'a ** b' }]);
    expect(inlineSegments('**unfinished')).toEqual([{ text: '**unfinished' }]);
  });
});
