import { describe, expect, it } from 'vitest';
import { awaitingCheck, guessSpeaker, parseSpeakerLabels, speakerPrompt, voiceRoles, type SpokenLine } from './speakers';

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
