import { describe, expect, it } from 'vitest';
import { acknowledges, livePrompt, liveStep, liveSteps, type LiveHeard } from './live';

const heard = (text: string, speaker?: LiveHeard['speaker'], extra: Partial<LiveHeard> = {}): LiveHeard => ({ text, speaker, read: false, clarifying: false, question: false, ...extra });

describe('liveStep', () => {
  it('answers each interviewer turn, growing with it until you reply', () => {
    const first = liveStep(null, heard('So this role is the Capital One TIP program.', 'interviewer'));
    expect(first).toEqual({ action: 'new', turn: { asked: 'So this role is the Capital One TIP program.', said: [] } });
    expect(liveStep(first.turn, heard('Do you know what it is?', 'interviewer', { question: true })))
      .toEqual({ action: 'update', turn: { asked: 'So this role is the Capital One TIP program. Do you know what it is?', said: [] } });
    // Once you have said something, the interviewer's next words are a new turn.
    expect(liveStep({ asked: 'Do you know what it is?', said: ['I know it is the internship program'] }, heard('And why that one?', 'interviewer', { question: true })))
      .toEqual({ action: 'new', turn: { asked: 'And why that one?', said: [] } });
  });

  it('picks up from your own words, and holds still while you read an answer, check something, or ask them', () => {
    const turn = { asked: 'What do you know about Capital One?', said: [] };
    expect(liveStep(turn, heard('honestly mostly that you are big on cloud', 'candidate'))).toEqual({ action: 'update', turn: { asked: turn.asked, said: ['honestly mostly that you are big on cloud'] } });
    // Reading aloud changes nothing on screen, but it counts as replying.
    const reading = liveStep(turn, heard('I know you are one of the largest banks', 'candidate', { read: true }));
    expect(reading).toEqual({ action: 'hold', turn: { asked: turn.asked, said: ['I know you are one of the largest banks'] } });
    expect(liveStep(reading.turn, heard('Nice. What else?', 'interviewer', { question: true }))).toEqual({ action: 'new', turn: { asked: 'Nice. What else?', said: [] } });
    expect(liveStep(turn, heard('does that make sense?', 'candidate', { question: true }))).toEqual({ action: 'hold', turn: { asked: turn.asked, said: ['does that make sense?'] } });
    // A clarifying question waits for their reply, which joins the turn.
    const checking = liveStep(turn, heard('can I assume you mean the tech side', 'candidate', { clarifying: true }));
    expect(checking).toEqual({ action: 'hold', turn });
    expect(liveStep(checking.turn, heard('yes, the tech side, like our cloud work', 'interviewer'))).toEqual({ action: 'update', turn: { asked: `${turn.asked} yes, the tech side, like our cloud work`, said: [] } });
    expect(liveStep(turn, heard('   ', 'candidate'))).toEqual({ action: 'hold', turn });
  });

  it('lets listening noises and fillers pass, from either side', () => {
    const turn = { asked: 'Tell me about yourself.', said: ['sure so I am a junior studying computer science'] };
    for (const text of ['Mm-hmm.', 'Right, okay.', 'Oh nice!', 'Okay, so', 'yeah', 'Got it, thanks.']) expect(liveStep(turn, heard(text, 'interviewer'))).toEqual({ action: 'hold', turn });
    expect(liveStep({ asked: turn.asked, said: [] }, heard('Yeah.', 'candidate'))).toEqual({ action: 'hold', turn: { asked: turn.asked, said: [] } });
    expect(acknowledges('Nice, and what was the hardest part?')).toBe(false);
    expect(acknowledges('Yeah so basically I led the backend')).toBe(false);
  });

  it('takes someone unlabeled for you going on while you have the floor, and for the interviewer otherwise', () => {
    const answering = { asked: 'What do you know about Capital One?', said: ['I know you are one of the largest banks'] };
    expect(liveStep(answering, heard("it's also a big cloud shop from what I've read"))).toEqual({ action: 'update', turn: { asked: answering.asked, said: [...answering.said, "it's also a big cloud shop from what I've read"] } });
    expect(liveStep({ asked: answering.asked, said: [] }, heard('mainly on the tech side'))).toEqual({ action: 'update', turn: { asked: `${answering.asked} mainly on the tech side`, said: [] } });
  });

  it('responds to everything, even before any question', () => {
    expect(liveStep(null, heard('hi thanks for having me', 'candidate'))).toEqual({ action: 'new', turn: { asked: 'hi thanks for having me', said: [] } });
    expect(liveStep(null, heard('Hey, how are you doing today?'))).toEqual({ action: 'new', turn: { asked: 'Hey, how are you doing today?', said: [] } });
    expect(liveStep({ asked: 'Tell me about yourself.', said: ['I am a junior'] }, heard('Nice, I like that.', 'interviewer'))).toEqual({ action: 'new', turn: { asked: 'Nice, I like that.', said: [] } });
  });
});

describe('liveSteps', () => {
  it('folds your words, their interruption, and your reply into one step', () => {
    const turn = { asked: 'Walk me through your background.', said: [] };
    expect(liveSteps(turn, [heard('and before that I was at Globex doing', 'candidate'), heard('oh so how was that', 'interviewer', { question: true }), heard('yeah it was great honestly', 'candidate')]))
      .toEqual({ action: 'new', turn: { asked: 'oh so how was that', said: ['yeah it was great honestly'] } });
    // Reading before they cut in still makes theirs a new turn.
    expect(liveSteps(turn, [heard('I started out on the data team', 'candidate', { read: true }), heard('wait, which team?', 'interviewer', { question: true })]))
      .toEqual({ action: 'new', turn: { asked: 'wait, which team?', said: [] } });
    expect(liveSteps(turn, [heard('I started out on the data team', 'candidate', { read: true })])).toEqual({ action: 'hold', turn: { asked: turn.asked, said: ['I started out on the data team'] } });
    expect(liveSteps(null, [heard('Mm-hmm.', 'interviewer')])).toEqual({ action: 'hold', turn: null });
  });
});

describe('livePrompt', () => {
  it('asks for the answer, or for a continuation of what you said', () => {
    expect(livePrompt({ asked: 'Why this role?', said: [] })).toBe('Why this role?');
    expect(livePrompt({ asked: 'Why this role?', said: ['mostly the scale', 'and the people'] })).toBe('Why this role?\n\nThe candidate has started answering: "mostly the scale and the people". Continue their answer from there in the same voice, without repeating what they already said.');
  });
});
