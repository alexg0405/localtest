import { describe, expect, it } from 'vitest';
import { conversationMemory, heardCharacters, memoryBudget } from './memory';

const minute = 60_000;
const lines = (count: number, length = 50) => Array.from({ length: count }, (_, index) => ({ text: `${index}`.padEnd(length, '.'), at: index * minute }));

describe('conversationMemory', () => {
  it('keeps the whole conversation while it fits', () => {
    const heard = [{ text: 'Hi, I lead the payments team at Acme.', at: 0 }, { text: 'We are moving our ledger from Postgres to Spanner.', at: 40 * minute }];
    expect(conversationMemory(heard)).toEqual({ text: 'Hi, I lead the payments team at Acme.\nWe are moving our ledger from Postgres to Spanner.', omitted: 0 });
    expect(conversationMemory([])).toEqual({ text: '', omitted: 0 });
  });

  it('keeps the opening and the latest part of a long conversation, and marks what is left out', () => {
    const heard = lines(100); // 5,100 characters
    const { text, omitted } = conversationMemory(heard, 2_000);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text.startsWith('0.')).toBe(true); // The introductions.
    expect(text.endsWith(heard[99].text)).toBe(true); // What was just said.
    expect(omitted).toBeGreaterThan(50);
    expect(text).toContain(`[… ${omitted} lines (about ${omitted - 1} minutes) of the conversation left out here to save space …]`);
    const kept = text.split('\n').filter(line => !line.startsWith('[…'));
    expect(kept.length + omitted).toBe(100);
  });

  it('fits a 45-minute interview without leaving anything out', () => {
    // Nonstop speech at 130 words a minute, in sentence-length lines of average-length words.
    const interview = Array.from({ length: 45 * 10 }, (_, index) => ({ text: 'words '.repeat(13).trim(), at: index * 6_000 }));
    expect(heardCharacters(interview)).toBeLessThan(memoryBudget);
    expect(conversationMemory(interview).omitted).toBe(0);
  });
});
