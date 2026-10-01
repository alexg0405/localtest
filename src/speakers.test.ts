import { describe, expect, it } from 'vitest';
import { LineVoice, awaitingCheck, cutsIn, guessSpeaker, isClarifyingQuestion, joinPrints, lastAsk, nearestVoice, parseSpeakerLabels, readsAnswer, speakerPrompt, splitInterruption, voiceGuess, voiceMatch, voiceRoles, voiceSamples, voicesDistinct, type ReadableAnswer, type SpokenLine, type VoiceSample } from './speakers';
import type { VoicePrint } from './voice';

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
    expect(isClarifyingQuestion('could I get you to walk me through it')).toBe(false);
    expect(isClarifyingQuestion('does that make sense')).toBe(false); // Interviewers say it too.
    expect(guessSpeaker('can I ask you about your last project')).toBe('interviewer');
  });

  it('leaves short reactions and introductions for the model to decide', () => {
    expect(guessSpeaker('yeah that makes sense')).toBeUndefined();
    expect(guessSpeaker("Hi, I'm Priya and I lead the payments team")).toBeUndefined();
    expect(guessSpeaker('')).toBeUndefined();
  });

  it('gives check-ins after an answer to the candidate, and looks past "oh" and "wait"', () => {
    expect(guessSpeaker('does that answer your question')).toBe('candidate');
    expect(guessSpeaker('is that what you were looking for')).toBe('candidate');
    expect(guessSpeaker('wait, can I assume the input is sorted')).toBe('candidate');
    expect(guessSpeaker('oh wait, how long were you there')).toBe('interviewer');
    expect(guessSpeaker('sorry, what was the last part')).toBe('interviewer');
  });
});

