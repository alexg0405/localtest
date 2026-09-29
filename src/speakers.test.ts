import { describe, expect, it } from 'vitest';
import { awaitingCheck, guessSpeaker, isClarifyingQuestion, parseSpeakerLabels, speakerPrompt, voiceGuess, voiceRoles, voiceSamples, type SpokenLine, type VoiceSample } from './speakers';

describe('guessSpeaker', () => {
  it('gives questions and prompts to the interviewer', () => {
    expect(guessSpeaker('so tell me about a time you disagreed with your manager')).toBe('interviewer');
    expect(guessSpeaker("I'd like you to walk me through your last project")).toBe('interviewer');
    expect(guessSpeaker('great thanks for sharing that')).toBe('interviewer');
    expect(guessSpeaker('okay moving on')).toBe('interviewer');
  });

  it('gives first-person accounts and clarifying questions to the candidate', () => {
    expect(guessSpeaker('so at my last internship I built the billing service in Go')).toBe('candidate');
    expect(guessSpeaker("I think I'd use a hash map here, what do you think")).toBe('candidate');
    expect(guessSpeaker('can I assume the array is sorted')).toBe('candidate');
    expect(guessSpeaker('um do you want me to write the code now')).toBe('candidate');
    expect(guessSpeaker("that's a great question")).toBe('candidate');
  });

  it('recognizes clarifying questions from the candidate, which need no suggested answer', () => {
    expect(isClarifyingQuestion('can I assume the input fits in memory')).toBe(true);
    expect(isClarifyingQuestion('so should I start with the brute force approach')).toBe(true);
    expect(isClarifyingQuestion('do you want me to code it up')).toBe(true);
    expect(isClarifyingQuestion('can I ask you about your last project')).toBe(false);
    expect(isClarifyingQuestion('does that make sense')).toBe(false); // Interviewers say it too.
    expect(guessSpeaker('can I ask you about your last project')).toBe('interviewer');
  });

  it('leaves short reactions and introductions for the model to decide', () => {
    expect(guessSpeaker('yeah that makes sense')).toBeUndefined();
    expect(guessSpeaker("Hi, I'm Priya and I lead the payments team")).toBeUndefined();
    expect(guessSpeaker('')).toBeUndefined();
  });
});

describe('speakerPrompt and parseSpeakerLabels', () => {
  const lines: SpokenLine[] = [
    { id: 1, text: 'tell me about yourself', speaker: 'interviewer', by: 'ai', voice: 0 },
    { id: 2, text: 'sure so I study computer science', speaker: 'candidate', by: 'guess', voice: 1 },
    { id: 3, text: 'okay great', by: 'guess', voice: 0 },
  ];

  it('numbers the lines to label after the labeled context, with voices', () => {
    expect(speakerPrompt(lines.slice(0, 1), lines.slice(1), 'Software Engineer Intern at Stripe')).toBe(
      'The candidate is interviewing for: Software Engineer Intern at Stripe\n\nEarlier lines, already labeled:\nInterviewer (voice 1): tell me about yourself\n\nLines to label:\n1 (voice 2). sure so I study computer science\n2 (voice 1). okay great');
    expect(speakerPrompt([], [{ id: 4, text: 'why Kafka' }])).toBe('Lines to label:\n1. why Kafka');
  });

  it('reads JSON replies, even wrapped in prose or code fences, and ignores anything else', () => {
    expect(parseSpeakerLabels('{"1":"C","2":"I"}', 2)).toEqual(['candidate', 'interviewer']);
    expect(parseSpeakerLabels('Here you go:\n```json\n{"1": "c", "3": "I"}\n```', 3)).toEqual(['candidate', undefined, 'interviewer']);
    expect(parseSpeakerLabels('{"1":"X"}', 1)).toEqual([undefined]);
    expect(parseSpeakerLabels('I think line 1 is the interviewer', 1)).toEqual([undefined]);
    expect(parseSpeakerLabels('{"1": "I",', 1)).toEqual([undefined]);
  });
});

