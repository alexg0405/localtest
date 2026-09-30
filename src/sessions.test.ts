import { describe, expect, it } from 'vitest';
import { lastIds, readSession, summarize, type SavedSession } from './sessions';

const minute = 60_000;
const entry = (id: number, question: string, answer = 'An answer.') => ({ id, question, answer, mode: 'STANDARD' as const, kind: 'answer' as const, time: '4:30 PM', tag: '', possible: false });
const session = (): SavedSession => ({
  version: 1, id: 's1', name: 'Stripe mock', createdAt: 0, updatedAt: 10 * minute,
  transcript: [
    { id: 1, text: 'Tell me about yourself', time: '4:30 PM', at: 0, speaker: 'interviewer', by: 'ai', voice: 0 },
    { id: 7, text: 'Sure, I study computer science', time: '4:52 PM', at: 22 * minute, speaker: 'candidate', by: 'ai', voice: 3 },
  ],
  history: [entry(2, 'Tell me about yourself')], current: entry(5, 'Why Stripe?'), pinned: entry(2, 'Tell me about yourself'),
});

describe('saved sessions', () => {
  it('summarizes a session for the list', () => {
    expect(summarize(session())).toEqual({ id: 's1', name: 'Stripe mock', createdAt: 0, updatedAt: 10 * minute, minutes: 22, answers: 2, lines: 2 });
    expect(summarize({ ...session(), transcript: [], current: entry(1, 'Why?', '') }).minutes).toBe(0);
    expect(summarize({ ...session(), current: entry(1, 'Why?', '') }).answers).toBe(1); // An answer still being written does not count.
  });

  it('continues numbering after the largest line, answer, and voice in a reopened session', () => {
    expect(lastIds(session())).toEqual({ line: 7, entry: 5, voice: 3 });
    expect(lastIds({ transcript: [], history: [], current: null, pinned: null })).toEqual({ line: 0, entry: 0, voice: -1 });
  });

  it('reads back only well-formed sessions from this version', () => {
    expect(readSession(session())).toEqual(session());
    // Main questions come back when a session has them, without any that are damaged.
    const topics = { list: [{ id: 1, title: 'Coffee chain profits', question: 'Why did profits fall 20%?', from: 3 }], current: 1 };
    expect(readSession({ ...session(), topics })?.topics).toEqual(topics);
    expect(readSession({ ...session(), topics: { list: [...topics.list, { id: 'x' }], current: 9 } })?.topics).toEqual({ list: topics.list, current: null });
    expect(readSession({ ...session(), version: 2 })).toBeNull();
    expect(readSession({ ...session(), transcript: 'oops' })).toBeNull();
    expect(readSession(null)).toBeNull();
    const damaged = readSession({ ...session(), name: ' ', transcript: [...session().transcript, { text: 'no id' }], history: [null, entry(3, 'Q')], current: { question: 'no id' } });
    expect(damaged).toMatchObject({ name: 'Practice session', current: null });
    expect(damaged!.transcript).toHaveLength(2);
    expect(damaged!.history.map(item => item.id)).toEqual([3]);
  });
});
