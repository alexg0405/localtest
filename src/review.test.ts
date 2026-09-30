import { describe, expect, it } from 'vitest';
import { coachPrompt, countFillers, parseCoaching, reviewSession, speakingSeconds, type ReviewLine } from './review';

const at = (minute: number) => Date.UTC(2026, 8, 30, 10, minute); let id = 0;
const interviewer = (text: string, minute = 0): ReviewLine => ({ id: ++id, text, at: at(minute), speaker: 'interviewer', by: 'ai' });
const you = (text: string, minute = 0, by: ReviewLine['by'] = 'ai'): ReviewLine => ({ id: ++id, text, at: at(minute), speaker: 'candidate', by });

describe('reviewSession', () => {
  const session = reviewSession([
    interviewer("Hi, thanks for joining today. I'm Sam from the platform team.", 0),
    you('Thanks for having me.', 0),
    interviewer('Tell me about a time you disagreed with a teammate.', 1),
    you('On my last internship a teammate and I disagreed about adding tests before shipping.', 1, 'answer'),
    you('I pushed for tests because the service broke twice that month, and um, like, we ended up adding them for the risky paths.', 2),
    interviewer('Mm-hmm.', 2),
    interviewer('And what did you learn?', 3),
    you('That it helps to bring numbers, so I mean, I mean, it stopped being about opinions.', 3),
    interviewer('Okay, a coding problem. Given a linked list, swap every two adjacent nodes and return its head.', 4),
    you('Can I assume the list might be empty?', 4),
    interviewer('Yes.', 4),
    you('So I keep a dummy node, and for example with one two three four I end with two one four three.', 5),
    you("It's one pass, so O of n time and constant space.", 6),
  ]);

  it('finds each question and what you said to it, but not the small talk before them', () => {
    expect(session.questions.map(item => [item.n, item.kind, item.question])).toEqual([
      [1, 'BEHAVIORAL', 'Tell me about a time you disagreed with a teammate.'],
      [2, 'BEHAVIORAL', 'And what did you learn?'], // A follow-up to the story.
      [3, 'CODING', 'Okay, a coding problem. Given a linked list, swap every two adjacent nodes and return its head.'],
    ]);
    const [story, lesson, coding] = session.questions;
    expect(story.said).toHaveLength(2);
    expect([story.readWords, story.ownWords]).toEqual([14, 23]); // The first line was read from a suggested answer.
    expect(lesson.ownWords).toBe(16);
    expect(coding.said).toEqual(['Can I assume the list might be empty?', 'So I keep a dummy node, and for example with one two three four I end with two one four three.', "It's one pass, so O of n time and constant space."]);
  });

  it('checks what each kind of question calls for', () => {
    const [story, lesson, coding] = session.questions;
    expect(story.checks).toEqual([{ label: 'Set up a specific situation', done: true }, { label: 'Said what you did', done: true }, { label: 'Shared the result or what you learned', done: true }]);
    expect(lesson.checks.map(check => check.done)).toEqual([false, false, true]);
    expect(coding.checks).toEqual([{ label: 'Asked a clarifying question', done: true }, { label: 'Walked through an example', done: true }, { label: 'Covered an edge case', done: true }, { label: 'Stated the time and space complexity', done: true }]);
  });

  it('counts filler words in your own words, and totals the session', () => {
    expect(session.questions[0].fillers).toEqual([{ word: 'um / uh', count: 1 }, { word: 'like', count: 1 }]);
    expect(session.questions[1].fillers).toEqual([{ word: 'I mean', count: 2 }]);
    expect(session.fillerCount).toBe(4);
    expect(session.minutes).toBe(6);
    expect(session.readWords).toBe(14);
    expect(session.yourWords).toBe(4 + 14 + 23 + 16 + 8 + 21 + 11); // Including "Thanks for having me."
    expect(speakingSeconds(150)).toBe(60);
  });

  it('finds a question that the small talk led up to, placing unlabeled lines by voice', () => {
    const print = (pitch: number) => ({ pitch, tilt: 0.03, level: 20, seconds: 1.5 });
    const review = reviewSession([
      { ...interviewer("Hi, thanks for joining today. I'm Sam from the platform team."), print: print(10) },
      { id: ++id, text: 'Thanks for having me.', at: at(0), print: print(22) }, // Unlabeled, in your voice.
      { ...interviewer('Tell me about a time you disagreed with a teammate.'), print: print(10) },
      { id: ++id, text: 'On my last internship I pushed for tests before shipping.', at: at(1), print: print(22) },
    ]);
    expect(review.questions.map(item => item.question)).toEqual(['Tell me about a time you disagreed with a teammate.']);
    expect(review.questions[0].ownWords).toBe(10);
    // Without voices, the question the introduction led up to still gets its own review.
    expect(reviewSession([interviewer("Hi, I'm Sam from the platform team."), interviewer('So tell me about a time you failed.'), you('I missed a deadline once.')]).questions.map(item => [item.question, item.ownWords])).toEqual([['So tell me about a time you failed.', 5]]);
  });

  it('has nothing to review before a question is asked', () => {
    expect(reviewSession([]).questions).toEqual([]);
    expect(reviewSession([interviewer('Hi, how is your day going so far?'), you('Pretty good, thanks!')]).questions).toHaveLength(1);
    expect(reviewSession([interviewer('Hi there, welcome in.'), you('Thanks, happy to be here.')]).questions).toEqual([]);
  });
});

describe('countFillers', () => {
  it('counts fillers and repeats, but not the words used for their meaning', () => {
    expect(countFillers("um so, like, you know, it's it's kind of basically done, so yeah")).toEqual([
      { word: 'um / uh', count: 1 }, { word: 'like', count: 1 }, { word: 'you know', count: 1 }, { word: 'kind of / sort of', count: 1 }, { word: 'basically', count: 1 }, { word: 'so yeah', count: 1 }, { word: 'repeated words', count: 1 },
    ]);
    expect(countFillers('I like Python, and you know what the tests found? A leak.')).toEqual([]);
  });
});

describe('coachPrompt and parseCoaching', () => {
  it('sends each question with what you said, and reads the coach back', () => {
    const review = reviewSession([interviewer('Why do you want this role?'), you('Mostly the people, um, and the scale.'), you('I also read about your platform team.', 0, 'answer')]);
    expect(coachPrompt(review, 'Software Engineer Intern at Acme')).toBe('The candidate is interviewing for: Software Engineer Intern at Acme\n\nQuestion 1 (technical): Why do you want this role?\nWhat the candidate said (14 words, 50% read aloud from a suggested answer): "Mostly the people, um, and the scale. I also read about your platform team."\nFiller words: um / uh ×1');
    const coaching = parseCoaching('Here you go: {"questions": [{"n": 1, "good": "Clear reason.", "improve": "Say what *you* did, and **why**."}, {"n": "x"}], "overall": ["Slow down", "", "Use numbers", "Extra", "More"]}');
    expect(coaching).toEqual({ questions: new Map([[1, { good: 'Clear reason.', improve: 'Say what you did, and why.' }]]), overall: ['Slow down', 'Use numbers', 'Extra'] });
    expect(parseCoaching('not json')).toBeNull();
    expect(parseCoaching('{"questions": []}')).toBeNull();
  });
});