describe('lastAsk', () => {
  it("finds the interviewer's latest question in a line, with what led up to it and without what came after", () => {
    expect(lastAsk('Those arrays are sorted in either order. What is the complexity to find the largest? O of one, compare the ends.')).toBe('Those arrays are sorted in either order. What is the complexity to find the largest?');
    expect(lastAsk("Hey, I'm Sam from Acme. Why don't you tell me about yourself?")).toBe("Hey, I'm Sam from Acme. Why don't you tell me about yourself?");
    expect(lastAsk('What is a hash map? And when would you use one?')).toBe('What is a hash map? And when would you use one?');
    expect(lastAsk('walk me through your latest project')).toBe('walk me through your latest project'); // Browser recognition adds no punctuation.
    expect(lastAsk('Nice. Got it. And how did the team take it?')).toBe('Nice. Got it. And how did the team take it?');
    // Several questions run together: the latest, with only what led up to it.
    expect(lastAsk('What is the complexity to find the max? O of one. Now take two files. What is the overall complexity? O of m plus n.')).toBe('O of one. Now take two files. What is the overall complexity?');
  });

  it("skips the candidate's own questions, and lines that ask nothing", () => {
    for (const text of ['Do I go first?', "I think it's O of n, right?", 'How do I handle the empty case? Let me think.', 'Can I assume the input is sorted?', "It's a linked list. Does that make sense?", 'Sorry?', 'What?', 'I worked at Acme for two years.', 'Right?', '']) expect(lastAsk(text)).toBeUndefined();
    // Their question still counts after your own.
    expect(lastAsk('Does that make sense? Yes. So what would you change?')).toBe('Does that make sense? Yes. So what would you change?');
    for (const text of ["So for each pair I swap them. You see what I'm saying, though?", "I'm not sure yet, would you like me to start with brute force?", 'I just use two pointers, if that makes sense?']) expect(lastAsk(text)).toBeUndefined();
  });

  it('skips your questions about the problem you are both working on, and your own words said like a question', () => {
    const setup = "Let's go ahead and do a problem right here. So, the main thing that we're gonna be looking at today is, at this case, study. So why don't you go ahead and just take a second to read the problem, and then we can get started.";
    // With Deepgram, words still coming in start the live answer once they end in a question mark, which they can do
    // before the line is final ("…networks." in the end).
    const reading = "Okay. So first thing I see is that there's a case study question talking about how Capital One can integrate virtual private networks?";
    for (const text of [
      "So are we talking about connecting Capital One's internal systems, or is this more about like, customers, getting that, like, remote",
      "like, the the, like, customers accessing services remotely. And once the scale, we're looking at, like, like, are we gonna have to count for concurrency or data centers, stuff like that?",
      reading, 'I think for a VPN integration case study. I wanna try to get some clarification, I guess?',
      'Can we assume the input fits in memory?', 'How do we handle the empty case?', "I think it's O of n?", 'So are we, you know, talking about internal systems or customers?',
    ]) expect(lastAsk(text)).toBeUndefined();
    // Their setup stays the latest ask while you read on after it.
    expect(lastAsk(`${setup} ${reading}`)).toBe(setup);
    // Their questions still count when they ask you something, with "we" or "I" in them or not.
    expect(lastAsk('VPN. What would you think is the main problem with the virtual private network?')).toBe('VPN. What would you think is the main problem with the virtual private network?');
    expect(lastAsk('I see you worked at Acme. What did you do there?')).toBe('I see you worked at Acme. What did you do there?');
    expect(lastAsk("I'm curious what the hardest part was?")).toBe("I'm curious what the hardest part was?");
    expect(lastAsk('Do you know if we need to handle concurrency?')).toBe('Do you know if we need to handle concurrency?');
  });

  it('takes a problem to solve with the constraints that follow it', () => {
    expect(lastAsk('Sure. So, given a linked list, swap every two adjacent nodes and return its head. You must not modify the values. Okay.'))
      .toBe('Sure. So, given a linked list, swap every two adjacent nodes and return its head. You must not modify the values. Okay.');
    // Up to where you start answering.
    expect(lastAsk("Given an array of integers, return the largest sum of a subarray. Okay so I'd use Kadane's algorithm.")).toBe('Given an array of integers, return the largest sum of a subarray.');
    expect(lastAsk("Given a sorted array I'd just use binary search.")).toBeUndefined();
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

  it('counts lines read from a suggested answer twice, and never sends them to the check', () => {
    const lines: SpokenLine[] = [
      { id: 1, text: 'a', speaker: 'interviewer', by: 'ai', voice: 0 },
      { id: 2, text: 'b', speaker: 'candidate', by: 'answer', voice: 0 },
    ];
    expect([...voiceRoles(lines)]).toEqual([[0, 'candidate']]);
    expect(awaitingCheck(lines)).toEqual([]);
  });
});

describe('reading a suggested answer aloud', () => {
  const about: ReadableAnswer = { question: 'Can you tell me a little bit more about yourself?', answer: "Yeah, so I'm Sam, a junior at Westbrook studying computer science and finance. I'm from Oregon originally, but I've been in Portland for school and it's been great.\n\nI've done a couple internships now — most recently at Acme working on platform engineering, where I got to lead some upgrades. Before that I was at Globex working on automation and telemetry stuff." };
  const counts: ReadableAnswer = { question: 'How would you count how often each word appears?', answer: "MY THINKING\nMy first thought is brute force. Then I'd use a hash map to store counts so each lookup is O(1)." };
  const answers = [about, counts];

  it('recognizes you reading an answer, even loosely and with misheard words', () => {
    expect(readsAnswer("Yeah. So I'm Sam. I'm a junior at Westbrook. I'm studying computer science and finance.", answers)).toBe(true);
    expect(readsAnswer("I'm from Oregon originally, and I've been in school for a year now, and it's been great. I've done a couple internships now. Most recently at acne working on platform engineering.", answers)).toBe(true);
    expect(readsAnswer('then I would use a hash map to store counts so each lookup is O of one', answers)).toBe(true);
  });

  it("does not take the interviewer's questions, or their echo of the answer's words, for a reading", () => {
    expect(readsAnswer('Can you tell me a little bit more about yourself?', answers)).toBe(false);
    expect(readsAnswer('Oh nice, so how was Acme?', answers)).toBe(false);
    expect(readsAnswer('so you did platform engineering at Acme', answers)).toBe(false);
    expect(readsAnswer('why would you use a hash map to store counts', answers)).toBe(false);
    expect(readsAnswer('how would you count how often each word appears', [counts])).toBe(false); // Words from the question itself.
    expect(readsAnswer('yeah', answers)).toBe(false);
    expect(readsAnswer("I'm a junior at Westbrook", [])).toBe(false);
  });

  it('splits off the interviewer cutting in while you read, and your reply right after', () => {
    expect(splitInterruption('and before that I was at Globex working on automation oh so how was that', answers))
      .toEqual({ yours: 'and before that I was at Globex working on automation', theirs: 'oh so how was that', read: true });
    expect(splitInterruption('Before that I was at Globex working on automation and telemetry stuff. Oh, so how was that?', answers))
      .toMatchObject({ yours: 'Before that I was at Globex working on automation and telemetry stuff.', theirs: 'Oh, so how was that?', read: true });
    expect(splitInterruption('most recently at Acme working on platform engineering, oh wait, how long were you there', answers)).toMatchObject({ theirs: 'oh wait, how long were you there', read: true });
    expect(splitInterruption('before that I was at Globex working on automation oh so how was that yeah it was really great I learned a lot', answers))
      .toEqual({ yours: 'before that I was at Globex working on automation', theirs: 'oh so how was that', reply: 'yeah it was really great I learned a lot', read: true });
    expect(splitInterruption("I was at Globex working on automation okay great let's move on to the next question", answers)).toMatchObject({ theirs: "okay great let's move on to the next question" });
    expect(splitInterruption('most recently at Acme working on platform engineering oh so you worked on platform engineering?', answers)).toMatchObject({ theirs: 'oh so you worked on platform engineering?' });
  });

  it('never takes a question read from an answer for theirs, even run together with what they said', () => {
    const plan: ReadableAnswer = { question: "Why don't you read it right here?", answer: "Okay, I see what we're working with. Before I dive in, do you want me to think through this out loud as I go? Also, is there a specific part you want me to focus on, like the architecture or the data flow?" };
    // With Deepgram, words still coming in run both people's words together until a pause splits them by speaker, and
    // theirs leave too little of it read to count as a reading.
    const run = 'Alright, sounds good. Also, is there a specific part you want me to focus on?';
    expect(readsAnswer(run, [plan])).toBe(false);
    expect(lastAsk(run, 'en-US', [plan])).toBeUndefined();
    expect(lastAsk(run)).toBe(run); // Without the answers to compare with, it reads as their question.
    // What you say before a line you read is not words of your own that make it their echo of the answer.
    expect(readsAnswer('Okay so, is there a specific part you want me to focus on, like the architecture?', [plan])).toBe(true);
    // Their own questions still count: before your reading, or asking about what the answer said.
    expect(lastAsk('What would you focus on first? Also, is there a specific part you want me to focus on?', 'en-US', [plan])).toBe('What would you focus on first?');
    expect(lastAsk('So why would you use a hash map to store counts?', 'en-US', answers)).toBe('So why would you use a hash map to store counts?');
  });

  it('keeps a reading whole when what follows is still yours', () => {
    expect(splitInterruption('most recently at Acme working on platform engineering. Does that answer your question?', answers)).toBeUndefined();
    expect(readsAnswer('most recently at Acme working on platform engineering. Does that answer your question?', answers)).toBe(true);
    expect(splitInterruption("I'd use a hash map to store counts and then how do we handle collisions", answers)).toBeUndefined();
    // Reading questions that are in the answer itself.
    const questions = [{ question: 'Tell me about a time you disagreed with a teammate.', answer: 'To make it specific: What was at stake? How did you communicate? What changed?' }];
    expect(splitInterruption('to make it specific what was at stake how did you communicate what changed', questions)).toBeUndefined();
    expect(readsAnswer('to make it specific what was at stake how did you communicate what changed', questions)).toBe(true);
  });

  it("counts an answer's restatement of the question as reading, but not the interviewer asking again", () => {
    const twoSum: ReadableAnswer = { question: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.', answer: "THE PROBLEM\nSo we're given an array of integers and a target, and we want to return the indices of the two numbers that add up to the target.\n\nMY THINKING\nMy first thought is brute force, checking every pair." };
    expect(readsAnswer("so we're given an array of integers and a target and we want to return the indices of the two numbers that add up to the target", [twoSum])).toBe(true);
    expect(readsAnswer('given an array of integers and a target return the indices of the two numbers that add up to the target', [twoSum])).toBe(false);
    // An answer that quotes the question, then the interviewer cutting in: the split comes after the quote.
    const quoted: ReadableAnswer = { question: 'How would you design a URL shortener for a big company?', answer: 'A strong answer starts with the main idea, then supports it with a concrete example. For "How would you design a URL shortener for a big company?", define the key terms clearly.' };
    expect(splitInterruption('then supports it with a concrete example for how would you design a URL shortener for oh so how was that', [quoted])).toMatchObject({ theirs: 'oh so how was that', read: true });
  });

  it('splits you talking freely only when you were clearly cut off', () => {
    expect(splitInterruption('I kept going back and forth on it for a while oh wait why did you pick Go', [])).toEqual({ yours: 'I kept going back and forth on it for a while', theirs: 'oh wait why did you pick Go', read: false });
    expect(splitInterruption('and before that I was at so how was that', [])).toMatchObject({ yours: 'and before that I was at', theirs: 'so how was that' });
    // The interviewer reacting, introducing something, or thinking aloud with you stays one line.
    expect(splitInterruption('Nice, I like that. So what was the hardest part?', [])).toBeUndefined();
    expect(splitInterruption("That's a really cool project, I love that kind of work. So what was the hardest part?", [])).toBeUndefined();
    expect(splitInterruption('Okay cool, we use a lot of Go here, so how comfortable are you with it?', [])).toBeUndefined();
    expect(splitInterruption('we shipped it to production last month and it went well so how was that', [])).toBeUndefined();
    expect(splitInterruption("I'd store the counts in a hash map and then how do we handle collisions", [])).toBeUndefined();
    expect(splitInterruption('I kept going back and forth on it for a while oh wait why did you pick Go', [], 'en-US', true)).toBeUndefined(); // Their voice is known.
  });

  it('cutsIn spots words that open by cutting in, which start a new line even mid-sentence', () => {
    expect(cutsIn('oh wait, how long were you there')).toBe(true);
    expect(cutsIn('Sorry, what was that?')).toBe(true);
    expect(cutsIn('the Japanese term.')).toBe(false);
    expect(cutsIn('Ohio is where I grew up')).toBe(false);
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

  it('learns only from checked, corrected, or read-aloud lines', () => {
    const lines: SpokenLine[] = [
      { id: 1, text: 'a', speaker: 'interviewer', by: 'ai', print: interviewer(10) },
      { id: 2, text: 'b', speaker: 'candidate', by: 'guess', print: candidate(22) },
      { id: 3, text: 'c', speaker: 'candidate', by: 'you', print: candidate(22) },
      { id: 4, text: 'd', speaker: 'interviewer', by: 'ai' },
      { id: 5, text: 'e', speaker: 'candidate', by: 'answer', print: candidate(21) },
    ];
    expect(voiceSamples(lines).map(sample => sample.speaker)).toEqual(['interviewer', 'candidate', 'candidate']);
  });

  it('adds the voice hint to lines waiting for the check', () => {
    expect(speakerPrompt([], [{ id: 1, text: 'can I assume it is sorted', heard: 'candidate' }])).toBe('Lines to label:\n1 (sounds like the candidate). can I assume it is sorted');
    expect(speakerPrompt([], [{ id: 1, text: 'so how was that', voice: 1, heard: 'interviewer' }])).toBe('Lines to label:\n1 (voice 2, sounds like the interviewer). so how was that');
  });
});

describe('comparing stretches of speech', () => {
  const print = (pitch: number | undefined, level = 20, tilt = 0.03, seconds = 1.5): VoicePrint => ({ ...(pitch === undefined ? {} : { pitch }), tilt, level, seconds });

  it('nearestVoice places a line by the latest lines each person was heard on', () => {
    const lines: SpokenLine[] = [{ id: 1, text: 'Why this team?', speaker: 'interviewer', print: print(10) }, { id: 2, text: 'I like the people', speaker: 'candidate', print: print(22) }, { id: 3, text: 'Typed question', speaker: 'interviewer', by: 'typed' }];
    expect(nearestVoice(lines, print(22.5))).toBe('candidate');
    expect(nearestVoice(lines, print(10.4))).toBe('interviewer');
    expect(nearestVoice(lines.slice(0, 1), print(22))).toBe('candidate'); // Clearly not the only one heard.
    expect(nearestVoice(lines.slice(1, 2), print(10))).toBe('interviewer');
    expect(nearestVoice(lines, print(16))).toBeUndefined(); // Neither the same as one nor clearly apart from both.
    expect(nearestVoice(lines, undefined)).toBeUndefined();
    expect(nearestVoice([], print(22))).toBeUndefined();
  });

  it('joinPrints weighs stretches by length, taking pitch only from those that had one', () => {
    const joined = joinPrints([print(20, 20, 0.02, 1), print(26, 30, 0.04, 3), print(undefined, 10, 0.1, 1), undefined])!;
    expect(joined.pitch).toBeCloseTo((20 + 26 * 3) / 4, 5);
    expect(joined.level).toBeCloseTo((20 + 90 + 10) / 5, 5);
    expect(joined.tilt).toBeCloseTo((0.02 + 0.12 + 0.1) / 5, 5);
    expect(joined.seconds).toBe(5);
    expect(joinPrints([])).toBeUndefined();
    expect(joinPrints([undefined])).toBeUndefined();
  });

  it('voiceMatch compares two stretches directly until both voices are learned', () => {
    expect(voiceMatch(print(20), print(20.8, 22))).toBe('same');
    expect(voiceMatch(print(10), print(22))).toBe('different'); // A man and a woman, about 12 semitones apart.
    expect(voiceMatch(print(20), print(25))).toBeUndefined(); // Emphasis or laughter can do that on its own.
    expect(voiceMatch(print(20, 28), print(24.5, 18))).toBe('different'); // Pitch, backed up by loudness (an interviewer through speakers).
    expect(voiceMatch(print(20, 28), print(20, 12))).toBeUndefined(); // Loudness alone: turning your head, auto-gain.
    expect(voiceMatch(print(20), print(28))).toBe('different');
    expect(voiceMatch(print(20), print(28), [], true)).toBeUndefined(); // Strict, for when Deepgram's voice numbers disagree.
    expect(voiceMatch(print(undefined), print(20))).toBeUndefined();
    expect(voiceMatch(print(20, 20, 0.03, 0.4), print(20))).toBeUndefined(); // Too short to tell.
  });

  it('with both voices learned, voiceMatch asks who each stretch sounds like, and voicesDistinct says whether that is telling', () => {
    const interviewer = (pitch: number) => print(pitch, 18, 0.05, 2), candidate = (pitch: number) => print(pitch, 28, 0.02, 2);
    const samples: VoiceSample[] = [
      ...[9, 10.5, 11, 9.5].map(pitch => ({ speaker: 'interviewer' as const, print: interviewer(pitch) })),
      ...[21, 22.5, 23, 21.5].map(pitch => ({ speaker: 'candidate' as const, print: candidate(pitch) })),
    ];
    expect(voiceMatch(interviewer(10), candidate(22), samples)).toBe('different');
    expect(voiceMatch(candidate(21), candidate(23.5), samples)).toBe('same'); // 2.5 semitones apart, but both clearly you.
    expect(voicesDistinct(samples)).toBe(true);
    expect(voicesDistinct(samples.filter(sample => sample.speaker === 'candidate'))).toBe(false);
    const alike: VoiceSample[] = [...[20, 21, 20.5].map(pitch => ({ speaker: 'interviewer' as const, print: print(pitch) })), ...[20.5, 21.5, 20].map(pitch => ({ speaker: 'candidate' as const, print: print(pitch) }))];
    expect(voicesDistinct(alike)).toBe(false);
  });

  it('LineVoice gives each line only its own stretches, even when the words arrive after the next person started', () => {
    const voices = new LineVoice(); const you = print(22, 28, 0.02, 1), them = print(10, 18, 0.05, 1);
    voices.add({ id: 1, phase: 'start' }); voices.add({ id: 1, phase: 'end', print: you });
    voices.add({ id: 2, phase: 'start' }); voices.add({ id: 2, phase: 'early', print: them });
    voices.attach(); // Your words arrive late: the stretch that ended is yours, not the one still going.
    expect(voices.line()).toEqual(you);
    expect(voices.current()).toEqual({ id: 2, print: them });
    voices.release(); // It sounded like someone else, so it waits for the next line.
    expect(voices.take()).toEqual(you);
    voices.attach(); // Their words: now the stretch still going is the line's.
    voices.add({ id: 2, phase: 'end', print: them });
    expect(voices.line()).toEqual(them);
    expect(voices.seen).toBe(true);
  });

  it('LineVoice claims the stretch still going when nothing else was heard, and words() covers what is not in the line yet', () => {
    const voices = new LineVoice(); const a = print(22, 28, 0.02, 1), b = print(22.5, 27, 0.02, 1);
    voices.add({ id: 1, phase: 'start' }); voices.add({ id: 1, phase: 'early', print: a });
    voices.attach(); // Words while the stretch goes on.
    voices.add({ id: 1, phase: 'end', print: a });
    voices.add({ id: 2, phase: 'start' }); voices.add({ id: 2, phase: 'end', print: b });
    expect(voices.words()).toEqual(b);
    expect(voices.line()).toEqual(a);
    expect(voices.take(true)!.seconds).toBe(2); // Stopping takes everything heard.
    expect(voices.line()).toBeUndefined();
  });
});