describe('voiceRoles and awaitingCheck', () => {
  it('learns each voice from checked labels, counting your corrections most', () => {
    const lines: SpokenLine[] = [
      { id: 1, text: 'a', speaker: 'interviewer', by: 'ai', voice: 0 },
      { id: 2, text: 'b', speaker: 'interviewer', by: 'ai', voice: 1 },
      { id: 3, text: 'c', speaker: 'candidate', by: 'you', voice: 1 },
      { id: 4, text: 'd', speaker: 'candidate', by: 'guess', voice: 0 }, // Guesses do not count.
    ];
    expect([...voiceRoles(lines)]).toEqual([[0, 'interviewer'], [1, 'candidate']]);
    expect(awaitingCheck(lines).map(line => line.id)).toEqual([4]);
  });
});

describe('voiceGuess', () => {
  // A deeper interviewer heard through speakers, and a higher-pitched candidate close to the microphone.
  const interviewer = (pitch: number, level = 18) => ({ pitch, tilt: 0.05, level, seconds: 2 });
  const candidate = (pitch: number, level = 28) => ({ pitch, tilt: 0.02, level, seconds: 2 });
  const samples: VoiceSample[] = [
    ...[9, 10.5, 11, 9.5].map(pitch => ({ speaker: 'interviewer' as const, print: interviewer(pitch) })),
    ...[21, 22.5, 23, 21.5].map(pitch => ({ speaker: 'candidate' as const, print: candidate(pitch) })),
  ];

  it('says who a clear utterance sounds like once both voices are known', () => {
    expect(voiceGuess(samples, interviewer(10.2))).toMatchObject({ speaker: 'interviewer' });
    expect(voiceGuess(samples, candidate(22))).toMatchObject({ speaker: 'candidate' });
    expect(voiceGuess(samples, candidate(22))!.strength).toBeGreaterThan(3);
  });

  it('stays out of it for in-between voices, short utterances, and too few samples', () => {
    expect(voiceGuess(samples, { pitch: 16, tilt: 0.032, level: 23, seconds: 2 })).toBeUndefined();
    expect(voiceGuess(samples, { ...candidate(22), seconds: 0.4 })).toBeUndefined();
    expect(voiceGuess(samples.slice(0, 2), candidate(22))).toBeUndefined();
    expect(voiceGuess(samples, undefined)).toBeUndefined();
  });

  it('with only your voice sample, labels close matches as you and clear mismatches as the interviewer', () => {
    const mine = voiceSamples([], [candidate(21.5), candidate(22), candidate(22.5)]);
    expect(voiceGuess(mine, candidate(22.2))).toEqual({ speaker: 'candidate', strength: 2 });
    expect(voiceGuess(mine, interviewer(10))).toEqual({ speaker: 'interviewer', strength: 2 });
    expect(voiceGuess(mine, { pitch: 19.5, tilt: 0.02, level: 27, seconds: 2 })).toBeUndefined();
  });

  it('learns only from checked or corrected lines', () => {
    const lines: SpokenLine[] = [
      { id: 1, text: 'a', speaker: 'interviewer', by: 'ai', print: interviewer(10) },
      { id: 2, text: 'b', speaker: 'candidate', by: 'guess', print: candidate(22) },
      { id: 3, text: 'c', speaker: 'candidate', by: 'you', print: candidate(22) },
      { id: 4, text: 'd', speaker: 'interviewer', by: 'ai' },
    ];
    expect(voiceSamples(lines).map(sample => sample.speaker)).toEqual(['interviewer', 'candidate']);
  });

  it('adds the voice hint to lines waiting for the check', () => {
    expect(speakerPrompt([], [{ id: 1, text: 'can I assume it is sorted', heard: 'candidate' }])).toBe('Lines to label:\n1 (sounds like the candidate). can I assume it is sorted');
  });
});
