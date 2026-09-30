import { describe, expect, it } from 'vitest';
import { noTopics, parseTopics, topicsPrompt, type Topics } from './topics';

const lines = [
  { id: 1, text: 'Hi, thanks for joining. How are you?', speaker: 'interviewer' as const },
  { id: 2, text: 'Doing well, thanks!', speaker: 'candidate' as const },
  { id: 3, text: "Okay so we're gonna move on. Our client is a coffee chain whose profits fell 20%. How would you figure out why?", speaker: 'interviewer' as const },
  { id: 4, text: 'Can I ask whether revenue or costs changed?' },
];

describe('topicsPrompt', () => {
  it('sends the list so far and the transcript numbered by line', () => {
    expect(topicsPrompt(lines, noTopics)).toBe("Main questions so far:\nnone yet\n\nTranscript, oldest first:\n#1 Interviewer: Hi, thanks for joining. How are you?\n#2 Candidate: Doing well, thanks!\n#3 Interviewer: Okay so we're gonna move on. Our client is a coffee chain whose profits fell 20%. How would you figure out why?\n#4 Unlabeled: Can I ask whether revenue or costs changed?");
    const topics: Topics = { list: [{ id: 1, title: 'Coffee chain profit drop', question: 'Why did profits fall 20%?', from: 3 }], current: 1 };
    expect(topicsPrompt(lines, topics, 120)).toBe('Main questions so far:\n1. Coffee chain profit drop: Why did profits fall 20%? (from #3) [current]\n\nTranscript, oldest first (the latest part):\n#4 Unlabeled: Can I ask whether revenue or costs changed?');
  });
});

describe('parseTopics', () => {
  it('reads the list and the current one, keeping ids and anything the reply left out', () => {
    const first = parseTopics('Sure: {"topics": [{"id": 1, "title": "Coffee chain profit drop", "question": "Our client, a coffee chain, saw profits fall 20%. How would you find out why?", "from": 3}], "current": 1}', noTopics);
    expect(first).toEqual({ list: [{ id: 1, title: 'Coffee chain profit drop', question: 'Our client, a coffee chain, saw profits fall 20%. How would you find out why?', from: 3 }], current: 1 });
    // Reworded, a second one added, and one dropped by mistake is kept.
    const earlier: Topics = { list: [{ id: 1, title: 'Tell me about yourself', question: 'Tell me about yourself.' }, ...first.list.map(topic => ({ ...topic, id: 2 }))], current: 2 };
    expect(parseTopics('{"topics": [{"id": 2, "title": "Why coffee profits fell", "question": "Find why profits fell 20%.", "from": 3}, {"id": 3, "title": "Market size of oat milk", "from": 9}], "current": 3}', earlier))
      .toEqual({ list: [earlier.list[0], { id: 2, title: 'Why coffee profits fell', question: 'Find why profits fell 20%.', from: 3 }, { id: 3, title: 'Market size of oat milk', question: 'Market size of oat milk', from: 9 }], current: 3 });
  });

  it('keeps what there was when the reply is unusable', () => {
    const topics: Topics = { list: [{ id: 1, title: 'Coffee chain', question: 'Why did profits fall?' }], current: 1 };
    expect(parseTopics('I could not tell.', topics)).toBe(topics);
    expect(parseTopics('{"topics": [{"id": "x"}, {"id": 2}], "current": 7}', topics)).toEqual(topics);
    expect(parseTopics('{"topics": [], "current": null}', noTopics)).toEqual(noTopics);
  });
});
