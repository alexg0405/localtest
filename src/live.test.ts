import { describe, expect, it } from 'vitest';
import { acknowledges, bounded, liveStep, liveSteps, pointsPrompt, type LiveHeard, type LiveStep, type LiveTurn } from './live';
import { lastAsk } from './speakers';
import { likelyQuestion } from './text';

// A line as the app hears it: the question in it is found the same way, whoever it was labeled.
const heard = (text: string, speaker?: LiveHeard['speaker'], extra: Partial<LiveHeard> = {}): LiveHeard => ({ text, speaker, read: false, clarifying: false, question: likelyQuestion(text), ask: lastAsk(text), ...extra });
const turn = (asked: string, said: string[] = [], question = true, ownWords = 0): LiveTurn => ({ asked, said, question, ownWords });
// Feeds lines one by one, as they are committed, and keeps what each step did.
function replay(lines: LiveHeard[], start: LiveTurn | null = null) {
  let current = start; const steps: LiveStep[] = [];
  for (const line of lines) { const step = liveStep(current, line); current = step.turn; steps.push(step); }
  return steps;
}

describe('liveStep', () => {
  it('answers each question on its own, growing only while they set it up or trail off', () => {
    const [intro, question, next] = replay([heard('So this role is the Capital One TIP program.', 'interviewer'), heard('Do you know what it is?', 'interviewer'), heard('What does the team work on day to day?', 'interviewer')]);
    expect(intro).toEqual({ action: 'new', turn: turn('So this role is the Capital One TIP program.', [], false) });
    expect(question).toEqual({ action: 'update', turn: turn('So this role is the Capital One TIP program. Do you know what it is?') });
    // Another question is a new turn even before you reply.
    expect(next).toEqual({ action: 'new', turn: turn('What does the team work on day to day?') });
    const [, rest] = replay([heard('Can you walk me through', 'interviewer'), heard('your latest project', 'interviewer')]);
    expect(rest).toEqual({ action: 'update', turn: turn('Can you walk me through your latest project') });
    const [, why] = replay([heard("What's your favorite language?", 'interviewer'), heard('And why?', 'interviewer')]);
    expect(why).toEqual({ action: 'update', turn: turn("What's your favorite language? And why?") });
  });

  it('finds the question in a line that runs on into the answer, whoever it was heard from', () => {
    const line = 'This array is sorted, but it may be ascending or descending. What is the complexity to find the largest value? So compare both ends, O of one.';
    for (const speaker of ['interviewer', 'candidate', undefined] as const) {
      expect(liveStep(turn('Tell me about yourself.', ['I am a junior']), heard(line, speaker))).toEqual({ action: 'new', turn: turn('This array is sorted, but it may be ascending or descending. What is the complexity to find the largest value?') });
    }
  });

  it('keeps a practice session where every line was heard as the interviewer from becoming one long question', () => {
    const steps = replay([
      heard("Hey, I'm your interviewer, Sam. I work here at Acme. Why don't you tell me a little bit about yourself?", 'interviewer'),
      heard('Yeah. Okay. Perfect. Perfect. That works. Thanks.', 'interviewer'),
      heard('This array of size nine is sorted, but it may be ascending or descending. What is the complexity to find the largest value? So access both ends and compare, O of one.', 'interviewer'),
      heard('Now take two files. Compute the sum of all integers in both files. What is the overall complexity? O of m plus n.', 'interviewer'),
      heard('What is the complexity to insert n keys in random order into a binary search tree? So the insertion', 'interviewer'),
      heard('I mean,', 'candidate'),
    ]);
    expect(steps.map(step => step.action)).toEqual(['new', 'hold', 'new', 'new', 'new', 'hold']);
    expect(steps.map(step => step.turn?.asked.split('?')[0].split('. ').pop())).toEqual(["Why don't you tell me a little bit about yourself", "Why don't you tell me a little bit about yourself", 'What is the complexity to find the largest value', 'What is the overall complexity', 'What is the complexity to insert n keys in random order into a binary search tree', 'What is the complexity to insert n keys in random order into a binary search tree']);
  });

  it('stays on the problem through a natural back and forth about it', () => {
    const problem = 'Sure. Alright. So, given a linked list, swap every two adjacent nodes and return its head. You must solve it without modifying the values in the nodes. Okay. So given';
    const steps = replay([
      heard(problem, 'interviewer'),
      heard("I'm actually just trying to solve this problem real quick.", 'candidate'),
      heard('I think this is.', 'interviewer'),
      heard('Yeah. Yeah.', 'candidate'),
      heard('You just', 'interviewer'),
      heard('I go through the list. Save', 'candidate'),
      heard('a right pointer on the left pointer.', 'interviewer'),
      heard("Yeah. Well, I'd swap the pointers. Right? So for each pair, I get one and two. You see what I'm saying, though?", 'candidate'),
      heard('like,', 'interviewer'),
      heard("next to twos next, like, point twos next to ones.", undefined),
      heard("But it's like this. Right? Yeah.", 'interviewer'),
    ]);
    expect(steps.map(step => step.action)).toEqual(['new', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold']);
    const last = steps[steps.length - 1].turn!;
    expect(last.asked).toBe(problem); // A problem keeps its constraints.
    expect(last.ownWords).toBe(10 + 6 + 22 + 10); // Your own words, which the key points follow.
  });

  it('holds still while you read an answer, explain in your own words, check something, or ask them', () => {
    const asked = turn('What do you know about Capital One?');
    expect(liveStep(asked, heard('honestly mostly that you are big on cloud', 'candidate'))).toEqual({ action: 'hold', turn: turn(asked.asked, ['honestly mostly that you are big on cloud'], true, 8) });
    // Reading aloud counts as replying, though not as your own words.
    const reading = liveStep(asked, heard('I know you are one of the largest banks', 'candidate', { read: true }));
    expect(reading).toEqual({ action: 'hold', turn: turn(asked.asked, ['I know you are one of the largest banks']) });
    expect(liveStep(reading.turn, heard('Nice. What else do you know?', 'interviewer'))).toEqual({ action: 'new', turn: turn('Nice. What else do you know?') });
    expect(liveStep(asked, heard('does that make sense?', 'candidate'))).toEqual({ action: 'hold', turn: turn(asked.asked, ['does that make sense?'], true, 4) });
    // A clarifying question waits for their reply.
    expect(liveStep(asked, heard('can I assume you mean the tech side', 'candidate', { clarifying: true }))).toEqual({ action: 'hold', turn: asked });
    expect(liveStep(asked, heard('   ', 'candidate'))).toEqual({ action: 'hold', turn: asked });
  });

  it('lets listening noises and fillers pass, from either side', () => {
    const answering = turn('Tell me about yourself.', ['sure so I am a junior studying computer science'], true, 9);
    for (const text of ['Mm-hmm.', 'Right, okay.', 'Oh nice!', 'Okay, so', 'yeah', 'Got it, thanks.', 'Perfect. That works. Thanks.', 'Take your time.', 'I mean,']) expect(liveStep(answering, heard(text, 'interviewer'))).toEqual({ action: 'hold', turn: answering });
    expect(acknowledges('Nice, and what was the hardest part?')).toBe(false);
    expect(acknowledges('Yeah so basically I led the backend')).toBe(false);
  });

  it('takes someone unlabeled for you once the question is asked, and for them while they set it up', () => {
    const asked = turn('What do you know about Capital One?');
    expect(liveStep(asked, heard("it's a big cloud shop from what I've read"))).toEqual({ action: 'hold', turn: turn(asked.asked, ["it's a big cloud shop from what I've read"], true, 9) });
    const setup = turn('So this role is on the payments team.', [], false);
    expect(liveStep(setup, heard('mostly the checkout side of things'))).toEqual({ action: 'update', turn: turn(`${setup.asked} mostly the checkout side of things`, [], false) });
  });

  it('leaves the answer alone for what they say about it once they have asked', () => {
    const asked = turn('How would you design a rate limiter?');
    expect(liveStep(asked, heard('Just a high level sketch is fine for now.', 'interviewer'))).toEqual({ action: 'hold', turn: asked });
    const replied = turn(asked.asked, ['I would start with a token bucket'], true, 7);
    expect(liveStep(replied, heard('Nice, I like that direction a lot.', 'interviewer'))).toEqual({ action: 'hold', turn: replied });
  });

  it('lets the goodbyes at the end pass without asking for more key points', () => {
    const asked = turn('Do you have any questions for me?', ['what does a typical day look like'], true, 7);
    for (const [text, speaker] of [['Honestly the people. Alright, thanks so much for your time today!', 'interviewer'], ['Thank you, this was great.', 'candidate'], ['Great question.', 'interviewer'], ['Nice talking with you, take care!', 'candidate']] as const) {
      expect(liveStep(asked, heard(text, speaker))).toEqual({ action: 'hold', turn: asked });
    }
    expect(liveStep(asked, heard('yeah it was great honestly, we shipped it on time', 'candidate')).turn!.ownWords).toBe(7 + 10);
    // A question after the thanks still counts.
    expect(liveStep(asked, heard('Thanks for your time. Do you have a minute for one more question about your resume?', 'interviewer')).action).toBe('new');
  });

  it('answers the start of the conversation, whatever it is', () => {
    expect(liveStep(null, heard('hi thanks for having me', 'candidate'))).toEqual({ action: 'new', turn: turn('hi thanks for having me', [], false) });
    expect(liveStep(null, heard('Hey, how are you doing today?'))).toEqual({ action: 'new', turn: turn('Hey, how are you doing today?') });
    expect(liveStep(null, heard('Hi, thanks for joining today.', 'interviewer'))).toEqual({ action: 'new', turn: turn('Hi, thanks for joining today.', [], false) });
    expect(liveStep(null, heard('does that make sense?', 'candidate'))).toEqual({ action: 'hold', turn: null });
  });

  it('keeps what it responds to short, favoring the latest of it', () => {
    const intro = Array.from({ length: 12 }, (_, index) => `Our team number ${index + 1} works on another part of the payments stack.`);
    const steps = replay(intro.map(text => heard(text, 'interviewer')));
    const asked = steps[steps.length - 1].turn!.asked;
    expect(asked.length).toBeLessThanOrEqual(400);
    expect(asked.endsWith('Our team number 12 works on another part of the payments stack.')).toBe(true);
    expect(asked.startsWith('Our team number')).toBe(true); // Whole sentences, from the latest back.
    expect(bounded('x'.repeat(500))).toBe(`…${'x'.repeat(400)}`);
  });
});

describe('liveSteps', () => {
  it('folds your words, their interruption, and your reply into one step', () => {
    const asked = turn('Walk me through your background.');
    expect(liveSteps(asked, [heard('and before that I was at Globex doing', 'candidate', { ask: undefined }), heard('oh so how was that', 'interviewer'), heard('yeah it was great honestly', 'candidate', { ask: undefined })]))
      .toEqual({ action: 'new', turn: turn('oh so how was that', ['yeah it was great honestly'], true, 5) });
    // Reading before they cut in still makes theirs a new turn.
    expect(liveSteps(asked, [heard('I started out on the data team', 'candidate', { read: true }), heard('wait, which team?', 'interviewer')]))
      .toEqual({ action: 'new', turn: turn('wait, which team?') });
    expect(liveSteps(asked, [heard('I started out on the data team', 'candidate', { read: true })])).toEqual({ action: 'hold', turn: turn(asked.asked, ['I started out on the data team']) });
    expect(liveSteps(null, [heard('Mm-hmm.', 'interviewer')])).toEqual({ action: 'hold', turn: null });
  });
});

describe('pointsPrompt', () => {
  it('gives the question and the latest of what you said', () => {
    expect(pointsPrompt(turn('Why this role?', ['mostly the scale', 'and the people']))).toBe('Question: Why this role?\n\nWhat the candidate has said so far, in their own words or reading from a suggested answer: "mostly the scale and the people"');
    const long = pointsPrompt(turn('Why this role?', Array.from({ length: 200 }, (_, index) => `point ${index}`)));
    expect(long).toMatch(/answer: "…\S/); expect(long).toContain('point 199"'); expect(long).not.toContain('point 1 ');
  });
});
